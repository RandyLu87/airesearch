/**
 * The repository-wide meaning of every standard metric.
 *
 * `CONTEXT.md` defines a 标准指标 as one with "稳定标识和统一含义" — a meaning
 * that holds across companies so the metric can be compared between them. A
 * per-snapshot definition field would let two companies disagree about what
 * `gross-margin` means, which is exactly the property the concept exists to
 * rule out. So the definition lives here, once, and the snapshot only records
 * the observation.
 *
 * This is the machine-readable form of the formulas in
 * `docs/research/metric-playbook.md`. When the two disagree, this file wins and
 * the playbook is the one that needs fixing.
 *
 * `pitfall` is not decoration. Several of these metrics are actively wrong for
 * some industries — `metric-playbook.md` says banks do not get a normal FCF and
 * financial firms do not get the NOPAT formula — and a reader looking at a bank
 * page needs to be told that where the number is, not in a document they will
 * never open. A snapshot may append company-specific wording through
 * `standardMetrics[].definitionNote`, but it can never overwrite what is here.
 */
export type StandardMetricDefinition = {
  /** Display label; the snapshot's own `label` must match it. */
  label: string;
  /** What the number is, in one sentence. */
  definition: string;
  /** How it is computed, in the playbook's notation. */
  formula: string;
  /** Why a long-term owner should care. */
  why: string;
  /** Where this metric misleads, if anywhere. */
  pitfall?: string;
};

export const STANDARD_METRIC_DICTIONARY = {
  revenue: {
    label: "收入",
    definition: "本期确认的营业收入合计。",
    formula: "利润表营业收入合计",
    why: "所有驱动最终必须回接到它；驱动改善而收入不动，说明因果链断在中间。",
    pitfall: "总额法与净额法口径不同的平台不可直接比较收入规模。",
  },
  "revenue-growth": {
    label: "收入增速",
    definition: "本期收入相对上一可比期间的变化率。",
    formula: "(本期收入 ÷ 上期收入 − 1) × 100%",
    why: "区分「量、价、组合」贡献的入口；单看增速无法判断增长质量。",
    pitfall: "并购、处置、汇率和会计口径变化都会污染增速，需分别列示。",
  },
  "gross-margin": {
    label: "毛利率",
    definition: "毛利占收入的比重。",
    formula: "(收入 − 销售成本) ÷ 收入 × 100%",
    why: "定价权与单位成本曲线的直接读数；规模扩大时它是否抬升决定飞轮是否成立。",
    pitfall: "销售成本包含哪些项目各公司不同；跨公司比较前先核对成本构成。",
  },
  "operating-profit": {
    label: "经营利润",
    definition: "扣除销售、管理、研发等期间费用后的经营性利润。",
    formula: "毛利 − 销售费用 − 管理费用 − 研发费用 ± 其他经营损益",
    why: "把毛利改善与费用纪律分开看，避免用一次性项目掩盖经营质量。",
    pitfall: "股权激励和一次性项目是否计入各公司披露不一致。",
  },
  "operating-margin": {
    label: "经营利润率",
    definition: "经营利润占收入的比重。",
    formula: "经营利润 ÷ 收入 × 100%",
    why: "衡量固定成本吸收程度；收入停滞而它上升说明利润来自效率而非增长。",
  },
  "net-profit": {
    label: "净利润",
    definition: "归属母公司股东的当期净利润。",
    formula: "利润表归母净利润",
    why: "股东实际分得的会计利润，估值倍数的常用分母。",
    pitfall: "递延税项、公允价值变动和投资收益都可能让它大幅偏离现金；必须与经营现金流对账。",
  },
  "operating-cash-flow": {
    label: "经营现金流",
    definition: "经营活动产生的现金流量净额。",
    formula: "现金流量表经营活动现金流量净额",
    why: "利润可以被应收账款和资本化美化，这个数字很难。",
  },
  "free-cash-flow": {
    label: "近似自由现金流",
    definition: "扣除维持与扩张性资本投入后可供分配的现金。",
    formula: "经营现金流 − PPE 现金购置 − 资本化开发/无形资产现金投入",
    why: "股东回报、再投资和降杠杆的真实来源。",
    pitfall: "银行、保险等金融企业不适用这个通式，需改用监管资本口径。",
  },
  "net-cash": {
    label: "净现金",
    definition: "可随时动用的现金类资产扣除有息债务后的净额。",
    formula: "现金及现金等价物 + 可随时动用定期存款 − 有息债务",
    why: "决定安全边际，也决定这笔钱在估值里该按面值还是按盈利能力计价。",
    pitfall: "受限现金必须单列，不默认等同可用现金；净现金在估值中只能计入一次。",
  },
  roic: {
    label: "ROIC",
    definition: "税后经营利润相对平均投入资本的回报率。",
    formula: "NOPAT ÷ 平均投入资本；NOPAT ≈ 经营利润 × (1 − 规范化现金税率)",
    why: "判断这门生意本身是否创造价值，与资本结构无关。",
    pitfall: "投入资本是否含商誉、资本化研发和租赁负债必须跨期一致；金融企业不适用。",
  },
  "incremental-roic": {
    label: "增量 ROIC",
    definition: "新投入资本产生的边际回报率。",
    formula: "ΔNOPAT ÷ Δ投入资本，优先取 3–5 年累计变化",
    why: "决定「增长是否值得」；增量回报低于资本成本时，增长在毁灭价值。",
    pitfall: "分母过小、为负或处在建设期时会产生假精确，应给区间而非点值。",
  },
  "diluted-shares": {
    label: "摊薄股数",
    definition: "计入潜在稀释后的期末股份总数。",
    formula: "基本股数 + 期权、限制性股票及可转换工具的潜在稀释份额",
    why: "每股价值的分母；股权激励长期摊薄会悄悄吃掉每股收益增长。",
    pitfall: "库存股、未归属份额和不同类别股份的处理各家不同。",
  },
  "book-value": {
    label: "净资产",
    definition: "归属母公司股东的账面权益。",
    formula: "资产总额 − 负债总额 − 少数股东权益",
    why: "银行、保险和重资产企业的估值锚；这类公司的 ROE 与 P/B 必须成对解读。",
    pitfall: "商誉与重估增值会让账面价值脱离可变现价值。",
  },
  "shareholder-return-coverage": {
    label: "股东回报覆盖率",
    definition: "现金分红与净回购合计占自由现金流的比重。",
    formula: "(股息 + 净回购) ÷ 近似自由现金流 × 100%",
    why: "现金究竟回到股东手里，还是停在账上由管理层保管，决定这笔钱对小股东的现值。",
    pitfall: "超过 100% 时要检查是否在动用净现金或借款派息，是否可持续。",
  },
  "customer-concentration": {
    label: "最大客户收入占比",
    definition: "单一最大外部客户贡献的收入占总收入的比重。",
    formula: "最大单一客户收入 ÷ 总收入 × 100%",
    why: "集中度高时收入的可持续性折价必须进入估值，而不是只写在风险清单里。",
    pitfall: "同一集团下的多个主体可能被分别披露，需按最终控制方合并。",
  },
  ebit: {
    label: "EBIT",
    definition: "扣除利息与所得税前的经营利润。",
    formula: "经营利润（必要时加回非经营性损益）",
    why: "跨资本结构比较盈利能力时的分子，配合 EV 使用。",
  },
} as const satisfies Record<string, StandardMetricDefinition>;

export type StandardMetricId = keyof typeof STANDARD_METRIC_DICTIONARY;

export const STANDARD_METRIC_IDS = Object.keys(
  STANDARD_METRIC_DICTIONARY,
) as StandardMetricId[];

export function lookupStandardMetric(
  metricId: string,
): StandardMetricDefinition | undefined {
  return (STANDARD_METRIC_DICTIONARY as Record<string, StandardMetricDefinition>)[
    metricId
  ];
}
