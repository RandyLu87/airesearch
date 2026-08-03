/**
 * The valuation methods this repository knows how to talk about.
 *
 * The registry exists so "which method did you use, and was it the right one?"
 * has a checkable answer instead of living in prose. Each entry records what
 * the method needs, what it is good for, and — most importantly — where it
 * lies. A snapshot names the method it adopted and the method it *wanted*;
 * whatever separates the two becomes the page's "补齐这些数据能升级估值" list.
 *
 * `engineSupport` is deliberately narrow. `docs/research/metric-playbook.md`
 * tells us to avoid 假精确 DCF, so a discounted-cash-flow result is something
 * the author computes elsewhere and the engine only cross-checks. Multiples and
 * sum-of-the-parts are closed-form arithmetic over a handful of inputs, so the
 * engine owns them outright and the author cannot hand-write the answer.
 */
export type ValuationMethodDefinition = {
  label: string;
  family: "内在价值" | "相对估值" | "资产" | "加总" | "反向";
  /** When this method is the best available answer. */
  bestFor: string;
  /** Inputs the method cannot be run without. */
  requires: readonly string[];
  /** Where the method misleads. */
  pitfall: string;
  /**
   * `computed` — the engine derives the value range and the author may not
   * write it. `cross-check` — the author supplies a result from outside and the
   * engine only compares it against the computed methods.
   */
  engineSupport: "computed" | "cross-check";
};

export const VALUATION_METHODS = {
  "multiple-pe": {
    label: "正常化 P/E",
    family: "相对估值",
    bestFor: "盈利稳定、资本结构简单、可比公司充足的公司。",
    requires: ["正常化归母净利润区间", "倍数区间", "摊薄股数", "汇率"],
    pitfall:
      "盈利里混着大额利息收入或一次性项目时，倍数会把非经营资产按盈利能力错误定价；净现金占市值高的公司尤其严重。",
    engineSupport: "computed",
  },
  "multiple-ev-ebit": {
    label: "EV/EBIT",
    family: "相对估值",
    bestFor: "资本结构差异大、需要剥离杠杆影响的公司。",
    requires: ["EBIT 区间", "倍数区间", "净债务", "摊薄股数", "汇率"],
    pitfall: "EBIT 口径中一次性项目与股权激励的处理必须跨期一致。",
    engineSupport: "computed",
  },
  "multiple-ev-sales": {
    label: "EV/Sales",
    family: "相对估值",
    bestFor: "尚未盈利或利润率仍在剧烈变化的早期公司。",
    requires: ["收入区间", "倍数区间", "净债务", "摊薄股数", "汇率"],
    pitfall: "它对终局利润率的假设是隐含的；不写清假设就是把结论藏进倍数里。",
    engineSupport: "computed",
  },
  "multiple-pb": {
    label: "P/B",
    family: "相对估值",
    bestFor: "银行、保险、券商等账面价值有经济含义的公司。",
    requires: ["归母净资产", "倍数区间", "ROE 路径", "摊薄股数", "汇率"],
    pitfall: "必须与 ROE 成对解读；商誉与重估增值会让账面价值脱离可变现价值。",
    engineSupport: "computed",
  },
  sotp: {
    label: "分部加总 SOTP",
    family: "加总",
    bestFor:
      "混合业务、分部走势相反，或存在大额非核心资产（巨额净现金、投资组合、土地）的公司。",
    requires: [
      "各分部经营利润或可估值指标",
      "各分部倍数区间",
      "非核心资产的面值与折价依据",
      "摊薄股数",
      "汇率",
    ],
    pitfall:
      "分部之间的交叉补贴、未分摊总部费用和内部交易若不处理，各部分之和会系统性高于整体。",
    engineSupport: "computed",
  },
  "asset-nav": {
    label: "NAV / RNAV",
    family: "资产",
    bestFor: "控股公司、地产、资源类等价值主要来自可逐项重估资产的公司。",
    requires: ["资产逐项重估值", "负债", "折价依据", "摊薄股数"],
    pitfall: "控股公司折价长期存在，按 100% NAV 估值几乎总是过于乐观。",
    engineSupport: "computed",
  },
  "dcf-fcff": {
    label: "FCFF 折现",
    family: "内在价值",
    bestFor: "现金流可预测、再投资路径清晰的成熟公司。",
    requires: ["多年收入与利润率路径", "税率", "再投资", "WACC", "终值假设"],
    pitfall:
      "输入数量远超可取证范围，容易产生假精确；本仓库只接受它作为交叉验证，不作为主方法。",
    engineSupport: "cross-check",
  },
  "dcf-ddm": {
    label: "股利折现 DDM",
    family: "内在价值",
    bestFor: "分红政策稳定、派息率可预测的成熟公司与金融企业。",
    requires: ["股利路径", "派息率", "股权成本"],
    pitfall: "不分红或分红政策未确立的公司完全不适用。",
    engineSupport: "cross-check",
  },
  "residual-income": {
    label: "剩余收益 RIM",
    family: "内在价值",
    bestFor: "银行等以账面价值为锚、ROE 可预测的公司。",
    requires: ["期初账面价值", "ROE 路径", "股权成本"],
    pitfall: "对股权成本假设极为敏感。",
    engineSupport: "cross-check",
  },
  "reverse-implied": {
    label: "反向估值（当前价隐含预期）",
    family: "反向",
    bestFor: "所有公司，作为对自己结论的反面检验。",
    requires: ["当前参考价格", "摊薄股数", "汇率", "主方法的盈利口径"],
    pitfall: "它回答的是「市场在假设什么」，不是「值多少钱」；不能单独当作估值结论。",
    engineSupport: "computed",
  },
} as const satisfies Record<string, ValuationMethodDefinition>;

export type ValuationMethodId = keyof typeof VALUATION_METHODS;

export const VALUATION_METHOD_IDS = Object.keys(
  VALUATION_METHODS,
) as ValuationMethodId[];

export function lookupValuationMethod(
  methodId: string,
): ValuationMethodDefinition | undefined {
  return (VALUATION_METHODS as Record<string, ValuationMethodDefinition>)[methodId];
}
