import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { financialValueSchema, type CommitmentSummary } from "./index.ts";

/**
 * The per-company management commitment ledger.
 *
 * Every governance mechanism the repository had was a cross-section: `red-flags`
 * looks at this period's buyback price, `metric-playbook` at this period's payout
 * coverage, `sections` at this period's judgment. "Did management do what it said
 * three years ago" had no observation tool at all, because it cannot be read off
 * any single period — it only accumulates.
 *
 * Same shape as the financial period ledger, so it gets the same treatment
 * (ADR-0014, ADR-0019): expensive to gather, immutable once gathered, fetched
 * once and reused. A promise made on a Q4 call may not settle for two years, so
 * a snapshot field would mean re-transcribing three years of history every run —
 * and the real outcome of that is an author who writes down only the most recent
 * one, which accumulates nothing.
 *
 * It is deliberately *not* `checkpoints`. A checkpoint is a threshold the
 * researcher sets and may revise at will; a commitment is a record of what the
 * company said, and rewriting it destroys the only thing the record is for. Two
 * objects with different mutability are two objects.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const dateString = z.string().regex(DATE, "日期必须是 YYYY-MM-DD");

/** No time limit given is information; do not invent one on management's behalf. */
export const NO_DEADLINE = "未给时限";

const commitmentEvidenceSchema = z.object({
  title: z.string().min(1),
  publisher: z.string().min(1),
  url: z.url(),
  retrievedAt: z.iso.datetime({ offset: true }),
  caveat: z.string().min(1).optional(),
});

/**
 * One thing management said, or one thing management did with the money.
 *
 * Both live in one ledger under a `kind` discriminator because they are the same
 * kind of fact — a management action whose verdict arrives later — and splitting
 * them would mean two files that must be read together to answer one question.
 */
export const commitmentEntrySchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["承诺", "并购", "回购", "分红", "新业务投入"]),
  statedAt: dateString,
  venue: z.enum(["年报", "中报", "业绩发布会", "股东信", "公开采访", "公告"]),
  /** Verbatim. Paraphrasing silently adds or drops the qualifier that settles it. */
  quote: z.string().min(1),
  /** The decidable content. 「持续提升股东回报」is not decidable and is not recorded. */
  commitment: z.string().min(1),
  dueBy: z.union([dateString, z.literal(NO_DEADLINE)]),
  status: z.enum(["兑现", "部分兑现", "未兑现", "待到期", "已撤回"]),
  resolvedAt: dateString.optional(),
  /** Why it settled that way. A bare status word is not a settlement. */
  outcome: z.string().min(1).optional(),
  amount: financialValueSchema.optional(),
  /** The valuation the action was taken at — what makes buyback timing checkable. */
  valuationAtTime: z.string().min(1).optional(),
  returnAssessment: z.string().min(1).optional(),
  evidence: z.array(commitmentEvidenceSchema).min(1),
}).superRefine((entry, context) => {
  const settled = entry.status !== "待到期";
  if (settled && !entry.resolvedAt) {
    context.addIssue({
      code: "custom",
      path: ["resolvedAt"],
      message: `状态为「${entry.status}」的条目必须写 resolvedAt`,
    });
  }
  if (settled && !entry.outcome) {
    context.addIssue({
      code: "custom",
      path: ["outcome"],
      message:
        `状态为「${entry.status}」的条目必须写 outcome 说明结算依据。` +
        `status 的判定本身是判断，只写一个状态字不合格。`,
    });
  }
  if (!settled && (entry.resolvedAt || entry.outcome)) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "待到期条目不应有 resolvedAt 或 outcome；已经结算就改 status",
    });
  }
  if (entry.kind === "并购" || entry.kind === "回购") {
    if (!entry.amount) {
      context.addIssue({ code: "custom", path: ["amount"], message: `${entry.kind}必须记录金额` });
    }
    if (!entry.valuationAtTime) {
      context.addIssue({
        code: "custom",
        path: ["valuationAtTime"],
        message:
          `${entry.kind}必须记录当时的估值口径。留下当时的估值坐标，` +
          `才能把「回购发生在明显高估区」从印象变成可复算的记录。`,
      });
    }
  }
});

export const commitmentLedgerSchema = z.object({
  ledgerVersion: z.literal("1.0.0"),
  companyId: z.string().min(1),
  /**
   * Where the record starts. Required even on an empty ledger, because "this
   * company made no commitments" and "nobody looked" must be distinguishable,
   * and only an explicit coverage start can say which one it is.
   */
  coverageFrom: dateString,
  entries: z.array(commitmentEntrySchema),
}).superRefine((ledger, context) => {
  const seen = new Set<string>();
  for (const entry of ledger.entries) {
    if (seen.has(entry.id)) {
      context.addIssue({ code: "custom", message: `重复的承诺台账 id：${entry.id}` });
    }
    seen.add(entry.id);
  }
});

export type CommitmentLedger = z.infer<typeof commitmentLedgerSchema>;
export type CommitmentEntry = z.infer<typeof commitmentEntrySchema>;

export const COMMITMENT_STATUSES = ["兑现", "部分兑现", "未兑现", "待到期", "已撤回"] as const;
const CAPITAL_KINDS = ["并购", "回购", "分红", "新业务投入"] as const;

export function commitmentLedgerPathForCompanyDir(companyDirectory: string): string {
  return path.join(companyDirectory, "commitments.json");
}

export function commitmentLedgerPath(repoRoot: string, companyId: string): string {
  return commitmentLedgerPathForCompanyDir(
    path.join(repoRoot, "research", "companies", companyId),
  );
}

export function hasCommitmentLedger(repoRoot: string, companyId: string): boolean {
  return existsSync(commitmentLedgerPath(repoRoot, companyId));
}

export function loadCommitmentLedgerAt(filePath: string, companyId: string): CommitmentLedger {
  const parsed = commitmentLedgerSchema.safeParse(
    JSON.parse(readFileSync(filePath, "utf8")),
  );
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("；");
    throw new Error(`承诺台账不合法（${filePath}）：${detail}`);
  }
  if (parsed.data.companyId !== companyId) {
    throw new Error(
      `承诺台账的 companyId（${parsed.data.companyId}）与目录名（${companyId}）不一致。`,
    );
  }
  return parsed.data;
}

export function loadCommitmentLedger(repoRoot: string, companyId: string): CommitmentLedger {
  return loadCommitmentLedgerAt(commitmentLedgerPath(repoRoot, companyId), companyId);
}

/** Stable order, so the materialised summary compares byte for byte. */
function ordered(entries: readonly CommitmentEntry[]): CommitmentEntry[] {
  return [...entries].sort(
    (left, right) =>
      left.statedAt.localeCompare(right.statedAt) || left.id.localeCompare(right.id),
  );
}

/**
 * The governance summary a snapshot embeds.
 *
 * Counts and lists only. A delivery *rate* mapped onto grades — ">80% 优秀,
 * <40% 不可信赖" — reads like a rating while its denominator depends entirely on
 * which promises were recorded, so it can be improved by writing down fewer soft
 * ones. The count is a fact; the grade would be a fact-shaped judgment.
 */
export function materializeCommitmentSummary(ledger: CommitmentLedger): CommitmentSummary {
  const entries = ordered(ledger.entries);
  const counts = Object.fromEntries(
    COMMITMENT_STATUSES.map((status) => [
      status,
      entries.filter((entry) => entry.status === status).length,
    ]),
  ) as CommitmentSummary["counts"];

  const outstanding = entries
    .filter((entry) => entry.status === "未兑现" || entry.status === "部分兑现")
    .map((entry) => ({
      id: entry.id,
      commitment: entry.commitment,
      dueBy: entry.dueBy,
      status: entry.status,
    }));

  const resolved = entries
    .filter((entry) => entry.resolvedAt !== undefined)
    .sort((left, right) => (left.resolvedAt ?? "").localeCompare(right.resolvedAt ?? ""));
  const last = resolved.at(-1);

  const capitalAllocation = entries
    .filter((entry) => CAPITAL_KINDS.some((kind) => kind === entry.kind))
    .map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      statedAt: entry.statedAt,
      commitment: entry.commitment,
      status: entry.status,
      ...(entry.amount === undefined ? {} : { amount: entry.amount }),
      ...(entry.valuationAtTime === undefined ? {} : { valuationAtTime: entry.valuationAtTime }),
      ...(entry.returnAssessment === undefined ? {} : { returnAssessment: entry.returnAssessment }),
    }));

  return {
    coverageFrom: ledger.coverageFrom,
    counts,
    outstanding,
    latestResolution: last
      ? {
          id: last.id,
          commitment: last.commitment,
          status: last.status,
          resolvedAt: last.resolvedAt as string,
        }
      : null,
    capitalAllocation,
  };
}

/**
 * Drift between a snapshot's embedded summary and the ledger.
 *
 * Serialised comparison, same reasoning as the financial ledger: the summary is
 * meant to be a verbatim materialisation, so any difference at all is drift, and
 * a hand-written field list would quietly stop covering fields added later.
 */
export function compareCommitmentLedgerToSummary(
  ledger: CommitmentLedger,
  summary: unknown,
): string[] {
  const expected = materializeCommitmentSummary(ledger);
  if (JSON.stringify(expected) !== JSON.stringify(summary)) {
    return [
      "commitmentSummary 与 commitments.json 不一致；" +
        "运行 npm run snapshot:sync 重新物化，不要手改这个块。",
    ];
  }
  return [];
}
