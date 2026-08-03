import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { financialPeriodSchema } from "./index.ts";
import { periodsOfType, sortPeriods } from "./periods.ts";

/**
 * The per-company financial period ledger.
 *
 * Reported periods are immutable facts: FY2023 revenue does not change because
 * we opened the file again. Re-deriving them on every research run is pure
 * waste, and for Hong Kong issuers it is not even automatable — there is no
 * free structured source, so the numbers are lifted from HKEXnews PDFs by hand.
 * Losing that work to a cache sweep is the specific failure this file exists to
 * prevent, which is why it is committed rather than left under `tmp/`.
 *
 * The ledger is not a second source of truth. A snapshot still embeds its own
 * `financialHistory` so it stays self-contained and hashable — ADR-0006 and
 * ADR-0009 depend on that — and `snapshot:check` rejects any drift between the
 * two. The ledger's job is that the numbers are fetched once.
 *
 * Restatements are the reason the consistency check only governs a company's
 * *current* snapshot. When an issuer restates FY2023, the ledger moves and the
 * next snapshot picks the new figure up; the dated snapshots already published
 * keep the number they were written against, because ADR-0002 makes those
 * records immutable.
 */
export const financialLedgerSchema = z.object({
  ledgerVersion: z.literal("1.0.0"),
  companyId: z.string().min(1),
  reportingCurrency: z.string().min(1),
  /**
   * Minimum coverage a newly researched company must reach before it can be
   * published. Two years is what the company page (one same-basis comparison)
   * and the report page (two years of periods) actually consume.
   */
  minimumYears: z.literal(2),
  periods: z.array(financialPeriodSchema).min(2),
});

export type FinancialLedger = z.infer<typeof financialLedgerSchema>;
export type LedgerPeriod = FinancialLedger["periods"][number];

/** The ledger beside a company's `snapshots/` directory. */
export function ledgerPathForCompanyDir(companyDirectory: string): string {
  return path.join(companyDirectory, "financials.json");
}

export function ledgerPath(repoRoot: string, companyId: string): string {
  return ledgerPathForCompanyDir(
    path.join(repoRoot, "research", "companies", companyId),
  );
}

export function hasLedger(repoRoot: string, companyId: string): boolean {
  return existsSync(ledgerPath(repoRoot, companyId));
}

export function loadLedgerAt(filePath: string, companyId: string): FinancialLedger {
  const parsed = financialLedgerSchema.safeParse(
    JSON.parse(readFileSync(filePath, "utf8")),
  );
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("；");
    throw new Error(`财报账本不合法（${filePath}）：${detail}`);
  }
  if (parsed.data.companyId !== companyId) {
    throw new Error(
      `财报账本的 companyId（${parsed.data.companyId}）与目录名（${companyId}）不一致。`,
    );
  }
  return parsed.data;
}

export function loadFinancialLedger(repoRoot: string, companyId: string): FinancialLedger {
  return loadLedgerAt(ledgerPath(repoRoot, companyId), companyId);
}

/**
 * The `financialHistory` a snapshot must carry: every ledger period, in a
 * stable order. Selecting a subset here would mean the snapshot and the ledger
 * disagree by design, and the checker could no longer tell a deliberate subset
 * from a stale copy.
 */
export function materializeFinancialHistory(ledger: FinancialLedger): LedgerPeriod[] {
  return sortPeriods(ledger.periods);
}

/**
 * Differences between a snapshot's embedded history and the ledger, as messages.
 *
 * Compares the serialised form rather than field by field: the snapshot is
 * supposed to be a verbatim copy, so any difference at all is drift, and a
 * hand-written field list would silently stop covering fields added later.
 */
export function compareLedgerToHistory(
  ledger: FinancialLedger,
  history: readonly LedgerPeriod[],
): string[] {
  const expected = materializeFinancialHistory(ledger);
  const errors: string[] = [];

  const expectedKeys = expected.map((period) => `${period.periodType}:${period.period}`);
  const actualKeys = history.map((period) => `${period.periodType}:${period.period}`);
  if (expectedKeys.join("|") !== actualKeys.join("|")) {
    errors.push(
      `financialHistory 的期间集合与 financials.json 不一致：` +
        `账本为 [${expectedKeys.join(", ")}]，快照为 [${actualKeys.join(", ")}]。` +
        `运行 npm run snapshot:sync 重新物化，不要手改 financialHistory。`,
    );
    return errors;
  }

  for (const [index, period] of expected.entries()) {
    if (JSON.stringify(period) !== JSON.stringify(history[index])) {
      errors.push(
        `financialHistory 的 ${period.period} 与 financials.json 中的同期数据不一致；` +
          `运行 npm run snapshot:sync 重新物化。`,
      );
    }
  }
  return errors;
}

/** Whether the ledger covers the minimum span a publishable company needs. */
export function coverageShortfall(ledger: FinancialLedger): string | null {
  const annual = periodsOfType(ledger.periods, "fiscal-year");
  if (annual.length < ledger.minimumYears) {
    return (
      `财报账本只有 ${annual.length} 个完整年度，低于最低要求 ${ledger.minimumYears} 个。` +
      `上市不足两年的公司请补齐自上市以来的全部年度。`
    );
  }
  return null;
}
