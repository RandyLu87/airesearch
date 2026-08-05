import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * financials-final.json 的发现与读取 — 研究流程第 5/6 步共用
 * （docs/research/workflow/05-render-site.md、06-update-home.md）。
 *
 * 该文件由 docs/research/tools/build_final.py 在三份产出全部通过完整性校验后
 * 生成，所以这里读到什么信什么，不再做校验。
 */

export const FINAL_FILENAME = "financials-final.json";

export function repoRoot() {
  return path.resolve(process.cwd(), "../..");
}

export function finalPath(company: string) {
  return path.join(repoRoot(), "research", "companies", company, FINAL_FILENAME);
}

/** financials—final-template.json 契约的数据；渲染层按需取字段，缺失如实显示。 */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
export type FinalReport = any;

export function loadFinal(company: string): FinalReport {
  return JSON.parse(readFileSync(finalPath(company), "utf8"));
}

/** 所有带 financials-final.json 的公司目录——分析页与首页卡片都由此派生。 */
export function listFinalCompanies(): string[] {
  const companiesDir = path.join(repoRoot(), "research", "companies");
  if (!existsSync(companiesDir)) return [];
  return readdirSync(companiesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(finalPath(entry.name)))
    .map((entry) => entry.name);
}
