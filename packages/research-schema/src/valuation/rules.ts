import Decimal from "decimal.js";
import type { ValuationMethodId } from "./methods.ts";

/**
 * The company facts the health check reasons over.
 *
 * Deliberately a flat, already-derived structure rather than the snapshot
 * itself: every value here is computed once in `deriveHealthFacts`, so a rule
 * is a pure predicate that can be read and argued with on its own. Anything a
 * rule needs but cannot be derived is `null`, and rules must treat `null` as
 * "cannot judge" rather than "false" — a missing number is never evidence that
 * a risk is absent.
 */
export type HealthFacts = {
  /** Net cash as a share of market capitalisation, 0–1. */
  netCashToMarketCap: number | null;
  netDebtToEbitda: number | null;
  /** Consecutive most-recent fiscal years with positive net profit. */
  consecutiveProfitableYears: number;
  latestNetProfitPositive: boolean | null;
  latestFreeCashFlowPositive: boolean | null;
  /** Segment revenue growth signs in the latest comparable pair. */
  segmentGrowthSigns: number[];
  /** Largest segment's share of revenue, 0–1. */
  topSegmentShare: number | null;
  /** (dividends + buybacks) / free cash flow, 0–1. */
  shareholderReturnCoverage: number | null;
  /** Largest single-customer revenue share, 0–1, when disclosed. */
  customerConcentration: number | null;
  /** Free-form industry tags the snapshot declares. */
  industryTags: string[];
};

export type HealthRule = {
  id: string;
  label: string;
  /** What the rule is protecting against, in the author's language. */
  rationale: string;
  /** Methods this rule forbids as the sole primary method. */
  discourages: readonly ValuationMethodId[];
  /** Methods this rule pushes the author towards. */
  recommends: readonly ValuationMethodId[];
  /** Null when the rule does not fire; otherwise the observation that fired it. */
  evaluate: (facts: HealthFacts) => string | null;
};

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export const HEALTH_RULES: readonly HealthRule[] = [
  {
    id: "large-net-cash",
    label: "大额净现金",
    rationale:
      "净现金占市值越高，合并倍数法就越是在用「利息收入 × 倍数」给一笔本该按面值计价的钱定价，系统性错估。",
    discourages: ["multiple-pe"],
    recommends: ["sotp"],
    evaluate: (facts) =>
      facts.netCashToMarketCap !== null && facts.netCashToMarketCap > 0.3
        ? `净现金占市值 ${percent(facts.netCashToMarketCap)}，超过 30% 阈值`
        : null,
  },
  {
    id: "heavy-net-debt",
    label: "净负债偏重",
    rationale: "杠杆高时股权价值对经营波动的敏感度远高于 EBIT，P/E 会掩盖这一点。",
    discourages: ["multiple-pe"],
    recommends: ["multiple-ev-ebit"],
    evaluate: (facts) =>
      facts.netDebtToEbitda !== null && facts.netDebtToEbitda > 3
        ? `净债务/EBITDA 为 ${facts.netDebtToEbitda.toFixed(1)}，超过 3 倍阈值`
        : null,
  },
  {
    id: "short-profit-history",
    label: "盈利历史不足",
    rationale:
      "连续盈利不足三年时，任何单年盈利都不足以代表稳态，单年 P/E 会把周期或修复期的某一点当成中枢。",
    discourages: ["multiple-pe"],
    recommends: ["multiple-ev-sales", "sotp"],
    evaluate: (facts) =>
      facts.consecutiveProfitableYears < 3
        ? `连续盈利年数 ${facts.consecutiveProfitableYears}，少于 3 年`
        : null,
  },
  {
    id: "negative-earnings",
    label: "当期亏损",
    rationale: "分子为负时倍数没有意义。",
    discourages: ["multiple-pe"],
    recommends: ["multiple-ev-sales"],
    evaluate: (facts) =>
      facts.latestNetProfitPositive === false ? "最新期归母净利润为负" : null,
  },
  {
    id: "negative-fcf",
    label: "自由现金流为负",
    rationale: "现金流为负时，以现金流为分母的倍数不可用，且安全边际必须另行论证。",
    discourages: [],
    recommends: ["multiple-ev-sales"],
    evaluate: (facts) =>
      facts.latestFreeCashFlowPositive === false ? "最新期近似自由现金流为负" : null,
  },
  {
    id: "segment-divergence",
    label: "分部走势相反",
    rationale:
      "两个分部一涨一跌时，合并盈利的「正常化」没有经济含义——它把两条方向相反的曲线平均成一条不存在的曲线。",
    discourages: ["multiple-pe"],
    recommends: ["sotp"],
    evaluate: (facts) => {
      const signs = facts.segmentGrowthSigns;
      const hasUp = signs.some((sign) => sign > 0);
      const hasDown = signs.some((sign) => sign < 0);
      return hasUp && hasDown
        ? `${signs.length} 个分部中同时存在增长与萎缩`
        : null;
    },
  },
  {
    id: "single-segment",
    label: "业务高度集中于单一分部",
    rationale: "单一分部占绝对多数时，SOTP 的拆分收益低于它引入的口径复杂度。",
    discourages: ["sotp"],
    recommends: ["multiple-pe"],
    evaluate: (facts) =>
      facts.topSegmentShare !== null && facts.topSegmentShare > 0.85
        ? `最大分部占收入 ${percent(facts.topSegmentShare)}，超过 85%`
        : null,
  },
  {
    id: "weak-shareholder-return",
    label: "股东回报薄弱且现金堆积",
    rationale:
      "现金既不分红也不回购时，它对小股东的现值低于面值；不显式给折价就等于假设管理层会替你把它花好。",
    discourages: [],
    recommends: ["sotp"],
    evaluate: (facts) =>
      facts.shareholderReturnCoverage !== null &&
      facts.shareholderReturnCoverage < 0.1 &&
      facts.netCashToMarketCap !== null &&
      facts.netCashToMarketCap > 0.2
        ? `股东回报覆盖率 ${percent(facts.shareholderReturnCoverage)}，同时净现金占市值 ${percent(facts.netCashToMarketCap)}`
        : null,
  },
  {
    id: "customer-concentration",
    label: "客户集中",
    rationale: "单一客户占比高时，收入的可持续性折价必须进入估值，而不是只写在风险清单里。",
    discourages: [],
    recommends: [],
    evaluate: (facts) =>
      facts.customerConcentration !== null && facts.customerConcentration > 0.1
        ? `单一客户贡献收入 ${percent(facts.customerConcentration)}，超过 10%`
        : null,
  },
  {
    id: "financial-industry",
    label: "金融企业",
    rationale:
      "银行与保险的自由现金流和投入资本口径不适用通用公式；`metric-playbook.md` 明确排除了它们。",
    discourages: ["multiple-ev-ebit", "multiple-ev-sales", "dcf-fcff"],
    recommends: ["multiple-pb", "residual-income"],
    evaluate: (facts) =>
      facts.industryTags.some((tag) => ["银行", "保险", "券商", "信贷"].includes(tag))
        ? `行业标记包含 ${facts.industryTags.join("、")}`
        : null,
  },
  {
    id: "cyclical-industry",
    label: "周期性行业",
    rationale: "用周期顶点或谷底的单年盈利乘以中枢倍数，是周期股最常见的估值错误。",
    discourages: ["multiple-pe"],
    recommends: ["asset-nav"],
    evaluate: (facts) =>
      facts.industryTags.some((tag) => ["资源", "周期", "航运", "化工", "地产"].includes(tag))
        ? `行业标记包含 ${facts.industryTags.join("、")}`
        : null,
  },
];

export const HEALTH_RULE_IDS = HEALTH_RULES.map((rule) => rule.id);

export function lookupHealthRule(ruleId: string): HealthRule | undefined {
  return HEALTH_RULES.find((rule) => rule.id === ruleId);
}

/** Rules whose predicate currently fires for these facts. */
export function triggeredRules(facts: HealthFacts) {
  return HEALTH_RULES.map((rule) => ({ rule, observed: rule.evaluate(facts) }))
    .filter((entry): entry is { rule: HealthRule; observed: string } => entry.observed !== null);
}

export function ratioOrNull(
  numerator: Decimal | null,
  denominator: Decimal | null,
): number | null {
  if (!numerator || !denominator || denominator.isZero()) return null;
  return numerator.dividedBy(denominator).toNumber();
}
