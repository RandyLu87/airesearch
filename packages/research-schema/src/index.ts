import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import Decimal from "decimal.js";
import { z } from "zod";

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
  metricId: z.string().min(1),
  label: z.string().min(1),
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

const financialValueSchema = z.object({
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

const financialPeriodSchema = z.object({
  period: z.string().min(1),
  periodType: z.enum(["quarter", "half-year", "fiscal-year"]),
  accountingBasis: z.string().min(1),
  revenue: financialValueSchema,
  revenueGrowth: financialValueSchema.optional(),
  grossMargin: financialValueSchema.optional(),
  operatingMargin: financialValueSchema.optional(),
  netProfit: financialValueSchema,
  operatingCashFlow: financialValueSchema.optional(),
  freeCashFlow: financialValueSchema.optional(),
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

const valuationScenarioSchema = z.object({
  name: z.enum(["熊市", "基准", "牛市"]),
  assumptions: z.string().min(1),
  earnings: z.string().min(1),
  method: z.string().min(1),
  valueRange: z.string().min(1),
  trigger: z.string().min(1),
});

const actionZoneSchema = z.object({
  label: z.string().min(1),
  range: z.string().min(1),
  action: z.string().min(1),
});

export const researchSnapshotSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  company: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    legalName: z.string().min(1),
    ticker: z.string().min(1),
    market: z.string().min(1),
    reportingCurrency: z.string().min(1),
    accountingStandard: z.string().min(1),
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
  }),
  financialHistory: z.array(financialPeriodSchema).min(2),
  sections: z.array(narrativeSectionSchema).min(3),
  valuation: z.object({
    scenarios: z.array(valuationScenarioSchema).length(3),
    actionZones: z.array(actionZoneSchema).min(3),
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
}).superRefine((snapshot, context) => {
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
    ...snapshot.financialHistory.flatMap((period) => period.evidenceIds),
    ...snapshot.sections.flatMap((section) => section.evidenceIds),
    ...snapshot.valuation.evidenceIds,
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
});

export type ResearchSnapshot = z.infer<typeof researchSnapshotSchema>;
export type MetricObservation = z.infer<typeof observationSchema>;
export type DriverMetric = z.infer<typeof driverMetricSchema>;
export type EvidenceReference = z.infer<typeof evidenceSchema>;

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
  const keys: Array<keyof MetricObservation> = [
    "metricId",
    "definitionVersion",
    "unit",
    "currency",
    "scale",
    "periodType",
    "accountingBasis",
  ];
  const mismatch = keys.find((key) => prior[key] !== current[key]);
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
    const compatibilityKeys: Array<keyof DriverMetric> = [
      "definition",
      "definitionVersion",
      "unit",
      "currency",
      "scale",
      "periodType",
      "accountingBasis",
    ];
    const mismatch = previous && latest
      ? compatibilityKeys.find((key) => previous[key] !== latest[key])
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
