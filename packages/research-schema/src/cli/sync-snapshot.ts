import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  computeImpliedExpectation,
  computeScenario,
  deriveActionZones,
  type ValuationComponent,
} from "../valuation/engine.ts";
import {
  compareLedgerToHistory,
  coverageShortfall,
  hasLedger,
  loadFinancialLedger,
  materializeFinancialHistory,
} from "../ledger.ts";
import { findRepoRoot, parseArgs, runCli } from "./shared.ts";

const USAGE = `用法：npm run snapshot:sync -- <snapshot-path> [--check]

把两类派生数据写回研究快照：
  1. financialHistory —— 从 research/companies/<company>/financials.json 物化；
  2. 估值引擎输出 —— 情景区间、操作区间边界、隐含预期、summary.fairValue。

这些字段都不该手写。--check 只报告差异，不落盘。`;

type Json = Record<string, unknown>;

function currencyPrefix(tradingCurrency: unknown): string {
  return tradingCurrency === "HKD" ? "HK$" : `${String(tradingCurrency)} `;
}

/**
 * Recompute every engine-owned field in place.
 *
 * Best-effort by design: an author runs this mid-draft, when half the snapshot
 * is still placeholders. Anything that cannot be computed yet is reported and
 * left alone rather than throwing away the parts that can.
 */
function syncValuation(snapshot: Json, notes: string[]): void {
  const valuation = snapshot.valuation as Json | undefined;
  const summary = snapshot.summary as Json | undefined;
  if (!valuation || !summary) {
    notes.push("快照缺少 valuation 或 summary，跳过估值同步。");
    return;
  }

  const fx = valuation.fx as Json | undefined;
  const shares = valuation.shares as Json | undefined;
  if (typeof fx?.value !== "string" || typeof shares?.value !== "string") {
    notes.push("valuation.fx.value 或 valuation.shares.value 尚未填写，跳过估值同步。");
    return;
  }
  const basis = { fx: fx.value, shares: shares.value };

  const scenarios = (valuation.scenarios as Json[] | undefined) ?? [];
  const computedByName = new Map<string, { low: string; center: string; high: string }>();

  for (const scenario of scenarios) {
    const components = scenario.components as ValuationComponent[] | undefined;
    if (!Array.isArray(components) || components.length === 0) {
      notes.push(`情景「${String(scenario.name)}」还没有 components，跳过。`);
      continue;
    }
    try {
      const computed = computeScenario(components, basis);
      scenario.computed = computed;
      computedByName.set(String(scenario.name), computed);
      notes.push(
        `情景「${String(scenario.name)}」→ ${computed.low}–${computed.high}（中枢 ${computed.center}）`,
      );
    } catch (error) {
      notes.push(
        `情景「${String(scenario.name)}」无法计算：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const base = computedByName.get("基准");
  const bear = computedByName.get("熊市");

  if (base) {
    const fairValue = summary.fairValue as Json | undefined;
    if (fairValue) {
      fairValue.low = base.low;
      fairValue.center = base.center;
      fairValue.high = base.high;
      notes.push(`summary.fairValue → ${base.low}/${base.center}/${base.high}`);
    }

    const baseScenario = scenarios.find((scenario) => scenario.name === "基准");
    const referencePrice = (summary.referencePrice as Json | undefined)?.value;
    if (baseScenario && typeof referencePrice === "string") {
      try {
        valuation.impliedExpectation = computeImpliedExpectation(
          baseScenario.components as ValuationComponent[],
          basis,
          referencePrice,
        );
        const implied = valuation.impliedExpectation as Json;
        notes.push(
          `隐含预期 → 经营业务 ${String(implied.operatingValue)}，` +
            `隐含倍数 ${String(implied.multipleLow)}x–${String(implied.multipleHigh)}x`,
        );
      } catch (error) {
        notes.push(`隐含预期无法计算：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (base && bear) {
    // Action text is the author's; only the boundaries are derived.
    const existing = ((valuation.actionZones as Json[] | undefined) ?? []).map((zone) => ({
      label: String(zone.label),
      action: typeof zone.action === "string" ? zone.action : "",
    }));
    valuation.actionZones = deriveActionZones(
      bear,
      base,
      existing,
      currencyPrefix(valuation.tradingCurrency),
    ) as unknown as Json[];
    notes.push(`操作区间 → 由熊市与基准区间推导出 ${(valuation.actionZones as Json[]).length} 档`);
  }
}

function syncLedger(snapshot: Json, root: string, notes: string[]): void {
  const companyId = (snapshot.company as Json | undefined)?.id;
  if (typeof companyId !== "string") {
    notes.push("快照缺少 company.id，跳过账本同步。");
    return;
  }
  if (!hasLedger(root, companyId)) {
    notes.push(
      `没有找到 research/companies/${companyId}/financials.json，` +
        `financialHistory 保持原样。新公司请先建账本。`,
    );
    return;
  }
  const ledger = loadFinancialLedger(root, companyId);
  const shortfall = coverageShortfall(ledger);
  if (shortfall) notes.push(`账本覆盖不足：${shortfall}`);

  const materialized = materializeFinancialHistory(ledger);
  const before = compareLedgerToHistory(
    ledger,
    (snapshot.financialHistory as never[]) ?? [],
  );
  snapshot.financialHistory = materialized as unknown as Json[];
  notes.push(
    before.length === 0
      ? `financialHistory 与账本已一致（${materialized.length} 期）`
      : `financialHistory ← 账本重新物化（${materialized.length} 期）`,
  );
}

function main(): number {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  if (flags.has("--help") || positionals.length === 0) {
    console.log(USAGE);
    return positionals.length === 0 && !flags.has("--help") ? 1 : 0;
  }

  const root = findRepoRoot();
  const filePath = path.resolve(positionals[0]);
  const original = readFileSync(filePath, "utf8");
  const snapshot = JSON.parse(original) as Json;

  const notes: string[] = [];
  syncLedger(snapshot, root, notes);
  syncValuation(snapshot, notes);

  const updated = `${JSON.stringify(snapshot, null, 2)}\n`;
  const changed = updated !== original;

  for (const note of notes) console.log(`- ${note}`);

  if (flags.has("--check")) {
    console.log(changed ? "派生字段与源数据不一致，运行不带 --check 的同步。" : "派生字段已是最新。");
    return changed ? 1 : 0;
  }

  if (changed) {
    writeFileSync(filePath, updated);
    console.log(`已更新 ${path.relative(root, filePath)}`);
  } else {
    console.log("无需改动。");
  }
  return 0;
}

runCli(main);
