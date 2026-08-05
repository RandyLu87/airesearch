import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import Decimal from "decimal.js";
import { z } from "zod";
import { STANDARD_METRIC_IDS } from "./metric-dictionary.ts";
import {
  HEALTH_RULE_IDS,
  ratioOrNull,
  triggeredRules,
  type HealthFacts,
} from "./valuation/rules.ts";
import { VALUATION_METHOD_IDS } from "./valuation/methods.ts";
import {
  computeImpliedExpectation,
  computeScenario,
  deriveActionZones,
} from "./valuation/engine.ts";

export * from "./metric-dictionary.ts";
export * from "./periods.ts";
export * from "./valuation/methods.ts";
export * from "./valuation/rules.ts";
export * from "./valuation/engine.ts";

const decimalString = z.string().regex(/^-?\d+(?:\.\d+)?$/);
const metricUnitSchema = z.enum([
  "currency",
  "percent",
  "percentage-point",
  "shares",
  "multiple",
  "count",
]);
const metricScaleSchema = z.enum(["one", "million", "hundred-million"]);

const observationSchema = z.object({
  // A standard metric is one with a repository-wide meaning, so its identity
  // has to come from the shared dictionary rather than from whatever string an
  // author happens to type. `definitionNote` may add company-specific colour
  // (a bank's FCF caveat, a company with no capitalised development spend) but
  // never replaces the dictionary entry.
  metricId: z.enum(STANDARD_METRIC_IDS as [string, ...string[]]),
  label: z.string().min(1),
  definitionNote: z.string().min(1).optional(),
  definitionVersion: z.string().min(1),
  status: z.enum(["reported", "calculated", "unavailable"]),
  value: decimalString.optional(),
  unit: metricUnitSchema,
  currency: z.string().optional(),
  scale: metricScaleSchema,
  period: z.string().min(1),
  periodType: z.enum(["instant", "quarter", "half-year", "fiscal-year"]),
  accountingBasis: z.string().min(1),
  precision: z.number().int().min(0).max(6),
  reason: z.string().min(1).optional(),
  evidenceIds: z.array(z.string()),
}).superRefine((metric, context) => {
  if (metric.status === "unavailable" && (!metric.reason || metric.value !== undefined)) {
    context.addIssue({
      code: "custom",
      message: "unavailable 指标必须省略 value 并填写 reason",
    });
  }
  if (metric.status !== "unavailable" && metric.value === undefined) {
    context.addIssue({ code: "custom", message: "可用指标必须填写 value" });
  }
  if (metric.unit === "currency" && !metric.currency) {
    context.addIssue({ code: "custom", message: "货币指标必须填写 currency" });
  }
});

const driverMetricSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  definition: z.string().min(1),
  definitionVersion: z.string().min(1),
  causalRole: z.string().min(1),
  dimension: z.enum(["增长", "盈利", "现金", "护城河", "治理"]),
  signalType: z.enum(["领先", "同步", "滞后"]),
  status: z.enum(["reported", "calculated", "unavailable"]),
  value: decimalString.optional(),
  displayValue: z.string().min(1),
  unit: metricUnitSchema,
  currency: z.string().optional(),
  scale: metricScaleSchema,
  precision: z.number().int().min(0).max(6),
  period: z.string().min(1),
  periodType: z.enum(["instant", "quarter", "half-year", "fiscal-year"]),
  accountingBasis: z.string().min(1),
  baseline: z.string().min(1),
  trend: z.enum(["改善", "稳定", "恶化", "待验证"]),
  confidence: z.enum(["高", "中", "低"]),
  threshold: z.string().min(1),
  reason: z.string().min(1).optional(),
  evidenceIds: z.array(z.string()).min(1),
}).superRefine((metric, context) => {
  if (metric.status === "unavailable" && !metric.reason) {
    context.addIssue({ code: "custom", message: "unavailable 驱动必须填写 reason" });
  }
  if (metric.status !== "unavailable" && metric.value === undefined) {
    context.addIssue({ code: "custom", message: "可用驱动必须填写 value" });
  }
  if (metric.unit === "currency" && !metric.currency) {
    context.addIssue({ code: "custom", message: "货币驱动必须填写 currency" });
  }
});

const driverChangeSchema = z.object({
  driverId: z.string().min(1),
  change: z.enum(["added", "removed", "redefined"]),
  reason: z.string().min(1),
});

const evidenceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["fact", "calculation", "inference"]),
  title: z.string().min(1),
  publisher: z.string().min(1),
  periodOrEventDate: z.string().min(1),
  publishedAt: z.string().min(1),
  retrievedAt: z.iso.datetime({ offset: true }),
  url: z.url(),
  caveat: z.string().min(1).optional(),
});

const narrativeSectionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  bullets: z.array(z.string().min(1)).min(1),
  evidenceIds: z.array(z.string()).min(1),
});

export const financialValueSchema = z.object({
  value: decimalString,
  unit: metricUnitSchema,
  currency: z.string().optional(),
  scale: metricScaleSchema,
  precision: z.number().int().min(0).max(6),
}).superRefine((metric, context) => {
  if (metric.unit === "currency" && !metric.currency) {
    context.addIssue({ code: "custom", message: "货币财务值必须填写 currency" });
  }
});

/**
 * One reporting segment's numbers for one period.
 *
 * Segment revenue lives here, per period, rather than as a single current-state
 * split on the business model. A business model is a story about how money is
 * made, and the most informative version of that story is how the mix moved:
 * Cloud Music going from 55% social entertainment to 23% over five years *is*
 * the business model change, and a snapshot of today's split cannot show it.
 *
 * Only numbers live here. The segment's name and strategic role live once, on
 * `businessModel.segments`, so the two can never contradict each other.
 */
const periodSegmentSchema = z.object({
  segmentId: z.string().min(1),
  status: z.enum(["reported", "calculated", "unavailable"]),
  revenue: financialValueSchema.optional(),
  grossMargin: financialValueSchema.optional(),
  operatingProfit: financialValueSchema.optional(),
  reason: z.string().min(1).optional(),
  evidenceIds: z.array(z.string()).min(1),
}).superRefine((segment, context) => {
  if (segment.status === "unavailable" && (!segment.reason || segment.revenue)) {
    context.addIssue({
      code: "custom",
      message: "unavailable 分部必须省略 revenue 并填写 reason",
    });
  }
  if (segment.status !== "unavailable" && !segment.revenue) {
    context.addIssue({ code: "custom", message: "可用分部必须填写 revenue" });
  }
});

export const financialPeriodSchema = z.object({
  period: z.string().min(1),
  periodType: z.enum(["quarter", "half-year", "fiscal-year"]),
  accountingBasis: z.string().min(1),
  /**
   * `calculated` marks a period the issuer never reported on its own — a second
   * half derived by subtracting the interim from the full year, say. It is a
   * real number but not a disclosed one, and a reader comparing it to a filing
   * deserves to know which they are looking at.
   */
  status: z.enum(["reported", "calculated"]).default("reported"),
  revenue: financialValueSchema,
  revenueGrowth: financialValueSchema.optional(),
  grossMargin: financialValueSchema.optional(),
  operatingMargin: financialValueSchema.optional(),
  netProfit: financialValueSchema,
  operatingCashFlow: financialValueSchema.optional(),
  freeCashFlow: financialValueSchema.optional(),
  segments: z.array(periodSegmentSchema).optional(),
  evidenceIds: z.array(z.string()).min(1),
}).superRefine((period, context) => {
  for (const key of ["revenue", "netProfit", "operatingCashFlow", "freeCashFlow"] as const) {
    const value = period[key];
    if (value && value.unit !== "currency") {
      context.addIssue({ code: "custom", message: `${key} 必须使用 currency 单位` });
    }
  }
  for (const key of ["revenueGrowth", "grossMargin", "operatingMargin"] as const) {
    const value = period[key];
    if (value && value.unit !== "percent") {
      context.addIssue({ code: "custom", message: `${key} 必须使用 percent 单位` });
    }
  }
});

/**
 * How the company makes money, stated so it can be checked rather than admired.
 *
 * The roster carries no numbers at all. Every percentage a reader sees on the
 * page is computed from `financialHistory[].segments`, so there is exactly one
 * place a revenue split can be wrong.
 */
const businessSegmentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.enum(["经济核心", "增长引擎", "辅助", "收缩中", "孵化"]),
  payer: z.string().min(1),
  chargingMode: z.string().min(1),
  evidenceIds: z.array(z.string()).min(1),
});

const businessModelSchema = z.object({
  segments: z.array(businessSegmentSchema).min(1),
  causalChain: z.string().min(1),
  deliveryDependency: z.string().min(1),
  cashEngine: z.string().min(1),
  evidenceIds: z.array(z.string()).min(1),
});

/**
 * One reading of market position, with its denominator exposed.
 *
 * A share number without a stated denominator is not a fact, it is a mood. The
 * pilot company's "18.3% market share" turned out to mean "share of the revenue
 * of the two listed platforms", excluding the competitor that had just overtaken
 * it on users — a competitor absent from the denominator precisely because it
 * discloses no revenue. `denominatorExcludes` is where that has to be said.
 */
const shareMeasureSchema = z.object({
  basis: z.enum(["商业化", "规模"]),
  label: z.string().min(1),
  marketDefinition: z.string().min(1),
  denominatorIncludes: z.array(z.string().min(1)).min(1),
  denominatorExcludes: z.array(z.object({
    name: z.string().min(1),
    reason: z.string().min(1),
  })),
  status: z.enum(["reported", "calculated", "unavailable"]),
  value: decimalString.optional(),
  displayValue: z.string().min(1),
  unit: metricUnitSchema,
  scale: metricScaleSchema,
  precision: z.number().int().min(0).max(6),
  rank: z.string().min(1).optional(),
  trend: z.enum(["改善", "稳定", "恶化", "待验证"]),
  asOf: z.string().min(1),
  reason: z.string().min(1).optional(),
  evidenceIds: z.array(z.string()).min(1),
}).superRefine((measure, context) => {
  if (measure.status === "unavailable" && (!measure.reason || measure.value !== undefined)) {
    context.addIssue({
      code: "custom",
      message: "unavailable 份额口径必须省略 value 并填写 reason",
    });
  }
  if (measure.status !== "unavailable" && measure.value === undefined) {
    context.addIssue({ code: "custom", message: "可用份额口径必须填写 value" });
  }
});

const marketPositionSchema = z.object({
  measures: z.array(shareMeasureSchema).min(2),
  divergence: z.string().min(1).optional(),
  competitors: z.array(z.object({
    name: z.string().min(1),
    share: z.string().min(1),
    note: z.string().min(1),
    evidenceIds: z.array(z.string()).min(1),
  })).min(1),
  concentrationTrend: z.string().min(1),
  evidenceIds: z.array(z.string()).min(1),
}).superRefine((position, context) => {
  for (const basis of ["商业化", "规模"] as const) {
    if (!position.measures.some((measure) => measure.basis === basis)) {
      context.addIssue({
        code: "custom",
        message:
          `marketPosition.measures 必须同时包含「商业化」与「规模」两个口径；` +
          `缺少「${basis}」。取不到数据时仍要给出该口径并写 status:"unavailable" 与 reason。`,
      });
    }
  }
  // Money holding up while users drain away is the single most valuable thing
  // two denominators can tell you, and it is invisible if each is read alone.
  const trends = new Set(position.measures.map((measure) => measure.trend));
  const diverging = trends.has("恶化") && (trends.has("改善") || trends.has("稳定"));
  if (diverging && !position.divergence) {
    context.addIssue({
      code: "custom",
      message: "两个份额口径给出方向相反的信号时，必须填写 divergence 解释背离含义",
    });
  }
});

const valuationComponentSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["multiple", "face-value"]),
  sign: z.enum(["add", "subtract"]),
  metricLabel: z.string().min(1).optional(),
  metricLow: decimalString.optional(),
  metricHigh: decimalString.optional(),
  multipleLow: decimalString.optional(),
  multipleHigh: decimalString.optional(),
  amount: decimalString.optional(),
  discountPct: decimalString.optional(),
  discountReason: z.string().min(1).optional(),
  note: z.string().min(1),
  evidenceIds: z.array(z.string()).min(1),
}).superRefine((component, context) => {
  if (component.kind === "multiple") {
    for (const key of ["metricLabel", "metricLow", "metricHigh", "multipleLow", "multipleHigh"] as const) {
      if (component[key] === undefined) {
        context.addIssue({ code: "custom", message: `multiple 组件必须填写 ${key}` });
      }
    }
    if (component.amount !== undefined) {
      context.addIssue({ code: "custom", message: "multiple 组件不得填写 amount" });
    }
  } else {
    if (component.amount === undefined) {
      context.addIssue({ code: "custom", message: "face-value 组件必须填写 amount" });
    }
    for (const key of ["metricLow", "metricHigh", "multipleLow", "multipleHigh"] as const) {
      if (component[key] !== undefined) {
        context.addIssue({ code: "custom", message: `face-value 组件不得填写 ${key}` });
      }
    }
  }
  if (component.discountPct !== undefined && !component.discountReason) {
    context.addIssue({ code: "custom", message: "给了折价就必须写 discountReason" });
  }
});

/**
 * Engine output. Present in the file so the published page and its SHA-256 stay
 * self-contained, but never authored: `checkSnapshot` recomputes every field
 * here and rejects the snapshot on any mismatch.
 */
const scenarioComputationSchema = z.object({
  low: decimalString,
  center: decimalString,
  high: decimalString,
  totalLow: decimalString,
  totalHigh: decimalString,
  bridge: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    kind: z.enum(["multiple", "face-value", "discount"]),
    amountLow: decimalString,
    amountHigh: decimalString,
    perShareLow: decimalString,
    perShareHigh: decimalString,
  })).min(1),
});

const valuationScenarioSchema = z.object({
  name: z.enum(["熊市", "基准", "牛市"]),
  assumptions: z.string().min(1),
  trigger: z.string().min(1),
  components: z.array(valuationComponentSchema).min(1),
  computed: scenarioComputationSchema,
});

const actionZoneSchema = z.object({
  label: z.enum(["深度价值区", "基础仓位区", "小仓观察区", "合理价值区", "兑现要求区"]),
  rangeLow: decimalString.nullable(),
  rangeHigh: decimalString.nullable(),
  range: z.string().min(1),
  action: z.string().min(1),
});

const healthCheckResponseSchema = z.object({
  ruleId: z.enum(HEALTH_RULE_IDS as [string, ...string[]]),
  observed: z.string().min(1),
  response: z.enum(["adopted", "blocked", "rejected", "acknowledged"]),
  note: z.string().min(1),
});

const methodSelectionSchema = z.object({
  ideal: z.enum(VALUATION_METHOD_IDS as [string, ...string[]]),
  idealRationale: z.string().min(1),
  adoptedPrimary: z.enum(VALUATION_METHOD_IDS as [string, ...string[]]),
  adoptedRationale: z.string().min(1),
  /**
   * What stands between the ideal method and the adopted one. This is the list
   * the company page renders as "补齐这些数据可以升级估值", so each entry has to
   * name a retrievable thing, not a wish.
   */
  blockedBy: z.array(z.object({
    dataItem: z.string().min(1),
    whyNeeded: z.string().min(1),
    whereToGet: z.string().min(1),
  })),
  crossChecks: z.array(z.object({
    methodId: z.enum(VALUATION_METHOD_IDS as [string, ...string[]]),
    valueLow: decimalString,
    valueHigh: decimalString,
    keyAssumptions: z.string().min(1),
    note: z.string().min(1),
    evidenceIds: z.array(z.string()).min(1),
  })).min(1),
}).superRefine((selection, context) => {
  if (selection.ideal !== selection.adoptedPrimary && selection.blockedBy.length === 0) {
    context.addIssue({
      code: "custom",
      message:
        "理想方法与实际采用的主方法不同时，blockedBy 不能为空——" +
        "要么说明缺哪些数据，要么把 ideal 改成你真正认为最合适的方法。",
    });
  }
  if (selection.ideal === selection.adoptedPrimary && selection.blockedBy.length > 0) {
    context.addIssue({
      code: "custom",
      message: "已经用上理想方法时不应再列 blockedBy",
    });
  }
});

/**
 * Split a causal chain into its links.
 *
 * `business-model-playbook.md` section 2 mandates the chain shape — 关键投入 →
 * 获客 → 销量 → 定价 → 单位贡献 → 现金回收 → 再投资 — so the arrow is structure
 * rather than an author's punctuation habit, and the renderer can lay the chain
 * out as a stepped flow without a dedicated schema field.
 *
 * It lives here, beside the contract, because the checker warns about chains
 * that will not render as a flow and the renderer decides whether they do. Two
 * copies of this split could disagree about what counts as a link.
 */
export function splitCausalChain(chain: string): string[] {
  return chain
    .split("→")
    .map((link) => link.trim().replace(/[。；;]+$/, "").trim())
    .filter((link) => link.length > 0);
}

export const SCHEMA_VERSION = "1.1.0";

/**
 * The contract before structured business model, market position and a computed
 * valuation existed.
 *
 * Kept parseable rather than migrated. ADR-0002 makes a dated research report an
 * immutable record, and back-filling the new blocks would mean inventing an
 * exchange rate and a market-share denominator for a judgment made months ago —
 * writing today's numbers into yesterday's conclusion. Legacy snapshots stay
 * exactly as published; every snapshot authored from now on is 1.1.0.
 */
const legacyValuationSchema = z.object({
  scenarios: z.array(z.object({
    name: z.enum(["熊市", "基准", "牛市"]),
    assumptions: z.string().min(1),
    earnings: z.string().min(1),
    method: z.string().min(1),
    valueRange: z.string().min(1),
    trigger: z.string().min(1),
  })).length(3),
  actionZones: z.array(z.object({
    label: z.string().min(1),
    range: z.string().min(1),
    action: z.string().min(1),
  })).min(3),
  currentExpectation: z.string().min(1),
  evidenceIds: z.array(z.string()).min(1),
});

const snapshotShape = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  company: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    legalName: z.string().min(1),
    ticker: z.string().min(1),
    market: z.string().min(1),
    reportingCurrency: z.string().min(1),
    accountingStandard: z.string().min(1),
    /** Drives the industry-specific valuation health rules. */
    industryTags: z.array(z.string().min(1)).min(1),
  }),
  snapshot: z.object({
    id: z.string().min(1),
    createdAt: z.iso.datetime({ offset: true }),
    dataCutoff: z.iso.datetime({ offset: true }),
    sourceNote: z.string().min(1).optional(),
  }),
  investmentHorizon: z.string().min(1),
  summary: z.object({
    stance: z.string().min(1),
    confidence: z.enum(["高", "中", "低"]),
    headline: z.string().min(1),
    businessModel: z.string().min(1),
    businessModelChange: z.enum(["未变", "参数变化", "机制变化", "结构性变化"]),
    referencePrice: z.object({
      value: decimalString,
      currency: z.string().min(1),
      asOf: z.iso.datetime({ offset: true }),
    }),
    fairValue: z.object({
      low: decimalString,
      high: decimalString,
      center: decimalString,
      currency: z.string().min(1),
    }),
    marginOfSafety: z.string().min(1),
    strongestEvidence: z.string().min(1),
    largestRisk: z.string().min(1),
    nextValidation: z.string().min(1),
  }),
  businessModel: businessModelSchema,
  marketPosition: marketPositionSchema,
  standardMetrics: z.array(observationSchema),
  driverMetrics: z.array(driverMetricSchema).min(4),
  constraints: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    status: z.enum(["改善", "稳定", "恶化", "待验证"]),
    explanation: z.string().min(1),
    evidenceIds: z.array(z.string()).min(1),
  })).min(1).max(3),
  thesisChange: z.object({
    investmentLogic: z.string().min(1),
    financialQuality: z.string().min(1),
    governance: z.string().min(1),
    valuation: z.string().min(1),
    newEvidence: z.array(z.string().min(1)).min(1),
    supersededAssumptions: z.array(z.string().min(1)),
    driverChanges: z.array(driverChangeSchema).optional(),
  }),
  financialHistory: z.array(financialPeriodSchema).min(2),
  sections: z.array(narrativeSectionSchema).min(3),
  valuation: z.object({
    /**
     * Every component amount and the share count are read at this scale in this
     * currency. Forcing one declared scale for both is what stops the classic
     * hundred-million-versus-million slip that moves a valuation by 100x.
     */
    currency: z.string().min(1),
    valueScale: metricScaleSchema,
    tradingCurrency: z.string().min(1),
    shares: z.object({
      value: decimalString,
      scale: metricScaleSchema,
      evidenceIds: z.array(z.string()).min(1),
    }),
    /**
     * Reporting currency per one unit of trading currency. Required, evidenced
     * and cross-sourced, because an unrecorded FX assumption is invisible and
     * propagates straight into the fair value: the pilot snapshot's own
     * `currentExpectation` implied a rate 6% away from the market.
     */
    fx: z.object({
      pair: z.string().min(1),
      value: decimalString,
      asOf: z.iso.datetime({ offset: true }),
      evidenceIds: z.array(z.string()).min(2),
    }),
    healthCheck: z.array(healthCheckResponseSchema),
    methodSelection: methodSelectionSchema,
    scenarios: z.array(valuationScenarioSchema).length(3),
    actionZones: z.array(actionZoneSchema).min(3),
    impliedExpectation: z.object({
      marketCap: decimalString,
      operatingValue: decimalString,
      nonOperatingPerShare: decimalString,
      multipleLow: decimalString.nullable(),
      multipleHigh: decimalString.nullable(),
      metricLabel: z.string().min(1).nullable(),
    }),
    currentExpectation: z.string().min(1),
    evidenceIds: z.array(z.string()).min(1),
  }),
  risks: z.array(z.string().min(1)).min(3),
  viewChanges: z.object({
    upgrade: z.array(z.string().min(1)).min(1),
    downgrade: z.array(z.string().min(1)).min(1),
  }),
  checkpoints: z.array(z.string().min(1)).min(3),
  evidence: z.array(evidenceSchema).min(2),
  disclaimer: z.string().min(1),
});

const legacySnapshotShape = snapshotShape
  .omit({ schemaVersion: true, company: true, businessModel: true, marketPosition: true, valuation: true })
  .extend({
    schemaVersion: z.literal("1.0.0"),
    company: snapshotShape.shape.company.omit({ industryTags: true }),
    valuation: legacyValuationSchema,
  });

type SnapshotShape = z.infer<typeof snapshotShape>;
type LegacySnapshotShape = z.infer<typeof legacySnapshotShape>;
type AnySnapshotShape = SnapshotShape | LegacySnapshotShape;

export function isCurrentSnapshot(snapshot: AnySnapshotShape): snapshot is SnapshotShape {
  return snapshot.schemaVersion === SCHEMA_VERSION;
}

export const researchSnapshotSchema = z
  .discriminatedUnion("schemaVersion", [snapshotShape, legacySnapshotShape])
  .superRefine((snapshot, context) => {
  const evidenceIds = new Set<string>();
  for (const evidence of snapshot.evidence) {
    if (evidenceIds.has(evidence.id)) {
      context.addIssue({ code: "custom", message: `重复 evidence id：${evidence.id}` });
    }
    evidenceIds.add(evidence.id);
  }
  const references = [
    ...snapshot.standardMetrics.flatMap((metric) => metric.evidenceIds),
    ...snapshot.driverMetrics.flatMap((metric) => metric.evidenceIds),
    ...snapshot.constraints.flatMap((constraint) => constraint.evidenceIds),
    ...snapshot.financialHistory.flatMap((period) => [
      ...period.evidenceIds,
      ...(period.segments ?? []).flatMap((segment) => segment.evidenceIds),
    ]),
    ...snapshot.sections.flatMap((section) => section.evidenceIds),
    ...snapshot.valuation.evidenceIds,
    ...(isCurrentSnapshot(snapshot)
      ? [
          ...snapshot.businessModel.evidenceIds,
          ...snapshot.businessModel.segments.flatMap((segment) => segment.evidenceIds),
          ...snapshot.marketPosition.evidenceIds,
          ...snapshot.marketPosition.measures.flatMap((measure) => measure.evidenceIds),
          ...snapshot.marketPosition.competitors.flatMap((competitor) => competitor.evidenceIds),
          ...snapshot.valuation.shares.evidenceIds,
          ...snapshot.valuation.fx.evidenceIds,
          ...snapshot.valuation.methodSelection.crossChecks.flatMap((check) => check.evidenceIds),
          ...snapshot.valuation.scenarios.flatMap((scenario) =>
            scenario.components.flatMap((component) => component.evidenceIds),
          ),
        ]
      : []),
  ];
  for (const evidenceId of references) {
    if (!evidenceIds.has(evidenceId)) {
      context.addIssue({ code: "custom", message: `引用了不存在的 evidence id：${evidenceId}` });
    }
  }
  const low = new Decimal(snapshot.summary.fairValue.low);
  const center = new Decimal(snapshot.summary.fairValue.center);
  const high = new Decimal(snapshot.summary.fairValue.high);
  if (low.greaterThan(center) || center.greaterThan(high)) {
    context.addIssue({ code: "custom", message: "合理价值必须满足 low <= center <= high" });
  }

  if (!isCurrentSnapshot(snapshot)) return;

  // Every segment number must belong to a segment the business model declares,
  // so a stray id cannot produce a revenue row with no name attached.
  const segmentIds = new Set(snapshot.businessModel.segments.map((segment) => segment.id));
  for (const period of snapshot.financialHistory) {
    for (const segment of period.segments ?? []) {
      if (!segmentIds.has(segment.segmentId)) {
        context.addIssue({
          code: "custom",
          message: `financialHistory ${period.period} 引用了 businessModel 未声明的分部：${segment.segmentId}`,
        });
      }
    }
  }

  // A multi-segment company that shows no split for its most recent period has
  // left the single most informative part of the business model blank.
  if (snapshot.businessModel.segments.length >= 2) {
    const latest = snapshot.financialHistory.at(-1);
    if (latest && (latest.segments ?? []).length === 0) {
      context.addIssue({
        code: "custom",
        message:
          `businessModel 声明了 ${snapshot.businessModel.segments.length} 个分部，` +
          `但最新期间 ${latest.period} 没有 segments。取不到就逐个写 status:"unavailable" 与 reason。`,
      });
    }
  }

  verifyValuation(snapshot, context);
});

/**
 * Recompute everything the engine owns and reject the snapshot if the stored
 * answer disagrees.
 *
 * A JSON file has no read-only fields, so this is what "the author cannot write
 * the value range" actually means in practice. It runs inside the schema rather
 * than only in the CLI so that publishing a snapshot cannot bypass it either.
 */
function verifyValuation(snapshot: SnapshotShape, context: z.RefinementCtx): void {
  const { valuation, summary } = snapshot;

  if (valuation.shares.scale !== valuation.valueScale) {
    context.addIssue({
      code: "custom",
      message:
        `valuation.shares.scale（${valuation.shares.scale}）必须与 valueScale（${valuation.valueScale}）一致，` +
        `否则每股价值会差一个数量级。`,
    });
    return;
  }
  if (valuation.currency !== snapshot.company.reportingCurrency) {
    context.addIssue({
      code: "custom",
      message: "valuation.currency 必须等于 company.reportingCurrency",
    });
  }
  if (valuation.tradingCurrency !== summary.referencePrice.currency) {
    context.addIssue({
      code: "custom",
      message: "valuation.tradingCurrency 必须等于参考价格币种",
    });
  }

  const basis = { fx: valuation.fx.value, shares: valuation.shares.value };
  const byName = new Map(valuation.scenarios.map((scenario) => [scenario.name, scenario]));

  for (const scenario of valuation.scenarios) {
    let expected;
    try {
      expected = computeScenario(scenario.components, basis);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: `估值情景「${scenario.name}」无法计算：${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    for (const key of ["low", "center", "high", "totalLow", "totalHigh"] as const) {
      if (scenario.computed[key] !== expected[key]) {
        context.addIssue({
          code: "custom",
          message:
            `估值情景「${scenario.name}」的 computed.${key} 与组件算出的结果不符：` +
            `写的是 ${scenario.computed[key]}，按组件应为 ${expected[key]}。` +
            `运行 npm run snapshot:sync 重算，不要手改这个字段。`,
        });
      }
    }
    if (JSON.stringify(scenario.computed.bridge) !== JSON.stringify(expected.bridge)) {
      context.addIssue({
        code: "custom",
        message: `估值情景「${scenario.name}」的 computed.bridge 与组件不符；运行 npm run snapshot:sync 重算。`,
      });
    }
    if (new Decimal(scenario.computed.low).greaterThan(scenario.computed.high)) {
      context.addIssue({
        code: "custom",
        message: `估值情景「${scenario.name}」的下沿高于上沿，检查组件的加减方向。`,
      });
    }
  }

  const bear = byName.get("熊市");
  const base = byName.get("基准");
  const bull = byName.get("牛市");

  if (base) {
    if (summary.fairValue.low !== base.computed.low ||
        summary.fairValue.high !== base.computed.high ||
        summary.fairValue.center !== base.computed.center) {
      context.addIssue({
        code: "custom",
        message:
          `summary.fairValue 必须等于基准情景的计算结果 ` +
          `${base.computed.low}/${base.computed.center}/${base.computed.high}，` +
          `当前为 ${summary.fairValue.low}/${summary.fairValue.center}/${summary.fairValue.high}。`,
      });
    }
    let implied;
    try {
      implied = computeImpliedExpectation(base.components, basis, summary.referencePrice.value);
      for (const key of ["marketCap", "operatingValue", "nonOperatingPerShare", "multipleLow", "multipleHigh", "metricLabel"] as const) {
        if (valuation.impliedExpectation[key] !== implied[key]) {
          context.addIssue({
            code: "custom",
            message:
              `impliedExpectation.${key} 与基准情景算出的结果不符：写的是 ` +
              `${String(valuation.impliedExpectation[key])}，应为 ${String(implied[key])}。`,
          });
        }
      }
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: `无法计算隐含预期：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  if (bear && base) {
    const expectedZones = deriveActionZones(
      bear.computed,
      base.computed,
      valuation.actionZones,
      valuation.tradingCurrency === "HKD" ? "HK$" : `${valuation.tradingCurrency} `,
    );
    const actual = valuation.actionZones;
    if (actual.length !== expectedZones.length) {
      context.addIssue({
        code: "custom",
        message: `actionZones 应有 ${expectedZones.length} 个区间（由熊市与基准区间推导），实际 ${actual.length} 个。`,
      });
    } else {
      for (const [index, zone] of expectedZones.entries()) {
        const written = actual[index];
        for (const key of ["label", "rangeLow", "rangeHigh", "range"] as const) {
          if (written[key] !== zone[key]) {
            context.addIssue({
              code: "custom",
              message:
                `actionZones[${index}].${key} 由引擎推导，应为 ${String(zone[key])}，` +
                `实际 ${String(written[key])}。只有 action 文案可以手写。`,
            });
          }
        }
      }
    }
  }

  if (bear && base && bull) {
    if (new Decimal(bear.computed.center).greaterThan(base.computed.center) ||
        new Decimal(base.computed.center).greaterThan(bull.computed.center)) {
      context.addIssue({
        code: "custom",
        message: "熊市、基准、牛市三个情景的中枢必须单调递增，否则情景假设自相矛盾。",
      });
    }
  }

  // The health check is only worth running if the author has to answer it.
  const facts = deriveHealthFacts(snapshot);
  const answered = new Set(valuation.healthCheck.map((entry) => entry.ruleId));
  for (const { rule, observed } of triggeredRules(facts)) {
    if (!answered.has(rule.id)) {
      context.addIssue({
        code: "custom",
        message:
          `估值体检规则「${rule.label}」被触发（${observed}），但 valuation.healthCheck 没有回应。` +
          `补一条 {"ruleId":"${rule.id}","observed":"${observed}","response":"...","note":"..."}。`,
      });
      continue;
    }
    const response = valuation.healthCheck.find((entry) => entry.ruleId === rule.id);
    if (
      response &&
      response.response === "adopted" &&
      rule.discourages.some((methodId) => methodId === valuation.methodSelection.adoptedPrimary)
    ) {
      context.addIssue({
        code: "custom",
        message:
          `体检规则「${rule.label}」不建议把 ${valuation.methodSelection.adoptedPrimary} 作为主方法，` +
          `而 healthCheck 标记为 adopted。若确实沿用该方法，response 应为 blocked 或 rejected 并说明理由。`,
      });
    }
  }
  for (const entry of valuation.healthCheck) {
    if (!triggeredRules(facts).some(({ rule }) => rule.id === entry.ruleId)) {
      context.addIssue({
        code: "custom",
        message: `valuation.healthCheck 回应了未触发的规则 ${entry.ruleId}；删除它或核对触发条件。`,
      });
    }
  }
}

const SCALE_FACTOR = {
  one: 1,
  million: 1_000_000,
  "hundred-million": 100_000_000,
} as const;

function atScale(
  value: { value: string; scale: keyof typeof SCALE_FACTOR },
  target: keyof typeof SCALE_FACTOR,
): Decimal {
  return new Decimal(value.value)
    .times(SCALE_FACTOR[value.scale])
    .dividedBy(SCALE_FACTOR[target]);
}

function metricDecimal(
  snapshot: SnapshotShape,
  metricId: string,
  target: keyof typeof SCALE_FACTOR,
): Decimal | null {
  const metric = snapshot.standardMetrics.find((item) => item.metricId === metricId);
  if (!metric || metric.status === "unavailable" || metric.value === undefined) return null;
  return atScale({ value: metric.value, scale: metric.scale }, target);
}

/**
 * Turn a snapshot into the flat facts the valuation health rules reason over.
 *
 * Anything that cannot be derived stays `null`, and the rules treat `null` as
 * "cannot judge". A rule must never read a missing number as evidence that the
 * risk it guards against is absent.
 */
export function deriveHealthFacts(snapshot: SnapshotShape): HealthFacts {
  const scale = snapshot.valuation.valueScale;
  const marketCap = new Decimal(snapshot.summary.referencePrice.value)
    .times(snapshot.valuation.shares.value)
    .times(snapshot.valuation.fx.value);

  const netCash = metricDecimal(snapshot, "net-cash", scale);
  const annual = snapshot.financialHistory.filter((period) => period.periodType === "fiscal-year");

  let consecutiveProfitableYears = 0;
  for (let index = annual.length - 1; index >= 0; index -= 1) {
    if (new Decimal(annual[index].netProfit.value).greaterThan(0)) {
      consecutiveProfitableYears += 1;
      continue;
    }
    break;
  }

  const latest = snapshot.financialHistory.at(-1);
  const latestFcf = latest?.freeCashFlow;

  // Segment direction is only meaningful between two periods of the same type.
  const sameType = latest
    ? snapshot.financialHistory.filter((period) => period.periodType === latest.periodType)
    : [];
  const previous = sameType.at(-2);
  const segmentGrowthSigns: number[] = [];
  for (const segment of latest?.segments ?? []) {
    const before = previous?.segments?.find((item) => item.segmentId === segment.segmentId);
    if (!segment.revenue || !before?.revenue) continue;
    segmentGrowthSigns.push(
      new Decimal(segment.revenue.value).comparedTo(new Decimal(before.revenue.value)),
    );
  }

  const latestRevenue = latest ? new Decimal(latest.revenue.value) : null;
  const segmentShares = (latest?.segments ?? [])
    .map((segment) => segment.revenue)
    .filter((revenue): revenue is NonNullable<typeof revenue> => revenue !== undefined)
    .map((revenue) => new Decimal(revenue.value));

  return {
    netCashToMarketCap: ratioOrNull(netCash, marketCap),
    netDebtToEbitda: null,
    consecutiveProfitableYears,
    latestNetProfitPositive: latest ? new Decimal(latest.netProfit.value).greaterThan(0) : null,
    latestFreeCashFlowPositive: latestFcf ? new Decimal(latestFcf.value).greaterThan(0) : null,
    segmentGrowthSigns,
    topSegmentShare:
      segmentShares.length > 0 && latestRevenue
        ? ratioOrNull(Decimal.max(...segmentShares), latestRevenue)
        : null,
    shareholderReturnCoverage: (() => {
      const metric = snapshot.standardMetrics.find(
        (item) => item.metricId === "shareholder-return-coverage",
      );
      if (!metric || metric.status === "unavailable" || metric.value === undefined) return null;
      return new Decimal(metric.value).dividedBy(100).toNumber();
    })(),
    customerConcentration: (() => {
      const metric = snapshot.standardMetrics.find(
        (item) => item.metricId === "customer-concentration",
      );
      if (!metric || metric.status === "unavailable" || metric.value === undefined) return null;
      return new Decimal(metric.value).dividedBy(100).toNumber();
    })(),
    industryTags: snapshot.company.industryTags,
  };
}

export type ResearchSnapshot = z.infer<typeof researchSnapshotSchema>;
export type MetricObservation = z.infer<typeof observationSchema>;
export type DriverMetric = z.infer<typeof driverMetricSchema>;
export type EvidenceReference = z.infer<typeof evidenceSchema>;
export type DriverChange = z.infer<typeof driverChangeSchema>;

/**
 * The fields that must agree before two observations of the same metric may be
 * compared. Shared with the snapshot checker so authoring-time enforcement and
 * publication-time comparison can never disagree about what "compatible" means.
 */
export const OBSERVATION_COMPATIBILITY_KEYS = [
  "metricId",
  "definitionVersion",
  "unit",
  "currency",
  "scale",
  "periodType",
  "accountingBasis",
] as const satisfies ReadonlyArray<keyof MetricObservation>;

/**
 * The business-model change grades that admit a driver recalibration. Shared so
 * the checker cannot drift from the enum above.
 */
export const RECALIBRATION_GRADES = ["机制变化", "结构性变化"] as const;

export const DRIVER_COMPATIBILITY_KEYS = [
  "definition",
  "definitionVersion",
  "unit",
  "currency",
  "scale",
  "periodType",
  "accountingBasis",
] as const satisfies ReadonlyArray<keyof DriverMetric>;

export function snapshotPath(repoRoot: string, companyId: string, stem: string) {
  return path.join(
    repoRoot,
    "research",
    "companies",
    companyId,
    "snapshots",
    `${stem}.json`,
  );
}

export function loadResearchSnapshot(
  repoRoot: string,
  companyId: string,
  stem: string,
) {
  const filePath = snapshotPath(repoRoot, companyId, stem);
  const source = readFileSync(filePath);

  return {
    data: researchSnapshotSchema.parse(JSON.parse(source.toString("utf8"))),
    filePath,
    sha256: createHash("sha256").update(source).digest("hex"),
  };
}

export function listResearchSnapshots(repoRoot: string, companyId: string) {
  const directory = path.join(
    repoRoot,
    "research",
    "companies",
    companyId,
    "snapshots",
  );

  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -5))
    .map((stem) => loadResearchSnapshot(repoRoot, companyId, stem))
    .sort((left, right) =>
      left.data.snapshot.createdAt.localeCompare(right.data.snapshot.createdAt),
    );
}

export function listResearchCompanyIds(repoRoot: string) {
  const companiesDirectory = path.join(repoRoot, "research", "companies");
  return readdirSync(companiesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((companyId) => {
      const snapshotsDirectory = path.join(
        companiesDirectory,
        companyId,
        "snapshots",
      );
      try {
        return readdirSync(snapshotsDirectory).some((name) => name.endsWith(".json"));
      } catch {
        return false;
      }
    })
    .sort();
}

function observationCompatibility(
  prior: MetricObservation,
  current: MetricObservation,
) {
  const mismatch = OBSERVATION_COMPATIBILITY_KEYS.find((key) => prior[key] !== current[key]);
  return mismatch ? `口径不兼容：${mismatch}` : null;
}

export function compareResearchSnapshots(
  prior: ResearchSnapshot,
  current: ResearchSnapshot,
) {
  const priorMetrics = new Map(
    prior.standardMetrics.map((metric) => [metric.metricId, metric]),
  );
  const currentMetrics = new Map(
    current.standardMetrics.map((metric) => [metric.metricId, metric]),
  );
  const metricIds = [...new Set([...priorMetrics.keys(), ...currentMetrics.keys()])];

  const metrics = metricIds.map((metricId) => {
    const previous = priorMetrics.get(metricId);
    const latest = currentMetrics.get(metricId);
    if (!previous || !latest) {
      return {
        metricId,
        label: latest?.label ?? previous?.label ?? metricId,
        status: "not-comparable" as const,
        reason: "其中一个研究快照没有该指标",
        prior: previous,
        current: latest,
      };
    }
    if (
      previous.status === "unavailable" ||
      latest.status === "unavailable" ||
      previous.value === undefined ||
      latest.value === undefined
    ) {
      return {
        metricId,
        label: latest.label,
        status: "not-comparable" as const,
        reason: previous.reason ?? latest.reason ?? "其中一个观测值不可用",
        prior: previous,
        current: latest,
      };
    }
    const incompatibility = observationCompatibility(previous, latest);
    if (incompatibility) {
      return {
        metricId,
        label: latest.label,
        status: "not-comparable" as const,
        reason: incompatibility,
        prior: previous,
        current: latest,
      };
    }

    return {
      metricId,
      label: latest.label,
      status: "comparable" as const,
      delta: new Decimal(latest.value).minus(previous.value).toFixed(
        Math.max(previous.precision, latest.precision),
      ),
      prior: previous,
      current: latest,
    };
  });

  const priorDrivers = new Map(
    prior.driverMetrics.map((metric) => [metric.id, metric]),
  );
  const currentDrivers = new Map(
    current.driverMetrics.map((metric) => [metric.id, metric]),
  );
  const driverIds = [
    ...new Set([...priorDrivers.keys(), ...currentDrivers.keys()]),
  ];
  const driverMetrics = driverIds.map((driverId) => {
    const previous = priorDrivers.get(driverId);
    const latest = currentDrivers.get(driverId);
    const mismatch = previous && latest
      ? DRIVER_COMPATIBILITY_KEYS.find((key) => previous[key] !== latest[key])
      : undefined;
    const unavailable = previous && latest
      ? previous.status === "unavailable" ||
        latest.status === "unavailable" ||
        previous.value === undefined ||
        latest.value === undefined
      : false;
    const compatible = previous !== undefined && latest !== undefined && !mismatch && !unavailable;
    return {
      driverId,
      label: latest?.label ?? previous?.label ?? driverId,
      definition: latest?.definition ?? previous?.definition ?? "",
      threshold: latest?.threshold ?? previous?.threshold ?? "",
      status: compatible ? ("comparable" as const) : ("not-comparable" as const),
      reason: compatible
        ? undefined
        : unavailable
          ? previous?.reason ?? latest?.reason ?? "其中一个驱动观测值不可用"
          : mismatch
            ? `口径不兼容：${mismatch}`
            : "其中一个快照缺少该驱动",
      prior: previous,
      current: latest,
    };
  });

  const priorEvidenceIds = new Set(prior.evidence.map((item) => item.id));
  const addedEvidence = current.evidence.filter(
    (item) => !priorEvidenceIds.has(item.id),
  );

  return {
    prior: {
      date: prior.snapshot.dataCutoff.slice(0, 10),
      stance: prior.summary.stance,
      confidence: prior.summary.confidence,
      businessModel: prior.summary.businessModel,
      businessModelChange: prior.summary.businessModelChange,
      constraints: prior.constraints,
      referencePrice: prior.summary.referencePrice,
      fairValue: prior.summary.fairValue,
    },
    current: {
      date: current.snapshot.dataCutoff.slice(0, 10),
      stance: current.summary.stance,
      confidence: current.summary.confidence,
      businessModel: current.summary.businessModel,
      businessModelChange: current.summary.businessModelChange,
      constraints: current.constraints,
      referencePrice: current.summary.referencePrice,
      fairValue: current.summary.fairValue,
    },
    metrics,
    driverMetrics,
    evidence: {
      added: addedEvidence,
      supersededAssumptions: current.thesisChange.supersededAssumptions,
    },
  };
}
