import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { hasLedger, loadFinancialLedger } from "../ledger.ts";
import {
  hasCommitmentLedger,
  loadCommitmentLedger,
  materializeCommitmentSummary,
} from "../commitments.ts";
import { buildSkeleton } from "./skeleton.ts";
import {
  assertStamp,
  currentStamp,
  findLatestSnapshot,
  findRepoRoot,
  parseArgs,
  runCli,
  snapshotsDirectory,
  stampToIso,
} from "./shared.ts";

const USAGE = `用法：npm run snapshot:new -- <company-id> [--at YYYY-MM-DD-HHMM] [--stdout] [--root <path>]

从上一份研究快照继承口径，生成新的研究快照骨架。
数值、期间、结论与证据一律写入待办哨兵，必须重新取证。`;

function main(): number {
  const { positionals, flags, values } = parseArgs(process.argv.slice(2));
  if (flags.has("--help")) {
    console.log(USAGE);
    return 0;
  }
  const companyId = positionals[0];
  if (!companyId) {
    console.error(USAGE);
    return 1;
  }

  const root = values.get("--root") ?? findRepoRoot();
  const stamp = assertStamp(values.get("--at") ?? currentStamp());
  const snapshotId = `${stamp}-analysis`;
  const directory = snapshotsDirectory(root, companyId);
  const target = path.join(directory, `${snapshotId}.json`);

  if (!flags.has("--stdout") && existsSync(target)) {
    console.error(
      `研究快照已存在：${target}\n` +
        "同一公司同一天只保留一份研究快照，请直接更新它，不要创建第二份。",
    );
    return 1;
  }

  const latest = findLatestSnapshot(directory);
  // Reported periods come from the ledger already filled in. That is not the
  // "inherit the previous numbers" shortcut the sentinel rule guards against —
  // a closed fiscal year is a disclosed fact, not last run's judgment, and
  // re-sourcing it every time is exactly the waste the ledger exists to end.
  const ledger = hasLedger(root, companyId) ? loadFinancialLedger(root, companyId) : undefined;
  // Same reasoning for the commitment ledger, plus one practical one: a skeleton
  // without the summary trips the checker's "you have a ledger but no summary"
  // error on the very first run, which reads as a defect rather than a to-do.
  const commitmentSummary = hasCommitmentLedger(root, companyId)
    ? materializeCommitmentSummary(loadCommitmentLedger(root, companyId))
    : undefined;
  const skeleton = buildSkeleton({
    companyId,
    snapshotId,
    createdAt: stampToIso(stamp),
    prior: latest?.data,
    ledger,
    commitmentSummary,
  });
  const serialised = `${JSON.stringify(skeleton, null, 2)}\n`;

  if (flags.has("--stdout")) {
    process.stdout.write(serialised);
    return 0;
  }

  mkdirSync(directory, { recursive: true });
  writeFileSync(target, serialised);
  console.log(`已生成研究快照骨架：${target}`);
  console.log(
    latest
      ? `已从 ${latest.stem} 继承口径；所有数值与结论仍是待办哨兵，请逐项取证后填写。`
      : "没有历史研究快照，生成的是空白骨架。",
  );
  console.log(`填写过程中随时运行：npm run snapshot:check -- ${target}`);
  return 0;
}

runCli(main);
