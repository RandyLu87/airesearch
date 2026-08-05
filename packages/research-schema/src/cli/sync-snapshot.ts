import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  computeImpliedExpectation,
  computeMarketCap,
  computeScenario,
  type ValuationComponent,
} from "../valuation/engine.ts";
import {
  compareLedgerToHistory,
  coverageShortfall,
  hasLedger,
  loadFinancialLedger,
  materializeFinancialHistory,
} from "../ledger.ts";
import { computeEvidenceDensity } from "../density.ts";
import {
  hasCommitmentLedger,
  loadCommitmentLedger,
  materializeCommitmentSummary,
} from "../commitments.ts";
import { findRepoRoot, parseArgs, runCli } from "./shared.ts";

const USAGE = `用法：npm run snapshot:sync -- <snapshot-path> [--check]

把四类派生数据写回研究快照：
  1. financialHistory —— 从 research/companies/<company>/financials.json 物化；
  2. commitmentSummary —— 从 commitments.json 物化；
  3. 估值引擎输出 —— 每一组假设集的价值区间与价格隐含、summary.marketCap；
  4. 证据密度统计 —— 缺失值、推断与低置信度驱动的占比。

这些字段都不该手写。--check 只报告差异，不落盘。`;

type Json = Record<string, unknown>;

/**
 * Recompute every engine-owned field in place.
 *
 * Best-effort by design: an author runs this mid-draft, when half the snapshot
 * is still placeholders. Anything that cannot be computed yet is reported and
 * left alone rather than throwing away the parts that can.
 *
 * What this no longer writes: `summary.fairValue` and `valuation.actionZones`.
 * Neither exists under 1.2.0 — the first was a conclusion and the second was a
 * buy/sell ladder. What it writes instead is one computation per attributed
 * assumption set plus the market capitalisation the page now opens with.
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
  const referencePrice = (summary.referencePrice as Json | undefined)?.value;

  const marketCap = summary.marketCap as Json | undefined;
  if (marketCap && typeof referencePrice === "string") {
    try {
      marketCap.value = computeMarketCap(basis, referencePrice);
      marketCap.currency = valuation.currency;
      marketCap.scale = valuation.valueScale;
      marketCap.asOf = (summary.referencePrice as Json).asOf;
      notes.push(
        `summary.marketCap → ${String(marketCap.value)} ` +
          `${String(marketCap.currency)}（${String(marketCap.scale)}）`,
      );
    } catch (error) {
      notes.push(`市值无法计算：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const assumptionSets = (valuation.assumptionSets as Json[] | undefined) ?? [];
  if (assumptionSets.length === 0) {
    notes.push("valuation.assumptionSets 为空，跳过逐组估值同步。");
    return;
  }

  for (const set of assumptionSets) {
    const label = String(set.id);
    if (set.status === "unavailable") {
      notes.push(`假设集「${label}」标为 unavailable，不参与计算。`);
      continue;
    }
    const components = set.components as ValuationComponent[] | undefined;
    if (!Array.isArray(components) || components.length === 0) {
      notes.push(`假设集「${label}」还没有 components，跳过。`);
      continue;
    }
    try {
      const computed = computeScenario(components, basis);
      set.computed = computed;
      notes.push(`假设集「${label}」→ ${computed.low}–${computed.high}（中枢 ${computed.center}）`);
    } catch (error) {
      notes.push(
        `假设集「${label}」无法计算：${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (typeof referencePrice !== "string") continue;
    try {
      const implied = computeImpliedExpectation(components, basis, referencePrice);
      set.impliedExpectation = implied;
      notes.push(
        `假设集「${label}」价格隐含 → 经营业务 ${implied.operatingValue}，` +
          `隐含倍数 ${String(implied.multipleLow)}x–${String(implied.multipleHigh)}x`,
      );
    } catch (error) {
      notes.push(
        `假设集「${label}」的价格隐含无法计算：` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function syncCommitments(snapshot: Json, root: string, notes: string[]): void {
  const companyId = (snapshot.company as Json | undefined)?.id;
  if (typeof companyId !== "string") {
    notes.push("快照缺少 company.id，跳过承诺台账同步。");
    return;
  }
  if (!hasCommitmentLedger(root, companyId)) {
    notes.push(
      `没有找到 research/companies/${companyId}/commitments.json，` +
        `commitmentSummary 保持原样。首次建账覆盖最近三年。`,
    );
    return;
  }
  const ledger = loadCommitmentLedger(root, companyId);
  snapshot.commitmentSummary = materializeCommitmentSummary(ledger) as unknown as Json;
  const summary = snapshot.commitmentSummary as { outstanding: unknown[] };
  notes.push(
    `commitmentSummary ← 台账物化（${ledger.entries.length} 条，` +
      `其中未结清 ${summary.outstanding.length} 条，覆盖自 ${ledger.coverageFrom}）`,
  );
}

/**
 * Restate the density statistics from the snapshot's own contents.
 *
 * Only when the block already exists. Adding it to a snapshot that predates
 * ADR-0020 would compute an honest number and then demand answers nobody wrote
 * at the time, which is precisely the back-fill that ADR forbids.
 */
function syncEvidenceDensity(snapshot: Json, notes: string[]): void {
  const block = snapshot.evidenceDensity as Json | undefined;
  if (!block) {
    notes.push("快照没有 evidenceDensity 块（ADR-0020 之前的快照如此），跳过证据密度同步。");
    return;
  }
  const computed = computeEvidenceDensity(snapshot);
  block.computed = computed as unknown as Json;
  notes.push(
    `证据密度 → 缺失 ${computed.unavailableShare}、推断 ${computed.inferenceShare}、` +
      `低置信驱动 ${computed.lowConfidenceDriverShare}、无实证驱动 ${computed.unsupportedDriverShare}`,
  );
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
  syncCommitments(snapshot, root, notes);
  syncValuation(snapshot, notes);
  // Last: the density statistics count what the steps above may have just
  // materialised, so they have to be computed against the final contents.
  syncEvidenceDensity(snapshot, notes);

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
