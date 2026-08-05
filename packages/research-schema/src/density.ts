import Decimal from "decimal.js";

/**
 * How much of a snapshot's conclusion rests on missing values and inference.
 *
 * The contract demands completeness — a business model, six drivers, two share
 * denominators, an attributed assumption set — and the pressure that creates runs
 * one way: inference is the only thing that can always be supplied. Nothing in the
 * repository noticed. A snapshot with most drivers `unavailable` and mostly
 * `inference` evidence rendered exactly like one sourced entirely from filings.
 *
 * Every input already existed (`evidence.kind`, `driverMetrics.confidence`, the
 * various `status` fields); the only thing missing was someone counting. Counting
 * is a machine's job, so it happens here rather than being left to a reader
 * willing to tally forty fields by hand.
 *
 * Structured like `valuation/rules.ts` on purpose: pure predicates over one
 * pre-derived flat fact set, `null` meaning "cannot judge" and never "fine".
 */

/** Shares are 0–1. `null` means the denominator was empty, not that all is well. */
export type DensityFacts = {
  /** `unavailable` share across standard metrics, drivers, share measures and assumption sets. */
  unavailableShare: number | null;
  /** Share of evidence records marked `inference`. */
  inferenceShare: number | null;
  /** Share of drivers whose confidence is 低. */
  lowConfidenceDriverShare: number | null;
  /** Share of drivers whose every resolvable evidence record is `inference`. */
  unsupportedDriverShare: number | null;
  /**
   * Whether the ideal valuation method differs from the adopted one. Derived and
   * displayed, but no rule fires on it: `methodSelection.blockedBy` already
   * renders an actionable gap list, and demanding a second response about the
   * same gap is how a checklist turns into theatre.
   */
  idealMethodBlocked: boolean;
};

export type DensityRule = {
  id: string;
  label: string;
  /** What the rule protects against, in the author's language. */
  rationale: string;
  /** Null when the rule does not fire; otherwise the observation that fired it. */
  evaluate: (facts: DensityFacts) => string | null;
};

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Thresholds are a first pass and deliberately live in code rather than in the
 * ADR, so tuning them is a normal change and not a decision reversal.
 */
export const DENSITY_RULES: readonly DensityRule[] = [
  {
    id: "high-unavailable-share",
    label: "缺失值占比偏高",
    rationale:
      "契约要求填满，而 unavailable 是唯一诚实的空位。空位一多，结论就不再由观测支撑，" +
      "但页面上看不出与全部取证的研究有任何区别。署名假设集也计入：席位没有下限，" +
      "所以「三席里两席取不到」必须能在这个数字上看见。",
    evaluate: (facts) =>
      facts.unavailableShare !== null && facts.unavailableShare > 0.25
        ? `标准指标、驱动、份额口径与假设集中 ${percent(facts.unavailableShare)} 为 unavailable，超过 25% 阈值`
        : null,
  },
  {
    id: "inference-heavy-evidence",
    label: "证据以推断为主",
    rationale:
      "inference 是分析判断，不是披露事实也不是可复算结果。推断占多数时，" +
      "证据链看起来完整，实际却是在用判断支撑判断。",
    evaluate: (facts) =>
      facts.inferenceShare !== null && facts.inferenceShare > 0.4
        ? `evidence 中 ${percent(facts.inferenceShare)} 是 inference，超过 40% 阈值`
        : null,
  },
  {
    id: "low-confidence-drivers",
    label: "低置信度驱动偏多",
    rationale:
      "驱动指标是投资逻辑的承重墙。低置信度驱动过多意味着承重墙本身没有站稳，" +
      "而页面上的驱动读数、阈值和分歧点仍然照常呈现。",
    evaluate: (facts) =>
      facts.lowConfidenceDriverShare !== null && facts.lowConfidenceDriverShare > 0.3
        ? `驱动指标中 ${percent(facts.lowConfidenceDriverShare)} 的置信度为「低」，超过 30% 阈值`
        : null,
  },
  {
    id: "unsupported-drivers",
    label: "存在只靠推断支撑的驱动",
    rationale:
      "一个驱动引用的证据全部是 inference，等于在用推断解释推断。" +
      "这是这组规则里最硬的一条：它不看比例，只看有没有。",
    evaluate: (facts) =>
      facts.unsupportedDriverShare !== null && facts.unsupportedDriverShare > 0
        ? `${percent(facts.unsupportedDriverShare)} 的驱动指标没有任何 fact 或 calculation 证据支撑`
        : null,
  },
];

export const DENSITY_RULE_IDS = DENSITY_RULES.map((rule) => rule.id);

export function triggeredDensityRules(
  facts: DensityFacts,
): Array<{ rule: DensityRule; observed: string }> {
  return DENSITY_RULES.flatMap((rule) => {
    const observed = rule.evaluate(facts);
    return observed === null ? [] : [{ rule, observed }];
  });
}

/** The stored form: decimal strings, so a recomputation compares exactly. */
export type DensityComputation = {
  unavailableShare: string;
  inferenceShare: string;
  lowConfidenceDriverShare: string;
  unsupportedDriverShare: string;
  idealMethodBlocked: boolean;
};

/**
 * What `computeEvidenceDensity` can read.
 *
 * Deliberately loose: `snapshot:sync` runs mid-draft against raw JSON that is
 * still half placeholders, and the schema's own refinement runs against parsed
 * data. One function serving both is what guarantees the stored numbers and the
 * verified numbers cannot drift apart.
 */
type DensityInput = {
  standardMetrics?: unknown;
  driverMetrics?: unknown;
  marketPosition?: unknown;
  evidence?: unknown;
  valuation?: unknown;
};

function asArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
        item !== null && typeof item === "object",
      )
    : [];
}

/**
 * Always four decimals, so a stored value and a recomputed one compare as
 * strings without a formatting difference masquerading as drift.
 *
 * An empty denominator yields a true zero rather than null. A valid snapshot
 * always has at least four drivers, two share measures and two evidence records,
 * so the empty case only occurs mid-draft, where `snapshot:sync` is best-effort
 * anyway and the checker will recompute once the draft is filled in.
 */
function share(count: number, total: number): string {
  return total === 0 ? "0.0000" : new Decimal(count).dividedBy(total).toFixed(4);
}

export function computeEvidenceDensity(snapshot: DensityInput): DensityComputation {
  const standardMetrics = asArray(snapshot.standardMetrics);
  const drivers = asArray(snapshot.driverMetrics);
  const measures = asArray(
    (snapshot.marketPosition as { measures?: unknown } | undefined)?.measures,
  );
  const evidence = asArray(snapshot.evidence);
  // Seats have no floor, so "two of the three sources could not be reached" has to
  // show up somewhere. Without this, a snapshot resting on one attributed source
  // reports the same density as one resting on five — the exact invisibility this
  // module exists to end.
  //
  // Absent on 1.1.0 and 1.0.0 snapshots, which have `scenarios` instead. Those
  // therefore contribute nothing here and their stored statistics stay valid,
  // which is what keeps the frozen generations from failing their own checker.
  const assumptionSets = asArray(
    (snapshot.valuation as { assumptionSets?: unknown } | undefined)?.assumptionSets,
  );

  const statusBearing = [...standardMetrics, ...drivers, ...measures, ...assumptionSets];
  const unavailable = statusBearing.filter((item) => item.status === "unavailable").length;

  const inference = evidence.filter((item) => item.kind === "inference").length;

  const lowConfidence = drivers.filter((driver) => driver.confidence === "低").length;

  const evidenceKind = new Map(
    evidence
      .filter((item) => typeof item.id === "string")
      .map((item) => [item.id as string, item.kind]),
  );
  // A driver counts as unsupported only when at least one of its citations
  // resolves and every resolvable one is inference. An id that resolves to
  // nothing is a referential-integrity error reported elsewhere; reading it as
  // "unsupported" here would accuse the author of the wrong mistake.
  const unsupported = drivers.filter((driver) => {
    const ids = Array.isArray(driver.evidenceIds) ? driver.evidenceIds : [];
    const kinds = ids
      .map((id) => (typeof id === "string" ? evidenceKind.get(id) : undefined))
      .filter((kind): kind is unknown => kind !== undefined);
    return kinds.length > 0 && kinds.every((kind) => kind === "inference");
  }).length;

  const methodSelection = (snapshot.valuation as { methodSelection?: unknown } | undefined)
    ?.methodSelection as { ideal?: unknown; adoptedPrimary?: unknown } | undefined;

  return {
    unavailableShare: share(unavailable, statusBearing.length),
    inferenceShare: share(inference, evidence.length),
    lowConfidenceDriverShare: share(lowConfidence, drivers.length),
    unsupportedDriverShare: share(unsupported, drivers.length),
    idealMethodBlocked:
      methodSelection?.ideal !== undefined &&
      methodSelection?.adoptedPrimary !== undefined &&
      methodSelection.ideal !== methodSelection.adoptedPrimary,
  };
}

/** The rule inputs, read back from a stored computation. */
export function densityFactsFrom(computed: DensityComputation): DensityFacts {
  const toNumber = (value: string) => Number(value);
  return {
    unavailableShare: toNumber(computed.unavailableShare),
    inferenceShare: toNumber(computed.inferenceShare),
    lowConfidenceDriverShare: toNumber(computed.lowConfidenceDriverShare),
    unsupportedDriverShare: toNumber(computed.unsupportedDriverShare),
    idealMethodBlocked: computed.idealMethodBlocked,
  };
}
