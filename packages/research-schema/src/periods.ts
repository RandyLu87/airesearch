/**
 * Period selection shared by the ledger, the checker and the renderers.
 *
 * Kept free of any schema import so `index.ts` can re-export it without a cycle
 * — `ledger.ts` depends on the schema, these helpers depend on nothing.
 */

export type PeriodType = "fiscal-year" | "half-year" | "quarter" | "month";

const PERIOD_TYPE_RANK: Record<PeriodType, number> = {
  "fiscal-year": 0,
  "half-year": 1,
  quarter: 2,
  month: 3,
};

/** Periods per year for each cadence, used to find the year-ago counterpart. */
export const PERIODS_PER_YEAR: Record<PeriodType, number> = {
  "fiscal-year": 1,
  "half-year": 2,
  quarter: 4,
  month: 12,
};

/**
 * The only accepted spelling for a monthly period: `2026-01`.
 *
 * Every period string in this repository has to sort chronologically under
 * `localeCompare`, because that is how `sortPeriods` and `at(-1)` decide which
 * period is the latest. A month written `2026 M1` breaks that silently — `M1 <
 * M10 < M2` — so the one spelling that cannot misorder is enforced rather than
 * merely documented.
 *
 * Monthly cadence exists for driver metrics only. Monthly operating disclosures
 * (sales volume, output, premiums, monthly revenue) are unaudited and usually
 * outside the accounting standard, so they inform a leading indicator but must
 * never enter the financial period ledger.
 */
export const MONTH_PERIOD_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;

type Periodic = { period: string; periodType: PeriodType };

/** Chronological within a cadence, annual before interim. */
export function sortPeriods<T extends Periodic>(periods: readonly T[]): T[] {
  return [...periods].sort((left, right) => {
    const byType = PERIOD_TYPE_RANK[left.periodType] - PERIOD_TYPE_RANK[right.periodType];
    return byType !== 0 ? byType : left.period.localeCompare(right.period);
  });
}

/** Periods of one cadence, most recent last, optionally capped to the last `limit`. */
export function periodsOfType<T extends Periodic>(
  periods: readonly T[],
  periodType: PeriodType,
  limit?: number,
): T[] {
  const matching = sortPeriods(periods.filter((period) => period.periodType === periodType));
  return limit === undefined ? matching : matching.slice(-limit);
}

/**
 * The latest period of a cadence and the one a year before it.
 *
 * Year-on-year rather than sequential. For a Hong Kong issuer the two most
 * recently published filings are the annual report and the interim — one
 * covering twice the span of the other — and putting those side by side
 * manufactures a collapse out of nothing but period length.
 */
export function yearOnYearPair<T extends Periodic>(
  periods: readonly T[],
  periodType: PeriodType,
): { prior: T; current: T } | null {
  const matching = periodsOfType(periods, periodType);
  const current = matching.at(-1);
  const prior = matching.at(-1 - PERIODS_PER_YEAR[periodType]);
  return current && prior ? { prior, current } : null;
}
