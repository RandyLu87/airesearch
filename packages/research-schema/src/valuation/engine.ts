import Decimal from "decimal.js";

/**
 * Deterministic valuation arithmetic.
 *
 * Everything in here is closed-form: a handful of declared inputs in, a price
 * range out. That is the whole point. Before this module existed the value
 * range was a free-text string that no code ever checked, and the pilot
 * company's three scenarios disagreed with their own stated method by +9.5%,
 * −1.0% and −10.1% respectively — in three different directions, which is what
 * hand-written ranges look like once you actually multiply them out.
 *
 * The author supplies components; the engine supplies the answer. `checkSnapshot`
 * recomputes and rejects any snapshot whose stored result differs, which is how
 * a JSON file gets a read-only field.
 */

export type ValuationComponent = {
  id: string;
  label: string;
  kind: "multiple" | "face-value";
  sign: "add" | "subtract";
  /** `multiple` kind: the metric being multiplied, e.g. normalized net profit. */
  metricLabel?: string;
  metricLow?: string;
  metricHigh?: string;
  multipleLow?: string;
  multipleHigh?: string;
  /** `face-value` kind: a straight amount, e.g. net cash or an investment book. */
  amount?: string;
  /** Percentage haircut applied to this component, 0–100. */
  discountPct?: string;
  discountReason?: string;
  note: string;
};

export type ValuationBasis = {
  /** Reporting currency amount per one unit of trading currency, e.g. 1 HKD = 0.8612 CNY. */
  fx: string;
  /** Share count expressed at the same scale as the component amounts. */
  shares: string;
};

export type BridgeEntry = {
  id: string;
  label: string;
  kind: ValuationComponent["kind"] | "discount";
  /** Reporting-currency contribution at the declared scale. */
  amountLow: string;
  amountHigh: string;
  /** Trading-currency contribution per share. */
  perShareLow: string;
  perShareHigh: string;
};

export type ScenarioComputation = {
  low: string;
  center: string;
  high: string;
  totalLow: string;
  totalHigh: string;
  bridge: BridgeEntry[];
};

const PRICE_DP = 1;
const TOTAL_DP = 2;

function decimal(value: string | undefined, field: string, componentId: string): Decimal {
  if (value === undefined) {
    throw new Error(`估值组件 ${componentId} 缺少 ${field}`);
  }
  return new Decimal(value);
}

/**
 * Interval arithmetic that respects direction: the low bound of a sum uses the
 * low end of every added component and the *high* end of every subtracted one.
 * Getting this backwards silently narrows the range, which is the flattering
 * direction, so it is worth stating explicitly.
 */
function componentBounds(component: ValuationComponent): { low: Decimal; high: Decimal } {
  if (component.kind === "multiple") {
    const metricLow = decimal(component.metricLow, "metricLow", component.id);
    const metricHigh = decimal(component.metricHigh, "metricHigh", component.id);
    const multipleLow = decimal(component.multipleLow, "multipleLow", component.id);
    const multipleHigh = decimal(component.multipleHigh, "multipleHigh", component.id);
    return {
      low: metricLow.times(multipleLow),
      high: metricHigh.times(multipleHigh),
    };
  }
  const amount = decimal(component.amount, "amount", component.id);
  return { low: amount, high: amount };
}

function discountFactor(component: ValuationComponent): Decimal {
  if (component.discountPct === undefined) return new Decimal(1);
  return new Decimal(1).minus(new Decimal(component.discountPct).dividedBy(100));
}

export function computeScenario(
  components: readonly ValuationComponent[],
  basis: ValuationBasis,
): ScenarioComputation {
  const fx = new Decimal(basis.fx);
  const shares = new Decimal(basis.shares);
  if (fx.lessThanOrEqualTo(0)) throw new Error("汇率必须为正数");
  if (shares.lessThanOrEqualTo(0)) throw new Error("股数必须为正数");

  const perShare = (amount: Decimal) => amount.dividedBy(fx).dividedBy(shares);

  let totalLow = new Decimal(0);
  let totalHigh = new Decimal(0);
  const bridge: BridgeEntry[] = [];

  for (const component of components) {
    const bounds = componentBounds(component);
    const factor = discountFactor(component);
    const netLow = bounds.low.times(factor);
    const netHigh = bounds.high.times(factor);
    const direction = component.sign === "subtract" ? -1 : 1;

    // Low total takes the low end of additions and the high end of deductions.
    totalLow = totalLow.plus(
      (component.sign === "subtract" ? netHigh : netLow).times(direction),
    );
    totalHigh = totalHigh.plus(
      (component.sign === "subtract" ? netLow : netHigh).times(direction),
    );

    const grossLow = bounds.low.times(direction);
    const grossHigh = bounds.high.times(direction);
    bridge.push({
      id: component.id,
      label: component.label,
      kind: component.kind,
      amountLow: grossLow.toFixed(TOTAL_DP),
      amountHigh: grossHigh.toFixed(TOTAL_DP),
      perShareLow: perShare(grossLow).toFixed(PRICE_DP),
      perShareHigh: perShare(grossHigh).toFixed(PRICE_DP),
    });

    // A haircut is shown as its own bar so the reader sees what it cost, rather
    // than finding a component whose number quietly disagrees with its label.
    if (component.discountPct !== undefined && !factor.equals(1)) {
      const cutLow = netLow.minus(bounds.low).times(direction);
      const cutHigh = netHigh.minus(bounds.high).times(direction);
      bridge.push({
        id: `${component.id}-discount`,
        label: `${component.label}折价 ${component.discountPct}%`,
        kind: "discount",
        amountLow: cutLow.toFixed(TOTAL_DP),
        amountHigh: cutHigh.toFixed(TOTAL_DP),
        perShareLow: perShare(cutLow).toFixed(PRICE_DP),
        perShareHigh: perShare(cutHigh).toFixed(PRICE_DP),
      });
    }
  }

  const low = perShare(totalLow);
  const high = perShare(totalHigh);
  return {
    low: low.toFixed(PRICE_DP),
    high: high.toFixed(PRICE_DP),
    center: low.plus(high).dividedBy(2).toFixed(PRICE_DP),
    totalLow: totalLow.toFixed(TOTAL_DP),
    totalHigh: totalHigh.toFixed(TOTAL_DP),
    bridge,
  };
}

export type ActionZone = {
  label: string;
  rangeLow: string | null;
  rangeHigh: string | null;
  range: string;
  action: string;
};

const ZONE_LABELS = [
  "深度价值区",
  "基础仓位区",
  "小仓观察区",
  "合理价值区",
  "兑现要求区",
] as const;

export type ZoneAction = { label: string; action: string };

/**
 * Derive the action ladder from the bear and base ranges rather than letting the
 * author list them.
 *
 * Hand-listed zones drift: the pilot company's five zones both overlapped
 * (HK$120–125 belonged to two zones with contradictory instructions) and left a
 * hole (HK$138–145 belonged to none). Boundaries taken from the scenarios in
 * monotonic order cannot do either.
 */
export function deriveActionZones(
  bear: { low: string; high: string },
  base: { low: string; high: string },
  actions: readonly ZoneAction[],
  currency: string,
): ActionZone[] {
  const b1 = new Decimal(bear.low);
  const b2 = Decimal.max(new Decimal(bear.high), b1);
  const b3 = Decimal.max(new Decimal(base.low), b2);
  const b4 = Decimal.max(new Decimal(base.high), b3);

  const actionFor = (label: string) =>
    actions.find((entry) => entry.label === label)?.action ?? "";
  const money = (value: Decimal) => `${currency}${value.toFixed(PRICE_DP)}`;

  const bounds: Array<[string | null, string | null]> = [
    [null, b1.toFixed(PRICE_DP)],
    [b1.toFixed(PRICE_DP), b2.toFixed(PRICE_DP)],
    [b2.toFixed(PRICE_DP), b3.toFixed(PRICE_DP)],
    [b3.toFixed(PRICE_DP), b4.toFixed(PRICE_DP)],
    [b4.toFixed(PRICE_DP), null],
  ];

  return ZONE_LABELS.map((label, index) => {
    const [low, high] = bounds[index];
    const range =
      low === null
        ? `${money(new Decimal(high as string))} 以下`
        : high === null
          ? `${money(new Decimal(low))} 以上`
          : `${money(new Decimal(low))}–${new Decimal(high).toFixed(PRICE_DP)}`;
    return { label, rangeLow: low, rangeHigh: high, range, action: actionFor(label) };
  })
    // A zero-width zone means two scenario bounds coincide; showing it would
    // invite an action instruction for a price that cannot occur.
    .filter((zone) =>
      zone.rangeLow === null ||
      zone.rangeHigh === null ||
      !new Decimal(zone.rangeLow).equals(zone.rangeHigh),
    );
}

export type ImpliedExpectation = {
  /** Market capitalisation in reporting currency at the declared scale. */
  marketCap: string;
  /** Value the market assigns to the multiple-bearing component. */
  operatingValue: string;
  /** Per-share value of everything valued at face value. */
  nonOperatingPerShare: string;
  multipleLow: string | null;
  multipleHigh: string | null;
  /** Null when the base scenario has no single multiple component to solve for. */
  metricLabel: string | null;
};

/**
 * Solve the base scenario backwards: hold every face-value component fixed and
 * ask what multiple the current price implies on the operating business.
 *
 * `metric-playbook.md` already requires stating the market's implied
 * expectation; doing it by hand is where the pilot's `currentExpectation` went
 * wrong (it claimed 11.6x–12.3x where the arithmetic gives 11.0x–11.5x).
 */
export function computeImpliedExpectation(
  components: readonly ValuationComponent[],
  basis: ValuationBasis,
  referencePrice: string,
): ImpliedExpectation {
  const fx = new Decimal(basis.fx);
  const shares = new Decimal(basis.shares);
  const marketCap = new Decimal(referencePrice).times(shares).times(fx);

  let fixed = new Decimal(0);
  const multipleComponents = components.filter((item) => item.kind === "multiple");
  for (const component of components) {
    if (component.kind !== "face-value") continue;
    const amount = decimal(component.amount, "amount", component.id).times(
      discountFactor(component),
    );
    fixed = fixed.plus(component.sign === "subtract" ? amount.negated() : amount);
  }

  const operatingValue = marketCap.minus(fixed);
  const nonOperatingPerShare = fixed.dividedBy(fx).dividedBy(shares);

  if (multipleComponents.length !== 1) {
    return {
      marketCap: marketCap.toFixed(TOTAL_DP),
      operatingValue: operatingValue.toFixed(TOTAL_DP),
      nonOperatingPerShare: nonOperatingPerShare.toFixed(PRICE_DP),
      multipleLow: null,
      multipleHigh: null,
      metricLabel: null,
    };
  }

  const only = multipleComponents[0];
  const metricLow = decimal(only.metricLow, "metricLow", only.id);
  const metricHigh = decimal(only.metricHigh, "metricHigh", only.id);
  return {
    marketCap: marketCap.toFixed(TOTAL_DP),
    operatingValue: operatingValue.toFixed(TOTAL_DP),
    nonOperatingPerShare: nonOperatingPerShare.toFixed(PRICE_DP),
    multipleLow: operatingValue.dividedBy(metricHigh).toFixed(2),
    multipleHigh: operatingValue.dividedBy(metricLow).toFixed(2),
    metricLabel: only.metricLabel ?? only.label,
  };
}

/** Relative gap between an externally computed result and the engine's own. */
export function crossCheckDeviation(external: string, computed: string): string {
  const target = new Decimal(computed);
  if (target.isZero()) return "0.0";
  return new Decimal(external).dividedBy(target).minus(1).times(100).toFixed(1);
}
