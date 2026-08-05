import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import Decimal from "decimal.js";
import { z } from "zod";
import { STANDARD_METRIC_IDS } from "./metric-dictionary.ts";
import { MONTH_PERIOD_PATTERN } from "./periods.ts";
import {
  DENSITY_RULE_IDS,
  computeEvidenceDensity,
  densityFactsFrom,
  triggeredDensityRules,
} from "./density.ts";
import {
  HEALTH_RULE_IDS,
  ratioOrNull,
  triggeredRules,
  type HealthFacts,
} from "./valuation/rules.ts";
import { VALUATION_METHOD_IDS } from "./valuation/methods.ts";
import {
  computeImpliedExpectation,
  computeMarketCap,
  computeScenario,
  deriveActionZones,
} from "./valuation/engine.ts";

export * from "./metric-dictionary.ts";
export * from "./periods.ts";
export * from "./density.ts";
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
  /**
   * `month` is a driver-only cadence. The most useful leading indicators are
   * often monthly — sales volume, output, premiums, monthly revenue — and
   * flattening them into a quarter throws away the turn that made them worth
   * watching. They stay out of `financialHistory` because monthly operating
   * disclosures are unaudited and usually outside the accounting standard.
   */
  periodType: z.enum(["instant", "month", "quarter", "half-year", "fiscal-year"]),
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
  if (metric.periodType === "month" && !MONTH_PERIOD_PATTERN.test(metric.period)) {
    context.addIssue({
      code: "custom",
      path: ["period"],
      message:
        `月度驱动的 period 必须写成零填充的 YYYY-MM（如 2026-01）。` +
        `写成「2026 M1」这类形式会让字典序静默错排——M1 < M10 < M2。`,
    });
  }
});

const driverChangeSchema = z.object({
  driverId: z.string().min(1),
  change: z.enum(["added", "removed", "redefined"]),
  reason: z.string().min(1),
});

/**
 * The same mechanism as `driverChangeSchema`, applied to attributed assumption
 * seats. Seats are extensible with no floor, so drift is the expected failure:
 * without a recorded reason, a source that went unchecked this run reads exactly
 * like one that stopped publishing.
 */
const assumptionSetChangeSchema = z.object({
  assumptionSetId: z.string().min(1),
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
  /**
   * No `month` here, deliberately. Monthly operating disclosures are unaudited
   * and usually outside the accounting standard, so letting one into the ledger
   * would put a number that cannot be reconciled to a filing into the same
   * series the valuation reads. Monthly cadence belongs to `driverMetrics`.
   */
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

/**
 * One moat that actually holds, bound to the metric that shows it holding.
 *
 * A declaration, not a checklist. Walking five moat types and writing a line
 * under each produces four moats that do not exist and one that does, with
 * nothing to tell a reader which is which — the same failure mode
 * `business-model-playbook.md` guards against when it forbids scoring a company
 * by weighted total.
 *
 * `driverIds` is the whole point. A moat pinned to a driver inherits everything
 * that driver already carries: a definition, a calibration, a threshold,
 * evidence, and continuity across snapshots. A moat with no driver behind it is
 * a compliment, and the honest reading of one that cannot find a driver is that
 * it may not be there.
 */
const moatSchema = z.object({
  id: z.string().min(1),
  type: z.enum([
    "品牌定价权",
    "转换成本",
    "网络效应",
    "规模成本",
    "技术与牌照",
    "其他",
  ]),
  typeNote: z.string().min(1).optional(),
  /** Where in `causalChain` it acts — a position, not an adjective. */
  mechanism: z.string().min(1),
  driverIds: z.array(z.string().min(1)).min(1),
  /**
   * Width, not quality. A moat moving from 待验证 to 稳定 is not an
   * "improvement" in the sense `constraints.status` means, so this enum stays
   * separate rather than reusing 改善/恶化.
   */
  trend: z.enum(["变宽", "稳定", "变窄", "待验证"]),
  /** What would destroy it, with the observable signal that precedes that. */
  breaker: z.string().min(1),
  evidenceIds: z.array(z.string()).min(1),
}).superRefine((moat, context) => {
  if (moat.type === "其他" && !moat.typeNote) {
    context.addIssue({
      code: "custom",
      path: ["typeNote"],
      message: "护城河类型取「其他」时必须填写 typeNote 说明它究竟是什么",
    });
  }
});

const businessModelSchema = z.object({
  segments: z.array(businessSegmentSchema).min(1),
  causalChain: z.string().min(1),
  deliveryDependency: z.string().min(1),
  cashEngine: z.string().min(1),
  /**
   * Optional in the contract, mandatory in practice: `snapshot:new` writes it
   * as sentinels, so the authoring path demands it while snapshots published
   * before ADR-0018 stay valid without being back-filled.
   */
  moat: z.array(moatSchema).min(1).max(3).optional(),
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

const impliedExpectationSchema = z.object({
  marketCap: decimalString,
  operatingValue: decimalString,
  nonOperatingPerShare: decimalString,
  multipleLow: decimalString.nullable(),
  multipleHigh: decimalString.nullable(),
  metricLabel: z.string().min(1).nullable(),
});

/**
 * Where an assumption set's numbers came from. Every entry names someone other
 * than this repository, which is the whole mechanism: 熊市/基准/牛市 asked the
 * author which future was most likely, and "基准" was a private forecast wearing
 * the word "base".
 */
export const ASSUMPTION_SOURCE_KINDS = [
  "发行人指引",
  "卖方一致预期",
  "历史区间回归",
  "做空报告",
  "监管与政策文件",
  "同业公开指引",
  "其他",
] as const;

/**
 * One attributed set of assumptions, and what today's price does to it.
 *
 * Seats are extensible and have no floor: a company with a short report, a
 * consensus feed and issuer guidance can carry five sets, and one that discloses
 * nothing but its own filings carries the historical range alone. What every
 * seat owes instead is `sourceBias` — a short-seller's model and an issuer's
 * guidance are both citable and neither is neutral, and a page that renders them
 * identically is borrowing someone else's mouth to express a view.
 *
 * A seat may be declared and empty. `status: "unavailable"` with a reason is how
 * "this company gives no guidance" stays distinguishable from "nobody looked".
 */
const assumptionSetSchema = z.object({
  id: z.string().min(1),
  sourceKind: z.enum(ASSUMPTION_SOURCE_KINDS),
  /** Who specifically — "公司 FY26 中期业绩会", "FMP consensus 2026-08-04". */
  sourceLabel: z.string().min(1),
  /**
   * The source's known lean, stated rather than left to the reader. Required on
   * every seat with no exception: a bias field that only appeared on sources
   * someone judged biased would itself be a judgment.
   */
  sourceBias: z.string().min(1),
  sourceNote: z.string().min(1).optional(),
  status: z.enum(["available", "unavailable"]),
  reason: z.string().min(1).optional(),
  assumptions: z.string().min(1).optional(),
  components: z.array(valuationComponentSchema).min(1).optional(),
  /** Engine output, recomputed by the checker. */
  computed: scenarioComputationSchema.optional(),
  /** Engine output, recomputed by the checker: this set solved backwards. */
  impliedExpectation: impliedExpectationSchema.optional(),
  evidenceIds: z.array(z.string()),
}).superRefine((set, context) => {
  if (set.sourceKind === "其他" && !set.sourceNote) {
    context.addIssue({
      code: "custom",
      path: ["sourceNote"],
      message: "sourceKind 取「其他」时必须填写 sourceNote 说明这一组假设究竟出自哪里",
    });
  }
  if (set.status === "unavailable") {
    if (!set.reason) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message:
          "unavailable 的假设集必须写 reason（例如「公司明确不提供全年指引」" +
          "或「港股无已登记的一致预期源」）——「没有这一组」与「没有查」必须能区分。",
      });
    }
    for (const key of ["assumptions", "components", "computed", "impliedExpectation"] as const) {
      if (set[key] !== undefined) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: `unavailable 的假设集不得填写 ${key}`,
        });
      }
    }
    return;
  }
  for (const key of ["assumptions", "components", "computed", "impliedExpectation"] as const) {
    if (set[key] === undefined) {
      context.addIssue({
        code: "custom",
        path: [key],
        message: `available 的假设集必须填写 ${key}`,
      });
    }
  }
  if (set.evidenceIds.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["evidenceIds"],
      message: "available 的假设集必须至少引用一条 evidence——署名到外部来源才算署名",
    });
  }
});

/**
 * Where today's price sits in the multiple's own history.
 *
 * A fact about the market, not a verdict on it: the multiple is arithmetic and
 * the percentile is a rank inside a stated window. `adjustmentBasis` is forced
 * to 前复权 because a percentile computed across a mixed adjustment basis is
 * wrong in a way nothing on the page would reveal — the A-share `daily` and US
 * `us_daily` feeds are unadjusted while the HK feed is not, so the default
 * outcome of not saying is a silently distorted rank (registry §9).
 */
const multiplePercentileSchema = z.object({
  /** Which multiple — "P/E（正常化）", "P/S", "EV/EBITDA". */
  metricLabel: z.string().min(1),
  status: z.enum(["calculated", "unavailable"]),
  value: decimalString.optional(),
  /** 0–100. */
  percentile: decimalString.optional(),
  windowFrom: z.string().min(1).optional(),
  windowTo: z.string().min(1).optional(),
  adjustmentBasis: z.enum(["前复权", "后复权", "不复权"]).optional(),
  reason: z.string().min(1).optional(),
  evidenceIds: z.array(z.string()),
}).superRefine((entry, context) => {
  if (entry.status === "unavailable") {
    if (!entry.reason) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "unavailable 的倍数分位必须写 reason",
      });
    }
    for (const key of ["value", "percentile", "windowFrom", "windowTo", "adjustmentBasis"] as const) {
      if (entry[key] !== undefined) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: `unavailable 的倍数分位不得填写 ${key}`,
        });
      }
    }
    return;
  }
  for (const key of ["value", "percentile", "windowFrom", "windowTo", "adjustmentBasis"] as const) {
    if (entry[key] === undefined) {
      context.addIssue({
        code: "custom",
        path: [key],
        message: `calculated 的倍数分位必须填写 ${key}`,
      });
    }
  }
  if (entry.adjustmentBasis !== undefined && entry.adjustmentBasis !== "前复权") {
    context.addIssue({
      code: "custom",
      path: ["adjustmentBasis"],
      message:
        `历史倍数分位必须统一到前复权，写的是「${entry.adjustmentBasis}」。` +
        `三个市场的行情接口口径不一致，混用后的分位数看起来完全正常但是错的` +
        `（见 data-source-registry.md 第 9 节）。`,
    });
  }
  // Guarded rather than parsed straight: `snapshot:sync` and the checker both run
  // against half-filled drafts, and `new Decimal("__TODO__")` throws instead of
  // reporting, which would take down the whole check on an untouched skeleton.
  if (entry.percentile !== undefined && /^-?\d+(?:\.\d+)?$/.test(entry.percentile)) {
    const percentile = new Decimal(entry.percentile);
    if (percentile.lessThan(0) || percentile.greaterThan(100)) {
      context.addIssue({
        code: "custom",
        path: ["percentile"],
        message: `分位必须落在 0–100，写的是 ${entry.percentile}`,
      });
    }
  }
  if (entry.evidenceIds.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["evidenceIds"],
      message: "calculated 的倍数分位必须引用价格序列与倍数分母的 evidence",
    });
  }
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

/**
 * One answer to one triggered density rule.
 *
 * A response may not be a disclaimer. `blocked` therefore carries the same
 * three-part gap record as `methodSelection.blockedBy`: what number is missing,
 * why it would help, where to get it. Writing a disclaimer is cheaper than
 * fetching data, so the cheap option is the one that has to be closed off.
 */
const densityResponseSchema = z.object({
  ruleId: z.enum(DENSITY_RULE_IDS as [string, ...string[]]),
  observed: z.string().min(1),
  response: z.enum(["adopted", "blocked", "rejected", "acknowledged"]),
  note: z.string().min(1),
  blockedBy: z.array(z.object({
    dataItem: z.string().min(1),
    whyNeeded: z.string().min(1),
    whereToGet: z.string().min(1),
  })).optional(),
}).superRefine((entry, context) => {
  if (entry.response === "blocked" && (entry.blockedBy ?? []).length === 0) {
    context.addIssue({
      code: "custom",
      path: ["blockedBy"],
      message:
        "response 为 blocked 时必须列出 blockedBy：缺的是哪一个数、它为什么能提高证据密度、" +
        "去哪份文件的哪一部分取。写「需要更多数据」不算合格。",
    });
  }
});

/**
 * The governance summary materialised from `commitments.json` (ADR-0019).
 *
 * Defined here rather than in `commitments.ts` so the dependency runs one way:
 * that module needs `financialValueSchema` from this one, exactly as `ledger.ts`
 * does, and a snapshot field cannot be validated by a schema this file imports
 * back from it.
 *
 * Counts and lists only, never a delivery *grade*. A rate mapped onto
 * ">80% 优秀 / <40% 不可信赖" reads like a rating while its denominator depends
 * on which promises were written down — improvable by recording fewer soft ones.
 */
export const commitmentSummarySchema = z.object({
  coverageFrom: z.string().min(1),
  counts: z.object({
    兑现: z.number().int().min(0),
    部分兑现: z.number().int().min(0),
    未兑现: z.number().int().min(0),
    待到期: z.number().int().min(0),
    已撤回: z.number().int().min(0),
  }),
  outstanding: z.array(z.object({
    id: z.string().min(1),
    commitment: z.string().min(1),
    dueBy: z.string().min(1),
    status: z.string().min(1),
  })),
  latestResolution: z.object({
    id: z.string().min(1),
    commitment: z.string().min(1),
    status: z.string().min(1),
    resolvedAt: z.string().min(1),
  }).nullable(),
  capitalAllocation: z.array(z.object({
    id: z.string().min(1),
    kind: z.string().min(1),
    statedAt: z.string().min(1),
    commitment: z.string().min(1),
    status: z.string().min(1),
    amount: financialValueSchema.optional(),
    valuationAtTime: z.string().min(1).optional(),
    returnAssessment: z.string().min(1).optional(),
  })),
});

export type CommitmentSummary = z.infer<typeof commitmentSummarySchema>;

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

export const SCHEMA_VERSION = "1.2.0";

/**
 * The contract that led with a stance, a fair value and an action ladder.
 *
 * Frozen, not migrated, for the same reason 1.0.0 is: those snapshots really did
 * say "不追价，等回撤" and really did compute a fair value, and deleting those
 * fields would rewrite what was published rather than change what gets published
 * next (ADR-0021). Six snapshots carry this version; they keep rendering and keep
 * being verified against the engine that produced them.
 */
export const PRIOR_SCHEMA_VERSION = "1.1.0";

/**
 * The contract before structured business model, market position and a computed
 * valuation existed.
 *
 * Kept parseable rather than migrated. ADR-0002 makes a dated research report an
 * immutable record, and back-filling the new blocks would mean inventing an
 * exchange rate and a market-share denominator for a judgment made months ago —
 * writing today's numbers into yesterday's conclusion.
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

/** The 1.1.0 shape, kept whole so the six snapshots published under it stay verified. */
const priorSnapshotShape = z.object({
  schemaVersion: z.literal(PRIOR_SCHEMA_VERSION),
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
    /**
     * Where the market and this snapshot actually disagree.
     *
     * The implied multiple is the market's number, not the market's reason.
     * Anchoring the disagreement to a declared driver is what turns "I know the
     * market disagrees" into "I know which observable the market disagrees
     * about" — and only the second can be settled by the next filing.
     * "竞争加剧" and "监管风险" hold for every company at every price, so they
     * explain no particular gap; hence the id, checked for existence.
     */
    disagreement: z.object({
      driverId: z.string().min(1),
      marketAssumption: z.string().min(1),
      ourAssumption: z.string().min(1),
      /**
       * When `converged` is true this states that the price offers no margin of
       * safety, rather than naming an error — the honest reading when the
       * implied path and the base case are the same path.
       */
      ifMarketIsRight: z.string().min(1),
      converged: z.boolean(),
    }).optional(),
    evidenceIds: z.array(z.string()).min(1),
  }),
  risks: z.array(z.string().min(1)).min(3),
  viewChanges: z.object({
    upgrade: z.array(z.string().min(1)).min(1),
    downgrade: z.array(z.string().min(1)).min(1),
  }),
  checkpoints: z.array(z.string().min(1)).min(3),
  /**
   * Materialised from `commitments.json`, never hand-written: `snapshot:sync`
   * writes it and `snapshot:check` compares it against the ledger, exactly as
   * with `financialHistory`. Optional because a newly listed company may
   * genuinely have nothing to record — but an empty ledger still has to exist
   * and state its coverage start, so "no commitments" and "nobody looked" stay
   * distinguishable.
   */
  commitmentSummary: commitmentSummarySchema.optional(),
  evidence: z.array(evidenceSchema).min(2),
  /**
   * How much of this snapshot rests on missing values and inference.
   *
   * `computed` is engine output and recomputed by the checker, like
   * `impliedExpectation`. Triggering a rule never blocks publication — evidence
   * really is thin for some companies, and blocking would push an author to
   * rewrite an honest `unavailable` as an `inference` to get past the checker,
   * which is the exact behaviour these rules exist to catch. Leaving a triggered
   * rule unanswered does block.
   *
   * Optional so snapshots published before ADR-0020 stay valid: the statistics
   * can be computed for them, but nobody is going to back-fill a self-audit
   * nobody performed at the time.
   */
  evidenceDensity: z.object({
    computed: z.object({
      unavailableShare: decimalString,
      inferenceShare: decimalString,
      lowConfidenceDriverShare: decimalString,
      unsupportedDriverShare: decimalString,
      idealMethodBlocked: z.boolean(),
    }),
    responses: z.array(densityResponseSchema),
  }).optional(),
  disclaimer: z.string().min(1),
});

/**
 * The current contract: market capitalisation is a fact, the price is a fact, and
 * every assumption behind a number is attributed to someone outside this
 * repository (ADR-0021, ADR-0022).
 *
 * What left `summary`: `stance`, `confidence`, `headline`, `fairValue`,
 * `marginOfSafety`, `strongestEvidence` and `largestRisk`. Each was a price-class
 * judgment or a "most important" ranking, and neither can ever be settled by a
 * filing. What stayed is what can: how the company makes money, whether that
 * mechanism changed, what it costs today, and when the next number lands.
 */
const snapshotShape = priorSnapshotShape
  .omit({ schemaVersion: true, summary: true, valuation: true, thesisChange: true })
  .extend({
    schemaVersion: z.literal(SCHEMA_VERSION),
    summary: z.object({
      businessModel: z.string().min(1),
      businessModelChange: z.enum(["未变", "参数变化", "机制变化", "结构性变化"]),
      /** Engine output: referencePrice × shares × fx, at `valuation.valueScale`. */
      marketCap: z.object({
        value: decimalString,
        currency: z.string().min(1),
        scale: metricScaleSchema,
        asOf: z.iso.datetime({ offset: true }),
      }),
      referencePrice: z.object({
        value: decimalString,
        currency: z.string().min(1),
        asOf: z.iso.datetime({ offset: true }),
      }),
      multiplePercentile: multiplePercentileSchema,
      nextValidation: z.string().min(1),
    }),
    thesisChange: priorSnapshotShape.shape.thesisChange.extend({
      /**
       * Which attributed seats appeared or vanished since the last snapshot.
       * Optional in the contract, enforced by the comparability layer, exactly as
       * `driverChanges` is: seats have no floor, so without this a source that
       * simply went unchecked is indistinguishable from one that stopped existing.
       */
      assumptionSetChanges: z.array(assumptionSetChangeSchema).optional(),
    }),
    valuation: priorSnapshotShape.shape.valuation
      .omit({
        scenarios: true,
        actionZones: true,
        impliedExpectation: true,
        currentExpectation: true,
        disagreement: true,
      })
      .extend({
        assumptionSets: z.array(assumptionSetSchema).min(1),
        /**
         * Where the price and one attributed set differ, on one observable.
         *
         * The implied multiple is the market's number, not the market's reason.
         * Anchoring to a declared driver is what turns "the market disagrees"
         * into "the market disagrees about this observable" — and only the second
         * can be settled by the next filing. "竞争加剧" and "监管风险" hold for
         * every company at every price, so they explain no particular gap.
         *
         * Both sides are now citable: `referenceAssumption` belongs to a named
         * source rather than to this repository, so the comparison is arithmetic
         * on two published numbers instead of a private forecast versus a price.
         */
        disagreement: z.object({
          driverId: z.string().min(1),
          assumptionSetId: z.string().min(1),
          marketAssumption: z.string().min(1),
          referenceAssumption: z.string().min(1),
          /** Which link of `causalChain` the two readings part company at. */
          divergenceLink: z.string().min(1),
          converged: z.boolean(),
        }).optional(),
      }),
  });

const legacySnapshotShape = priorSnapshotShape
  .omit({ schemaVersion: true, company: true, businessModel: true, marketPosition: true, valuation: true })
  .extend({
    schemaVersion: z.literal("1.0.0"),
    company: priorSnapshotShape.shape.company.omit({ industryTags: true }),
    valuation: legacyValuationSchema,
  });

type SnapshotShape = z.infer<typeof snapshotShape>;
type PriorSnapshotShape = z.infer<typeof priorSnapshotShape>;
type LegacySnapshotShape = z.infer<typeof legacySnapshotShape>;
type AnySnapshotShape = SnapshotShape | PriorSnapshotShape | LegacySnapshotShape;

/**
 * The three generations, named once.
 *
 * Exported because every renderer needs them and three private copies keyed off
 * hard-coded version literals is three places to forget when a fourth generation
 * lands. They derive from `SCHEMA_VERSION` / `PRIOR_SCHEMA_VERSION` so the literal
 * appears exactly once in the package.
 */
export type CurrentSnapshot = SnapshotShape;
export type FrozenSnapshot = PriorSnapshotShape;
export type StructuredSnapshot = SnapshotShape | PriorSnapshotShape;
export type LegacySnapshot = LegacySnapshotShape;

export function isCurrentSnapshot(snapshot: AnySnapshotShape): snapshot is SnapshotShape {
  return snapshot.schemaVersion === SCHEMA_VERSION;
}

export function isPriorSnapshot(snapshot: AnySnapshotShape): snapshot is PriorSnapshotShape {
  return snapshot.schemaVersion === PRIOR_SCHEMA_VERSION;
}

/**
 * Whether the structured business model and market position blocks exist.
 *
 * Both 1.2.0 and 1.1.0 carry them, so the renderers and the referential-integrity
 * checks share one predicate rather than each deciding what "current" means.
 */
export function hasStructuredModel(
  snapshot: AnySnapshotShape,
): snapshot is SnapshotShape | PriorSnapshotShape {
  return snapshot.schemaVersion !== "1.0.0";
}

/**
 * The stance a snapshot published, or `null` for a contract that publishes none.
 *
 * A reader of a frozen 1.1.0 page still sees the stance it was published with;
 * accessors exist so nothing downstream has to branch on a version literal to
 * find that out.
 */
export function stanceOf(snapshot: AnySnapshotShape): { stance: string; confidence: string } | null {
  return isCurrentSnapshot(snapshot)
    ? null
    : { stance: snapshot.summary.stance, confidence: snapshot.summary.confidence };
}

export function fairValueOf(snapshot: AnySnapshotShape) {
  return isCurrentSnapshot(snapshot) ? null : snapshot.summary.fairValue;
}

export function marketCapOf(snapshot: AnySnapshotShape) {
  return isCurrentSnapshot(snapshot) ? snapshot.summary.marketCap : null;
}

export const researchSnapshotSchema = z
  .discriminatedUnion("schemaVersion", [snapshotShape, priorSnapshotShape, legacySnapshotShape])
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
    ...(hasStructuredModel(snapshot)
      ? [
          ...snapshot.businessModel.evidenceIds,
          ...snapshot.businessModel.segments.flatMap((segment) => segment.evidenceIds),
          ...(snapshot.businessModel.moat ?? []).flatMap((moat) => moat.evidenceIds),
          ...snapshot.marketPosition.evidenceIds,
          ...snapshot.marketPosition.measures.flatMap((measure) => measure.evidenceIds),
          ...snapshot.marketPosition.competitors.flatMap((competitor) => competitor.evidenceIds),
          ...snapshot.valuation.shares.evidenceIds,
          ...snapshot.valuation.fx.evidenceIds,
          ...snapshot.valuation.methodSelection.crossChecks.flatMap((check) => check.evidenceIds),
        ]
      : []),
    ...(isCurrentSnapshot(snapshot)
      ? [
          ...snapshot.summary.multiplePercentile.evidenceIds,
          ...snapshot.valuation.assumptionSets.flatMap((set) => [
            ...set.evidenceIds,
            ...(set.components ?? []).flatMap((component) => component.evidenceIds),
          ]),
        ]
      : []),
    ...(isPriorSnapshot(snapshot)
      ? snapshot.valuation.scenarios.flatMap((scenario) =>
          scenario.components.flatMap((component) => component.evidenceIds),
        )
      : []),
  ];
  for (const evidenceId of references) {
    if (!evidenceIds.has(evidenceId)) {
      context.addIssue({ code: "custom", message: `引用了不存在的 evidence id：${evidenceId}` });
    }
  }
  if (!isCurrentSnapshot(snapshot)) {
    const low = new Decimal(snapshot.summary.fairValue.low);
    const center = new Decimal(snapshot.summary.fairValue.center);
    const high = new Decimal(snapshot.summary.fairValue.high);
    if (low.greaterThan(center) || center.greaterThan(high)) {
      context.addIssue({ code: "custom", message: "合理价值必须满足 low <= center <= high" });
    }
  }

  if (!hasStructuredModel(snapshot)) return;

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

  // A moat has to point at a driver that exists, and the disagreement has to
  // point at one too. Both are the entire mechanism by which those blocks stay
  // falsifiable rather than becoming two more prose fields.
  const driverIds = new Set(snapshot.driverMetrics.map((metric) => metric.id));
  for (const [index, moat] of (snapshot.businessModel.moat ?? []).entries()) {
    for (const driverId of moat.driverIds) {
      if (driverIds.has(driverId)) continue;
      context.addIssue({
        code: "custom",
        path: ["businessModel", "moat", index, "driverIds"],
        message:
          `护城河「${moat.id}」引用了不存在的驱动指标 ${driverId}。` +
          `护城河必须落在已声明的 driverMetrics 上；找不到支撑它的指标时，` +
          `先怀疑这条护城河并不存在，再考虑是不是缺了一个该建的驱动。`,
      });
    }
  }
  const disagreement = snapshot.valuation.disagreement;
  if (disagreement && !driverIds.has(disagreement.driverId)) {
    context.addIssue({
      code: "custom",
      path: ["valuation", "disagreement", "driverId"],
      message:
        `分歧点引用了不存在的驱动指标 ${disagreement.driverId}。` +
        `分歧必须锚在一个已声明的驱动上——「竞争加剧」这类说法对任何公司在任何价格都成立，` +
        `因此解释不了任何具体的价差。`,
    });
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

  // A disagreement has to contrast the price with a seat that actually carries
  // numbers. Pointing it at an `unavailable` seat would name a gap against
  // nothing — the arithmetic version of citing a source that says nothing.
  if (isCurrentSnapshot(snapshot) && snapshot.valuation.disagreement) {
    const { assumptionSetId } = snapshot.valuation.disagreement;
    const target = snapshot.valuation.assumptionSets.find((set) => set.id === assumptionSetId);
    if (!target) {
      context.addIssue({
        code: "custom",
        path: ["valuation", "disagreement", "assumptionSetId"],
        message:
          `分歧点引用了不存在的假设集 ${assumptionSetId}；` +
          `它必须命中 valuation.assumptionSets[].id。`,
      });
    } else if (target.status !== "available") {
      context.addIssue({
        code: "custom",
        path: ["valuation", "disagreement", "assumptionSetId"],
        message:
          `分歧点对照的假设集「${target.id}」状态为 unavailable，没有可对比的数字。` +
          `换一个 available 的假设集，或先把这一组取到。`,
      });
    }
  }

  if (isCurrentSnapshot(snapshot)) {
    verifyValuation(snapshot, context);
  } else {
    verifyPriorValuation(snapshot, context);
  }
  verifyEvidenceDensity(snapshot, context);
});

/**
 * Recompute the density statistics and hold the author to answering what fires.
 *
 * Only the answers are enforced, never the density itself. A thin-evidence
 * company is a fact about that company, and a checker that refused to publish it
 * would be asking the author to launder the thinness rather than declare it.
 */
function verifyEvidenceDensity(
  snapshot: SnapshotShape | PriorSnapshotShape,
  context: z.RefinementCtx,
): void {
  const block = snapshot.evidenceDensity;
  if (!block) return;

  const expected = computeEvidenceDensity(snapshot);
  for (const key of [
    "unavailableShare",
    "inferenceShare",
    "lowConfidenceDriverShare",
    "unsupportedDriverShare",
    "idealMethodBlocked",
  ] as const) {
    if (block.computed[key] !== expected[key]) {
      context.addIssue({
        code: "custom",
        path: ["evidenceDensity", "computed", key],
        message:
          `evidenceDensity.computed.${key} 由引擎从快照自身统计，应为 ` +
          `${String(expected[key])}，写的是 ${String(block.computed[key])}。` +
          `运行 npm run snapshot:sync 重算，不要手改这个字段。`,
      });
    }
  }

  const triggered = triggeredDensityRules(densityFactsFrom(expected));
  const answered = new Set(block.responses.map((entry) => entry.ruleId));
  for (const { rule, observed } of triggered) {
    if (answered.has(rule.id)) continue;
    context.addIssue({
      code: "custom",
      path: ["evidenceDensity", "responses"],
      message:
        `证据密度规则「${rule.label}」被触发（${observed}），但 evidenceDensity.responses 没有回应。` +
        `补一条 {"ruleId":"${rule.id}","observed":"${observed}","response":"...","note":"..."}；` +
        `标 blocked 时必须写出可去取的具体数据。`,
    });
  }
  for (const entry of block.responses) {
    if (triggered.some(({ rule }) => rule.id === entry.ruleId)) continue;
    context.addIssue({
      code: "custom",
      path: ["evidenceDensity", "responses"],
      message: `evidenceDensity.responses 回应了未触发的规则 ${entry.ruleId}；删除它或核对触发条件。`,
    });
  }
}

/**
 * The basis checks both contracts share: one declared scale, one reporting
 * currency, one trading currency.
 *
 * Returns false when the scale mismatch makes every downstream number wrong by an
 * order of magnitude, which is worth reporting alone rather than burying under
 * fifty consequential failures.
 */
function verifyValuationBasis(
  snapshot: SnapshotShape | PriorSnapshotShape,
  context: z.RefinementCtx,
): boolean {
  const { valuation, summary } = snapshot;
  if (valuation.shares.scale !== valuation.valueScale) {
    context.addIssue({
      code: "custom",
      message:
        `valuation.shares.scale（${valuation.shares.scale}）必须与 valueScale（${valuation.valueScale}）一致，` +
        `否则每股价值会差一个数量级。`,
    });
    return false;
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
  return true;
}

/**
 * Recompute one component set and compare it against what the file stores.
 *
 * Shared because 1.2.0 verifies this per attributed seat and 1.1.0 verifies it per
 * scenario, and the arithmetic is identical — only the label in the message differs.
 * Two copies would let the frozen generation's verification rot unnoticed, which is
 * exactly what it exists to prevent.
 */
function verifyComponentComputation(input: {
  label: string;
  components: readonly z.infer<typeof valuationComponentSchema>[];
  computed: z.infer<typeof scenarioComputationSchema>;
  stored: z.infer<typeof impliedExpectationSchema> | undefined;
  basis: { fx: string; shares: string };
  referencePrice: string;
  path: PropertyKey[];
  context: z.RefinementCtx;
}): void {
  const { label, components, computed, stored, basis, referencePrice, path: issuePath, context } = input;
  const issue = (message: string) => context.addIssue({ code: "custom", path: issuePath, message });

  let expected;
  try {
    expected = computeScenario(components, basis);
  } catch (error) {
    issue(`${label}无法计算：${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  for (const key of ["low", "center", "high", "totalLow", "totalHigh"] as const) {
    if (computed[key] !== expected[key]) {
      issue(
        `${label}的 computed.${key} 与组件算出的结果不符：` +
        `写的是 ${computed[key]}，按组件应为 ${expected[key]}。` +
        `运行 npm run snapshot:sync 重算，不要手改这个字段。`,
      );
    }
  }
  if (JSON.stringify(computed.bridge) !== JSON.stringify(expected.bridge)) {
    issue(`${label}的 computed.bridge 与组件不符；运行 npm run snapshot:sync 重算。`);
  }
  if (new Decimal(computed.low).greaterThan(computed.high)) {
    issue(`${label}的下沿高于上沿，检查组件的加减方向。`);
  }

  if (stored === undefined) return;
  try {
    const implied = computeImpliedExpectation(components, basis, referencePrice);
    for (const key of [
      "marketCap",
      "operatingValue",
      "nonOperatingPerShare",
      "multipleLow",
      "multipleHigh",
      "metricLabel",
    ] as const) {
      if (stored[key] !== implied[key]) {
        issue(
          `${label}的 impliedExpectation.${key} 与组件算出的结果不符：` +
          `写的是 ${String(stored[key])}，应为 ${String(implied[key])}。`,
        );
      }
    }
  } catch (error) {
    issue(`${label}的隐含预期无法计算：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Recompute everything the engine owns under 1.2.0 and reject the snapshot if the
 * stored answer disagrees.
 *
 * A JSON file has no read-only fields, so this is what "the author cannot write
 * the market capitalisation" actually means in practice. It runs inside the schema
 * rather than only in the CLI so that publishing cannot bypass it either.
 *
 * What is no longer checked, because it is no longer published: a fair value equal
 * to the base scenario, an action ladder derived from bear and base bounds, and
 * the monotonic 熊 < 基准 < 牛 ordering. Attributed seats have no ordering to
 * enforce — an issuer's guidance sitting above a short report is information, not
 * an inconsistency.
 */
function verifyValuation(snapshot: SnapshotShape, context: z.RefinementCtx): void {
  const { valuation, summary } = snapshot;
  if (!verifyValuationBasis(snapshot, context)) return;

  const basis = { fx: valuation.fx.value, shares: valuation.shares.value };

  if (summary.marketCap.currency !== valuation.currency) {
    context.addIssue({
      code: "custom",
      path: ["summary", "marketCap", "currency"],
      message: `summary.marketCap.currency 必须等于 valuation.currency（${valuation.currency}）`,
    });
  }
  if (summary.marketCap.scale !== valuation.valueScale) {
    context.addIssue({
      code: "custom",
      path: ["summary", "marketCap", "scale"],
      message: `summary.marketCap.scale 必须等于 valuation.valueScale（${valuation.valueScale}）`,
    });
  }
  if (summary.marketCap.asOf !== summary.referencePrice.asOf) {
    context.addIssue({
      code: "custom",
      path: ["summary", "marketCap", "asOf"],
      message:
        "summary.marketCap.asOf 必须等于参考价格的时点——市值是这个价格乘出来的，" +
        "两个时点不同意味着页头第一格与第二格说的不是同一个时刻。",
    });
  }
  try {
    const expected = computeMarketCap(basis, summary.referencePrice.value);
    if (summary.marketCap.value !== expected) {
      context.addIssue({
        code: "custom",
        path: ["summary", "marketCap", "value"],
        message:
          `summary.marketCap.value 由引擎计算（参考价 × 股数 × 汇率），应为 ${expected}，` +
          `写的是 ${summary.marketCap.value}。运行 npm run snapshot:sync 重算。`,
      });
    }
  } catch (error) {
    context.addIssue({
      code: "custom",
      path: ["summary", "marketCap", "value"],
      message: `无法计算市值：${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const seatIds = new Set<string>();
  for (const set of valuation.assumptionSets) {
    if (seatIds.has(set.id)) {
      context.addIssue({
        code: "custom",
        path: ["valuation", "assumptionSets"],
        message: `重复的假设集 id：${set.id}`,
      });
    }
    seatIds.add(set.id);
  }

  const available = valuation.assumptionSets.filter((set) => set.status === "available");
  if (available.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["valuation", "assumptionSets"],
      message:
        "至少需要一组 available 的假设集。席位数量不设下限，但一组都算不出来时" +
        "价格隐含就没有任何可对照的数字，估值块也就没有内容。" +
        "「历史区间回归」只依赖 financials.json，任何有账本的公司都能算出来。",
    });
  }

  for (const set of available) {
    if (!set.computed) continue;
    verifyComponentComputation({
      label: `假设集「${set.id}」`,
      components: set.components ?? [],
      computed: set.computed,
      stored: set.impliedExpectation,
      basis,
      referencePrice: summary.referencePrice.value,
      path: ["valuation", "assumptionSets"],
      context,
    });
  }

  verifyHealthCheck(snapshot, context);
}

/**
 * The 1.1.0 verification, kept intact.
 *
 * Those six snapshots are frozen, so this is not dead code guarding nothing: it is
 * what stops a committed file from being edited by hand years after the contract
 * that produced it stopped being authored.
 */
function verifyPriorValuation(snapshot: PriorSnapshotShape, context: z.RefinementCtx): void {
  const { valuation, summary } = snapshot;
  if (!verifyValuationBasis(snapshot, context)) return;

  const basis = { fx: valuation.fx.value, shares: valuation.shares.value };
  const byName = new Map(valuation.scenarios.map((scenario) => [scenario.name, scenario]));

  for (const scenario of valuation.scenarios) {
    verifyComponentComputation({
      label: `估值情景「${scenario.name}」`,
      components: scenario.components,
      computed: scenario.computed,
      // 1.1.0 stores one implied expectation for the base scenario only, checked
      // separately below against `summary.fairValue`.
      stored: undefined,
      basis,
      referencePrice: summary.referencePrice.value,
      path: [],
      context,
    });
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

  verifyHealthCheck(snapshot, context);
}

/**
 * The valuation health check, shared by both contracts.
 *
 * Unchanged by 1.2.0 on purpose: which method breaks on which company is a fact
 * about the company's accounting, not a view about its price, so it survives the
 * ban on price-class judgment untouched.
 */
function verifyHealthCheck(
  snapshot: SnapshotShape | PriorSnapshotShape,
  context: z.RefinementCtx,
): void {
  const { valuation } = snapshot;
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
  snapshot: SnapshotShape | PriorSnapshotShape,
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
export function deriveHealthFacts(snapshot: SnapshotShape | PriorSnapshotShape): HealthFacts {
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

  // Moat width across two research dates. Only the trend is compared, because
  // that is the only field a moat carries that is a reading rather than
  // structure — and "is it still widening" is the question the block exists for.
  const priorMoats = new Map(
    (hasStructuredModel(prior) ? prior.businessModel.moat ?? [] : []).map((moat) => [moat.id, moat]),
  );
  const currentMoats = hasStructuredModel(current) ? current.businessModel.moat ?? [] : [];
  const moats = currentMoats.map((moat) => {
    const previous = priorMoats.get(moat.id);
    return {
      id: moat.id,
      type: moat.type,
      mechanism: moat.mechanism,
      driverIds: moat.driverIds,
      breaker: moat.breaker,
      priorTrend: previous?.trend ?? null,
      currentTrend: moat.trend,
      changed: previous !== undefined && previous.trend !== moat.trend,
    };
  });
  const droppedMoats = [...priorMoats.values()]
    .filter((moat) => !currentMoats.some((item) => item.id === moat.id))
    .map((moat) => ({ id: moat.id, type: moat.type, priorTrend: moat.trend }));

  // A side, described by whichever fields its own contract published. A 1.2.0
  // snapshot has no stance and no fair value to report, so the page renders one
  // fewer row rather than a row saying "—" as if something had gone missing.
  const side = (snapshot: ResearchSnapshot) => ({
    date: snapshot.snapshot.dataCutoff.slice(0, 10),
    stance: stanceOf(snapshot)?.stance ?? null,
    confidence: stanceOf(snapshot)?.confidence ?? null,
    businessModel: snapshot.summary.businessModel,
    businessModelChange: snapshot.summary.businessModelChange,
    constraints: snapshot.constraints,
    referencePrice: snapshot.summary.referencePrice,
    fairValue: fairValueOf(snapshot),
    marketCap: marketCapOf(snapshot),
    multiplePercentile: isCurrentSnapshot(snapshot) ? snapshot.summary.multiplePercentile : null,
  });

  const priorSets = new Map(
    (isCurrentSnapshot(prior) ? prior.valuation.assumptionSets : []).map((set) => [set.id, set]),
  );
  const currentSets = isCurrentSnapshot(current) ? current.valuation.assumptionSets : [];
  const assumptionSets = currentSets.map((set) => {
    const previous = priorSets.get(set.id);
    return {
      id: set.id,
      sourceKind: set.sourceKind,
      sourceLabel: set.sourceLabel,
      sourceBias: set.sourceBias,
      status: set.status,
      priorStatus: previous?.status ?? null,
      priorComputed: previous?.computed ?? null,
      currentComputed: set.computed ?? null,
    };
  });
  const droppedAssumptionSets = [...priorSets.values()]
    .filter((set) => !currentSets.some((item) => item.id === set.id))
    .map((set) => ({ id: set.id, sourceKind: set.sourceKind, sourceLabel: set.sourceLabel }));

  return {
    prior: side(prior),
    current: side(current),
    assumptionSets,
    droppedAssumptionSets,
    metrics,
    driverMetrics,
    moats,
    droppedMoats,
    evidence: {
      added: addedEvidence,
      supersededAssumptions: current.thesisChange.supersededAssumptions,
    },
  };
}
