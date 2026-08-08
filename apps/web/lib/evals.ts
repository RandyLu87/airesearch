import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 评估记录的读取 — 研究流程第 7 步（docs/research/workflow/07-close-and-review.md）。
 *
 * 记录由 docs/research/tools/ 下的工具追加写入 research/evals/：运行事件由校验、
 * 合并、发布三个工具自己写，研究评估记录与缺陷记录由收尾命令写。本模块只读，
 * 在构建时执行——研究评估页因此随每次 npm run publish 自动刷新，不需要任何
 * 额外的触发机制。
 *
 * 文件缺失、为空或有坏行都必须能正常构建：全新克隆与测试夹具都会走到这条路径，
 * 而构建失败会连带打挂整条发布链路。
 */

/** 事实源位置是显式配置点：测试指向临时目录，因此永不读写真实评估记录。 */
export const EVALS_DIR_ENV = "AIRESEARCH_EVALS_DIR";

/** 记录数少于此值时只出台账，不画趋势线——三个点连成的折线传达不了信息。 */
export const TREND_MIN_RECORDS = 10;

export const RATING_FIELDS = ["trust", "insight", "readability", "actionable", "density"] as const;

export const RATING_LABELS: Record<(typeof RATING_FIELDS)[number], string> = {
  trust: "可信",
  insight: "洞察",
  readability: "好读",
  actionable: "可执行",
  density: "密度",
};

export const VS_LAST_LABELS: Record<string, string> = {
  better: "更好",
  same: "差不多",
  worse: "更差",
};

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
export type Json = any;

export type RunRecord = {
  company?: string;
  companyName?: string;
  closedAt?: string;
  dataCutoff?: string;
  skillCommit?: string;
  model?: string;
  machine?: Json;
  rating?: Json;
};

export type DefectRecord = {
  at?: string;
  company?: string;
  step?: string;
  symptom?: string;
  skillCommit?: string;
  status?: string;
};

function repoRoot() {
  return path.resolve(process.cwd(), "../..");
}

export function evalsDir(): string {
  const override = process.env[EVALS_DIR_ENV];
  return override ? path.resolve(override) : path.join(repoRoot(), "research", "evals");
}

/** 读一份 JSONL；文件缺失返回空数组，坏行跳过而不是让构建失败。 */
function readJsonl<T>(filename: string): T[] {
  let raw: string;
  try {
    raw = readFileSync(path.join(evalsDir(), filename), "utf8");
  } catch {
    return [];
  }
  const records: T[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as T);
    } catch {
      continue;
    }
  }
  return records;
}

/** 研究评估记录，最新一次在前。追加式写入，这里只排序不改写。 */
export function listRuns(): RunRecord[] {
  return readJsonl<RunRecord>("runs.jsonl").sort((left, right) =>
    String(right.closedAt ?? "").localeCompare(String(left.closedAt ?? "")),
  );
}

/** 缺陷记录，最新一条在前。 */
export function listDefects(): DefectRecord[] {
  return readJsonl<DefectRecord>("defects.jsonl").sort((left, right) =>
    String(right.at ?? "").localeCompare(String(left.at ?? "")),
  );
}

/** 五项评分的均分；任一项缺失即返回 null，不拿部分维度充数。 */
export function averageRating(run: RunRecord): number | null {
  const values = RATING_FIELDS.map((field) => run.rating?.[field]);
  if (values.some((value) => typeof value !== "number")) return null;
  return values.reduce((sum: number, value: number) => sum + value, 0) / values.length;
}

/** 校验一次通过的比例；没有可判定的记录时返回 null。 */
export function firstPassRate(runs: RunRecord[]): number | null {
  const judged = runs.filter((run) => typeof run.machine?.firstPassValidation === "boolean");
  if (judged.length === 0) return null;
  return judged.filter((run) => run.machine.firstPassValidation).length / judged.length;
}

/** 千分位整数；空值给 —，不用 0 冒充「没花钱」。 */
export function integerText(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString("en-US");
}
