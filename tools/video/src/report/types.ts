/**
 * Composition props 的类型侧；换算逻辑在 `scripts/report_props.mjs`（Node 侧，带回归测试）。
 * 两边同一份契约，改字段要一起改。
 */

export type SceneKind = 'opening' | 'dimension' | 'strategy' | 'closing';

export type Scene = {
  id: string;
  kind: SceneKind;
  title: string;
  narration: string;
  /** 分镜文案生成器写的结构化字段，按 kind 取用；模板不新增判断也不重算数字 */
  data: Record<string, unknown>;
  from: number;
  durationInFrames: number;
  audioSeconds: number | null;
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
