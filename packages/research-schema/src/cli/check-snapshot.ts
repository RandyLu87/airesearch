import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { checkSnapshotFile, type CheckResult } from "./check.ts";
import { companiesDirectory, findRepoRoot, parseArgs, runCli } from "./shared.ts";

const USAGE = `用法：npm run snapshot:check -- <path> [--json]
      npm run snapshot:check -- --all [--root <path>] [--json]

三层校验：待办哨兵 → schema → 与上一份研究快照的可比性。
--json 输出机器可读结果并始终以 0 退出，供 Stop hook 调用。`;

function collectSnapshotPaths(root: string): string[] {
  const companies = companiesDirectory(root);
  if (!existsSync(companies)) return [];
  const paths: string[] = [];
  for (const company of readdirSync(companies, { withFileTypes: true })) {
    if (!company.isDirectory()) continue;
    const directory = path.join(companies, company.name, "snapshots");
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory).sort()) {
      if (name.endsWith(".json")) paths.push(path.join(directory, name));
    }
  }
  return paths;
}

function label(filePath: string, root: string): string {
  const relative = path.relative(root, filePath);
  return relative.startsWith("..") ? filePath : relative;
}

function main(): number {
  const { positionals, flags, values } = parseArgs(process.argv.slice(2));
  if (flags.has("--help")) {
    console.log(USAGE);
    return 0;
  }

  const all = flags.has("--all");
  const root = values.get("--root") ?? findRepoRoot();
  const targets = all ? collectSnapshotPaths(root) : positionals.slice(0, 1);

  if (targets.length === 0) {
    if (all) {
      if (flags.has("--json")) process.stdout.write(`${JSON.stringify({ errors: [], warnings: [] })}\n`);
      return 0;
    }
    console.error(USAGE);
    return 1;
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  for (const target of targets) {
    const result: CheckResult = checkSnapshotFile(target);
    const prefix = all ? `${label(target, root)}: ` : "";
    errors.push(...result.errors.map((message) => `${prefix}${message}`));
    warnings.push(...result.warnings.map((message) => `${prefix}${message}`));
  }

  if (flags.has("--json")) {
    process.stdout.write(`${JSON.stringify({ errors, warnings }, null, 2)}\n`);
    return 0;
  }

  for (const warning of warnings) console.log(`警告 - ${warning}`);
  if (errors.length === 0) {
    console.log(
      all
        ? `研究快照校验通过：${targets.length} 份。`
        : `研究快照校验通过：${label(targets[0], root)}`,
    );
    return 0;
  }

  console.error("研究快照校验失败：");
  for (const error of errors) console.error(`- ${error}`);
  return 1;
}

runCli(main);
