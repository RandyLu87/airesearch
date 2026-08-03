import { SENTINEL } from "./shared.ts";

type Json = Record<string, unknown>;

/**
 * One calibration field: how to fill it when the prior snapshot has no value.
 * `optional: true` means the field is legitimately absent for some metrics —
 * a percent driver has no currency — so it must be omitted rather than
 * sentinelled. Sentinelling it would demand a value the schema forbids, and the
 * only valid fix (deleting the key) is not what a sentinel message asks for.
 */
type CalibrationField = { key: string; fallback?: unknown; optional?: boolean };

/**
 * Copy the fields that define *how* something is measured, and sentinel the
 * fields that record *what was measured*. Inheriting calibration is what makes
 * the next snapshot comparable by default; inheriting numbers would make a
 * stale restatement the lazy path, so it is never done.
 */
function inherit(source: Json | undefined, fields: CalibrationField[]): Json {
  const result: Json = {};
  for (const { key, fallback, optional } of fields) {
    const value = source?.[key];
    if (value !== undefined) {
      result[key] = value;
      continue;
    }
    if (optional) continue;
    result[key] = fallback === undefined ? SENTINEL : fallback;
  }
  return result;
}

const DRIVER_CALIBRATION: CalibrationField[] = [
  { key: "id" },
  { key: "label" },
  { key: "definition" },
  { key: "definitionVersion", fallback: "1.0.0" },
  { key: "causalRole" },
  { key: "dimension" },
  { key: "signalType" },
  { key: "unit" },
  { key: "currency", optional: true },
  { key: "scale" },
  { key: "precision", fallback: 2 },
  { key: "periodType" },
  { key: "accountingBasis" },
];

const OBSERVATION_CALIBRATION: CalibrationField[] = [
  { key: "metricId" },
  { key: "label" },
  { key: "definitionVersion", fallback: "1.0.0" },
  { key: "unit" },
  { key: "currency", optional: true },
  { key: "scale" },
  { key: "precision", fallback: 2 },
  { key: "periodType" },
  { key: "accountingBasis" },
];

function driverSkeleton(prior?: Json): Json {
  return {
    ...inherit(prior, DRIVER_CALIBRATION),
    status: SENTINEL,
    value: SENTINEL,
    displayValue: SENTINEL,
    period: SENTINEL,
    baseline: SENTINEL,
    trend: SENTINEL,
    confidence: SENTINEL,
    threshold: SENTINEL,
    evidenceIds: [SENTINEL],
  };
}

function observationSkeleton(prior?: Json): Json {
  return {
    ...inherit(prior, OBSERVATION_CALIBRATION),
    status: SENTINEL,
    value: SENTINEL,
    period: SENTINEL,
    evidenceIds: [SENTINEL],
  };
}

function financialValueSkeleton(prior?: Json): Json {
  return {
    value: SENTINEL,
    unit: prior?.unit ?? SENTINEL,
    ...(prior?.currency === undefined ? {} : { currency: prior.currency }),
    scale: prior?.scale ?? SENTINEL,
    precision: prior?.precision ?? 2,
  };
}

const FINANCIAL_VALUE_KEYS = [
  "revenue",
  "revenueGrowth",
  "grossMargin",
  "operatingMargin",
  "netProfit",
  "operatingCashFlow",
  "freeCashFlow",
];

function financialPeriodSkeleton(prior?: Json): Json {
  const period: Json = {
    period: SENTINEL,
    periodType: prior?.periodType ?? SENTINEL,
    accountingBasis: prior?.accountingBasis ?? SENTINEL,
  };
  for (const key of FINANCIAL_VALUE_KEYS) {
    const priorValue = prior?.[key] as Json | undefined;
    if (key === "revenue" || key === "netProfit" || priorValue !== undefined) {
      period[key] = financialValueSkeleton(
        priorValue ??
          (key === "revenue" || key === "netProfit"
            ? { unit: "currency", currency: SENTINEL, scale: SENTINEL, precision: 0 }
            : { unit: "percent", scale: "one", precision: 2 }),
      );
    }
  }
  period.evidenceIds = [SENTINEL];
  return period;
}

function sectionSkeleton(prior?: Json): Json {
  return {
    id: prior?.id ?? SENTINEL,
    title: prior?.title ?? SENTINEL,
    summary: SENTINEL,
    bullets: [SENTINEL],
    evidenceIds: [SENTINEL],
  };
}

function evidenceSkeleton(): Json {
  return {
    id: SENTINEL,
    kind: SENTINEL,
    title: SENTINEL,
    publisher: SENTINEL,
    periodOrEventDate: SENTINEL,
    publishedAt: SENTINEL,
    retrievedAt: SENTINEL,
    url: SENTINEL,
  };
}

function repeat<T>(count: number, build: (index: number) => T): T[] {
  return Array.from({ length: count }, (_unused, index) => build(index));
}

export function buildSkeleton(input: {
  companyId: string;
  snapshotId: string;
  createdAt: string;
  prior?: Json;
}): Json {
  const { companyId, snapshotId, createdAt, prior } = input;
  const priorSummary = prior?.summary as Json | undefined;
  const priorReferencePrice = priorSummary?.referencePrice as Json | undefined;
  const priorFairValue = priorSummary?.fairValue as Json | undefined;
  const priorDrivers = (prior?.driverMetrics as Json[] | undefined) ?? [];
  const priorObservations = (prior?.standardMetrics as Json[] | undefined) ?? [];
  const priorConstraints = (prior?.constraints as Json[] | undefined) ?? [];
  const priorHistory = (prior?.financialHistory as Json[] | undefined) ?? [];
  const priorSections = (prior?.sections as Json[] | undefined) ?? [];
  const priorValuation = prior?.valuation as Json | undefined;
  const priorActionZones = (priorValuation?.actionZones as Json[] | undefined) ?? [];

  const company = (prior?.company as Json | undefined) ?? {
    id: companyId,
    name: SENTINEL,
    legalName: SENTINEL,
    ticker: SENTINEL,
    market: SENTINEL,
    reportingCurrency: SENTINEL,
    accountingStandard: SENTINEL,
  };

  return {
    schemaVersion: "1.0.0",
    company: { ...company, id: companyId },
    snapshot: { id: snapshotId, createdAt, dataCutoff: SENTINEL },
    // A holding period is a research stance, not a calibration, so it is
    // re-stated each time rather than inherited.
    investmentHorizon: SENTINEL,
    summary: {
      stance: SENTINEL,
      confidence: SENTINEL,
      headline: SENTINEL,
      businessModel: SENTINEL,
      businessModelChange: SENTINEL,
      referencePrice: {
        value: SENTINEL,
        currency: priorReferencePrice?.currency ?? SENTINEL,
        asOf: SENTINEL,
      },
      fairValue: {
        low: SENTINEL,
        center: SENTINEL,
        high: SENTINEL,
        currency: priorFairValue?.currency ?? SENTINEL,
      },
      marginOfSafety: SENTINEL,
      strongestEvidence: SENTINEL,
      largestRisk: SENTINEL,
      nextValidation: SENTINEL,
    },
    standardMetrics:
      priorObservations.length > 0
        ? priorObservations.map((observation) => observationSkeleton(observation))
        : [observationSkeleton()],
    driverMetrics:
      priorDrivers.length > 0
        ? priorDrivers.map((driver) => driverSkeleton(driver))
        : repeat(4, () => driverSkeleton()),
    constraints:
      priorConstraints.length > 0
        ? priorConstraints.map((constraint) => ({
            id: constraint.id ?? SENTINEL,
            label: constraint.label ?? SENTINEL,
            status: SENTINEL,
            explanation: SENTINEL,
            evidenceIds: [SENTINEL],
          }))
        : repeat(2, () => ({ id: SENTINEL, label: SENTINEL, status: SENTINEL, explanation: SENTINEL, evidenceIds: [SENTINEL] })),
    thesisChange: {
      investmentLogic: SENTINEL,
      financialQuality: SENTINEL,
      governance: SENTINEL,
      valuation: SENTINEL,
      newEvidence: [SENTINEL],
      supersededAssumptions: [],
    },
    financialHistory:
      priorHistory.length >= 2
        ? priorHistory.slice(-2).map((period) => financialPeriodSkeleton(period))
        : repeat(2, () => financialPeriodSkeleton()),
    sections:
      priorSections.length >= 3
        ? priorSections.map((section) => sectionSkeleton(section))
        : repeat(3, () => sectionSkeleton()),
    valuation: {
      scenarios: ["熊市", "基准", "牛市"].map((name) => ({
        name,
        assumptions: SENTINEL,
        earnings: SENTINEL,
        method: SENTINEL,
        valueRange: SENTINEL,
        trigger: SENTINEL,
      })),
      actionZones:
        priorActionZones.length >= 3
          ? priorActionZones.map((zone) => ({ label: zone.label ?? SENTINEL, range: SENTINEL, action: SENTINEL }))
          : repeat(3, () => ({ label: SENTINEL, range: SENTINEL, action: SENTINEL })),
      currentExpectation: SENTINEL,
      evidenceIds: [SENTINEL],
    },
    risks: repeat(3, () => SENTINEL),
    viewChanges: { upgrade: [SENTINEL], downgrade: [SENTINEL] },
    checkpoints: repeat(3, () => SENTINEL),
    evidence: repeat(2, () => evidenceSkeleton()),
    disclaimer: "本报告仅作研究与教育用途，不构成个性化投资建议。",
  };
}
