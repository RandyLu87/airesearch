/**
 * Composition props 的类型侧；换算逻辑在 `scripts/report_props.mjs`（Node 侧，带回归测试）。
 * 两边同一份契约，改字段要一起改。
 */

export type SceneKind =
  | 'opening'
  | 'dimension'
  | 'strategy'
  | 'closing'
  /** 详解版：商业模式（收入结构 / 经济特征两屏）与护城河（清单 / 趋势 / 十年之问三屏） */
  | 'business-model'
  | 'moat-overview'
  | 'moat-trend'
  | 'inquiry';

/** 一条字幕：文本取解说词原文，帧号相对分镜起点 */
export type Caption = {
  text: string;
  from: number;
  durationInFrames: number;
};

/** 一个可以随语音点亮的要点；`from` 是念到它的那一帧（相对分镜起点） */
export type Beat = {
  group?: string;
  text?: string;
  sentenceIndex?: number;
  from: number;
};

/**
 * 一个主数字：这一屏最该被记住的那个指标。
 *
 * `value` 已经是画面上要显示的那串字（`1688.38亿元` / `20.28`），模板不做任何换算——
 * 单位换算与口径闸门都在 scripts/visuals.py 一处，这边只负责把字放大。
 */
export type Hero = {
  label: string;
  value: string;
  unit?: string;
  /** 同比等变化量，已带正负号（`-1.2%`） */
  delta?: string;
  deltaNote?: string;
  /** 口径括注（`TTM`）与时点，小字跟在主数字旁边，不能省 */
  note?: string;
};

export type SeriesPoint = {x: string; y: number; label: string};
export type Series = {name: string; points: SeriesPoint[]};
export type DeltaItem = {name: string; valuePct: number; label: string; note?: string};
/** 一条失败路径在「概率 × 影响」上的落点；两轴取值都只有 低/中/高 三档 */
export type RiskCell = {probability: string; impact: string; label: string};

/** 画面上的图。`type` 决定用哪个组件渲染，认不出的 type 整块不画。 */
export type Chart =
  | {type: 'kpi-grid'; items: Hero[]}
  | {type: 'line-series'; series: Series[]; axisUnit: string; zeroBaseline: boolean}
  | {type: 'delta-bars'; items: DeltaItem[]; period?: string}
  | {type: 'range-band'; items: DeltaItem[]}
  /** `omitted` 是落不了格的路径条数，画面上要如实说，不能只画剩下的当作全部 */
  | {type: 'risk-matrix'; cells: RiskCell[]; omitted: number; total: number};

export type Visuals = {hero?: Hero; chart?: Chart};

export type Scene = {
  id: string;
  kind: SceneKind;
  title: string;
  narration: string;
  /** 分镜文案生成器写的结构化字段，按 kind 取用；模板不新增判断也不重算数字 */
  data: Record<string, unknown>;
  /** 由 scripts/visuals.py 从采集数据抽出的图表与主数字；没有就是这一屏没有可画的数 */
  visuals: Visuals | null;
  /** 由 scripts/report_props.mjs 按 TTS 句级边界事件换算，模板只负责按帧号显示 */
  captions: Caption[];
  beats: Beat[];
  from: number;
  durationInFrames: number;
  audioSeconds: number | null;
};

export type RevenueItem = {
  segment?: string;
  /** 统一成中文量级后的金额（`119.28亿元`）；换算在 scripts/amount_format.py */
  revenue?: string;
  /** 换算前的原文（`11928.29百万元CNY`），留着核对用，画面上不显示 */
  revenueRaw?: string;
  sharePct?: string;
  /** 从金额/占比里拆出来的口径括注，显示在业务线名称下方，不进解说词 */
  note?: string;
};
export type MoatType = {type?: string; test?: string; verdict?: string};
export type TrendSide = {
  label?: string;
  direction?: string;
  /** 原报告的全部判断依据；`spokenCount` 之后的那几条本片没念到，画面上压暗显示 */
  points?: string[];
  spokenCount?: number;
  pointsAvailable?: number;
};

export type DimensionRef = {
  id: string;
  title: string;
  /** 信心度原值；`null` 表示原文 unavailable / 缺失，图表走空态 */
  score: number | null;
  scoreLabel: string;
};

export type ReportProps = {
  fps: number;
  companyName: string;
  companyId: string | null;
  dataCutoff: string | null;
  dimensions: DimensionRef[];
  scenes: Scene[];
  /** 拼接后的完整音轨文件名（相对 `--public-dir`）；预览时为 `null` 走无声渲染 */
  audioTrack: string | null;
  totals: {
    durationInFrames: number;
    videoSeconds: number;
    audioSeconds: number;
    sceneCount: number;
  };
};

export type StrategyItem = { condition?: string; action?: string };

export const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

export const strategyItems = (value: unknown): StrategyItem[] =>
  Array.isArray(value) ? value.filter((item): item is StrategyItem => !!item && typeof item === 'object') : [];

/** 数组字段的通用取法：不是数组就当空，元素形状交给各卡片自己 `str()` 兜底。 */
export const objectList = <T,>(value: unknown): T[] =>
  Array.isArray(value) ? value.filter((item): item is T => !!item && typeof item === 'object') : [];

export const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((item) => str(item)).filter((item): item is string => item !== null) : [];

export const trendSide = (value: unknown): TrendSide | null =>
  !!value && typeof value === 'object' ? (value as TrendSide) : null;

/**
 * 「39.31%」→ 0.3931，供条形图取宽度用；认不出来返回 `null` 走空态（只显示原文，不画条）。
 *
 * 只用于画面上条形的长度，屏幕上显示的**始终是原文那串字**——和 DimensionChart 用
 * score 画条、标签写 scoreLabel 是同一个口径：不重算数字，也不拿 0 冒充「没有数据」。
 */
export const shareRatio = (value: unknown): number | null => {
  const text = str(value);
  if (text === null) return null;
  const matched = /-?\d+(\.\d+)?/.exec(text.replace(/,/g, ''));
  if (!matched) return null;
  const parsed = Number(matched[0]) / 100;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(1, parsed) : null;
};
