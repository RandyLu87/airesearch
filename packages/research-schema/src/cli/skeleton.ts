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

/**
 * Inherit the roster — who pays, how they are charged, what role the segment
 * plays — and re-source nothing, because none of it is a number. A segment
 * whose role genuinely changed is a business-model change the author has to
 * state deliberately, not something a skeleton should blank out and invite
 * re-guessing.
 */
function businessModelSkeleton(prior?: Json): Json {
  const priorSegments = (prior?.segments as Json[] | undefined) ?? [];
  const segment = (source?: Json): Json => ({
    id: source?.id ?? SENTINEL,
    name: source?.name ?? SENTINEL,
    role: source?.role ?? SENTINEL,
    payer: source?.payer ?? SENTINEL,
    chargingMode: source?.chargingMode ?? SENTINEL,
    evidenceIds: [SENTINEL],
  });
  // A moat's type, mechanism, supporting drivers and breaker are structure and
  // carry over; its trend is the reading and is re-judged every time. Carrying
  // the trend forward would let "still widening" survive by inertia, which is
  // the one thing this block exists to prevent.
  const priorMoats = (prior?.moat as Json[] | undefined) ?? [];
  const moat = (source?: Json): Json => ({
    id: source?.id ?? SENTINEL,
    type: source?.type ?? SENTINEL,
    ...(source?.typeNote === undefined ? {} : { typeNote: source.typeNote }),
    mechanism: source?.mechanism ?? SENTINEL,
    driverIds: source?.driverIds ?? [SENTINEL],
    trend: SENTINEL,
    breaker: source?.breaker ?? SENTINEL,
    evidenceIds: [SENTINEL],
  });

  return {
    segments: priorSegments.length > 0 ? priorSegments.map(segment) : [segment()],
    causalChain: prior?.causalChain ?? SENTINEL,
    deliveryDependency: prior?.deliveryDependency ?? SENTINEL,
    cashEngine: prior?.cashEngine ?? SENTINEL,
    moat: priorMoats.length > 0 ? priorMoats.map(moat) : [moat()],
    evidenceIds: [SENTINEL],
  };
}

/**
 * The denominator is calibration and carries over; the reading does not. This
 * is what stops the next run from quietly re-scoping "market share" to whatever
 * denominator flatters the current number.
 */
function marketPositionSkeleton(prior?: Json): Json {
  const priorMeasures = (prior?.measures as Json[] | undefined) ?? [];
  const measure = (basis: string, source?: Json): Json => ({
    basis: source?.basis ?? basis,
    label: source?.label ?? SENTINEL,
    marketDefinition: source?.marketDefinition ?? SENTINEL,
    denominatorIncludes: source?.denominatorIncludes ?? [SENTINEL],
    denominatorExcludes: source?.denominatorExcludes ?? [],
    status: SENTINEL,
    value: SENTINEL,
    displayValue: SENTINEL,
    unit: source?.unit ?? SENTINEL,
    scale: source?.scale ?? SENTINEL,
    precision: source?.precision ?? 1,
    trend: SENTINEL,
    asOf: SENTINEL,
    evidenceIds: [SENTINEL],
  });
  const measures = priorMeasures.length > 0
    ? priorMeasures.map((source) => measure(String(source.basis), source))
    : [measure("商业化"), measure("规模")];
  return {
    measures,
    competitors: ((prior?.competitors as Json[] | undefined) ?? [undefined]).map((source) => ({
      name: (source as Json | undefined)?.name ?? SENTINEL,
      share: SENTINEL,
      note: SENTINEL,
      evidenceIds: [SENTINEL],
    })),
    concentrationTrend: SENTINEL,
    evidenceIds: [SENTINEL],
  };
}

function valuationComponentSkeleton(prior?: Json): Json {
  const kind = prior?.kind ?? SENTINEL;
  const base: Json = {
    id: prior?.id ?? SENTINEL,
    label: prior?.label ?? SENTINEL,
    kind,
    sign: prior?.sign ?? "add",
    note: SENTINEL,
    evidenceIds: [SENTINEL],
  };
  if (kind === "face-value") {
    base.amount = SENTINEL;
    if (prior?.discountPct !== undefined) {
      base.discountPct = SENTINEL;
      base.discountReason = SENTINEL;
    }
    return base;
  }
  base.metricLabel = prior?.metricLabel ?? SENTINEL;
  base.metricLow = SENTINEL;
  base.metricHigh = SENTINEL;
  base.multipleLow = SENTINEL;
  base.multipleHigh = SENTINEL;
  return base;
}

function valuationSkeleton(prior?: Json, priorCompany?: Json): Json {
  const priorScenarios = (prior?.scenarios as Json[] | undefined) ?? [];
  const priorZones = (prior?.actionZones as Json[] | undefined) ?? [];
  const priorSelection = prior?.methodSelection as Json | undefined;
  const priorShares = prior?.shares as Json | undefined;
  const priorFx = prior?.fx as Json | undefined;

  const scenario = (name: string) => {
    const source = priorScenarios.find((item) => item.name === name);
    const components = (source?.components as Json[] | undefined) ?? [undefined];
    return {
      name,
      assumptions: SENTINEL,
      trigger: SENTINEL,
      components: components.map((item) => valuationComponentSkeleton(item as Json | undefined)),
      // Engine output. Sentinelled so an unsynced skeleton can never publish;
      // `npm run snapshot:sync` fills these in once the components are real.
      computed: {
        low: SENTINEL,
        center: SENTINEL,
        high: SENTINEL,
        totalLow: SENTINEL,
        totalHigh: SENTINEL,
        // One sentinelled entry rather than an empty array: the schema requires
        // at least one bridge row, and an empty array would surface as a schema
        // error on an untouched skeleton instead of as an outstanding to-do.
        bridge: [{
          id: SENTINEL,
          label: SENTINEL,
          kind: SENTINEL,
          amountLow: SENTINEL,
          amountHigh: SENTINEL,
          perShareLow: SENTINEL,
          perShareHigh: SENTINEL,
        }],
      },
    };
  };

  return {
    currency: prior?.currency ?? priorCompany?.reportingCurrency ?? SENTINEL,
    valueScale: prior?.valueScale ?? SENTINEL,
    tradingCurrency: prior?.tradingCurrency ?? SENTINEL,
    shares: {
      value: SENTINEL,
      scale: priorShares?.scale ?? SENTINEL,
      evidenceIds: [SENTINEL],
    },
    fx: {
      pair: priorFx?.pair ?? SENTINEL,
      value: SENTINEL,
      asOf: SENTINEL,
      evidenceIds: [SENTINEL, SENTINEL],
    },
    // Derived from this snapshot's own facts once they exist; nothing to inherit.
    healthCheck: [],
    methodSelection: {
      ideal: priorSelection?.ideal ?? SENTINEL,
      idealRationale: SENTINEL,
      adoptedPrimary: priorSelection?.adoptedPrimary ?? SENTINEL,
      adoptedRationale: SENTINEL,
      blockedBy: [],
      crossChecks: ((priorSelection?.crossChecks as Json[] | undefined) ?? [undefined]).map(
        (source) => ({
          methodId: (source as Json | undefined)?.methodId ?? SENTINEL,
          valueLow: SENTINEL,
          valueHigh: SENTINEL,
          keyAssumptions: SENTINEL,
          note: SENTINEL,
          evidenceIds: [SENTINEL],
        }),
      ),
    },
    scenarios: ["熊市", "基准", "牛市"].map(scenario),
    actionZones:
      priorZones.length >= 3
        ? priorZones.map((zone) => ({
            label: zone.label ?? SENTINEL,
            rangeLow: null,
            rangeHigh: null,
            range: SENTINEL,
            action: SENTINEL,
          }))
        : repeat(3, () => ({
            label: SENTINEL,
            rangeLow: null,
            rangeHigh: null,
            range: SENTINEL,
            action: SENTINEL,
          })),
    impliedExpectation: {
      marketCap: SENTINEL,
      operatingValue: SENTINEL,
      nonOperatingPerShare: SENTINEL,
      multipleLow: null,
      multipleHigh: null,
      metricLabel: null,
    },
    currentExpectation: SENTINEL,
    // The driver the market disagrees about is calibration — which observable
    // the argument is actually over rarely changes between two research runs —
    // while both sides' assumed paths are readings and get re-sourced.
    disagreement: {
      driverId: (prior?.disagreement as Json | undefined)?.driverId ?? SENTINEL,
      marketAssumption: SENTINEL,
      ourAssumption: SENTINEL,
      ifMarketIsRight: SENTINEL,
      // No sentinel exists for a boolean. `false` is the load-bearing default:
      // it asserts a gap the author then has to describe, whereas `true` would
      // let "the market and I agree" pass without anyone having checked.
      converged: false,
    },
    evidenceIds: [SENTINEL],
  };
}

export function buildSkeleton(input: {
  companyId: string;
  snapshotId: string;
  createdAt: string;
  prior?: Json;
  ledger?: { periods: unknown[] };
  commitmentSummary?: unknown;
}): Json {
  const { companyId, snapshotId, createdAt, prior, ledger, commitmentSummary } = input;
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
    industryTags: [SENTINEL],
  };

  return {
    schemaVersion: "1.1.0",
    // A prior snapshot written against the 1.0.0 contract has no industry tags,
    // and an absent required field reads as a plain schema error rather than as
    // "you still have to fill this in". Sentinel it so the author is told.
    company: { industryTags: [SENTINEL], ...company, id: companyId },
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
    businessModel: businessModelSkeleton(prior?.businessModel as Json | undefined),
    marketPosition: marketPositionSkeleton(prior?.marketPosition as Json | undefined),
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
    financialHistory: ledger
      ? (ledger.periods as Json[])
      : priorHistory.length >= 2
        ? priorHistory.slice(-2).map((period) => financialPeriodSkeleton(period))
        : repeat(2, () => financialPeriodSkeleton()),
    sections:
      priorSections.length >= 3
        ? priorSections.map((section) => sectionSkeleton(section))
        : repeat(3, () => sectionSkeleton()),
    valuation: valuationSkeleton(priorValuation, prior?.company as Json | undefined),
    risks: repeat(3, () => SENTINEL),
    viewChanges: { upgrade: [SENTINEL], downgrade: [SENTINEL] },
    checkpoints: repeat(3, () => SENTINEL),
    // Materialised, not sentinelled: settled promises are disclosed history, the
    // same category as a closed fiscal year, so re-sourcing them every run is the
    // waste the ledger exists to end. Absent when the company has no ledger yet.
    ...(commitmentSummary === undefined ? {} : { commitmentSummary }),
    evidence: repeat(2, () => evidenceSkeleton()),
    // Engine output, sentinelled so an unsynced draft cannot publish. `responses`
    // starts empty because an empty list is the correct answer when no rule
    // fires; `snapshot:sync` fills `computed` and the checker then demands a
    // response for whatever that computation triggers.
    evidenceDensity: {
      computed: {
        unavailableShare: SENTINEL,
        inferenceShare: SENTINEL,
        lowConfidenceDriverShare: SENTINEL,
        unsupportedDriverShare: SENTINEL,
        idealMethodBlocked: false,
      },
      responses: [],
    },
    disclaimer: "本报告仅作研究与教育用途，不构成个性化投资建议。",
  };
}
