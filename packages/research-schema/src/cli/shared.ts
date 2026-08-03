import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Placeholder written into every field a skeleton cannot responsibly guess.
 * It is deliberately not a valid value for any schema field, so a snapshot that
 * still carries one can never be published by accident.
 */
export const SENTINEL = "__TODO__";

export type CliOptions = {
  positionals: string[];
  flags: Set<string>;
  values: Map<string, string>;
};

export function parseArgs(argv: string[]): CliOptions {
  const positionals: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const withValue = new Set(["--at", "--root"]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    if (withValue.has(argument)) {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${argument} 缺少取值。`);
      values.set(argument, next);
      index += 1;
      continue;
    }
    flags.add(argument);
  }

  return { positionals, flags, values };
}

/**
 * Locate the repository root by walking up from this file rather than by
 * counting directory levels, so moving these scripts cannot silently break it.
 */
export function findRepoRoot(start: string = import.meta.dirname): string {
  let current = path.resolve(start);
  while (true) {
    const manifest = path.join(current, "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { workspaces?: unknown };
        if (Array.isArray(parsed.workspaces)) return current;
      } catch {
        // Keep walking; an unreadable manifest is not the root we want.
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("无法定位仓库根目录（未找到带 workspaces 的 package.json）。");
    }
    current = parent;
  }
}

/** Run a CLI entry point, turning a thrown error into a message plus exit 1. */
export function runCli(main: () => number): void {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export function companiesDirectory(root: string): string {
  return path.join(root, "research", "companies");
}

export function snapshotsDirectory(root: string, companyId: string): string {
  return path.join(companiesDirectory(root), companyId, "snapshots");
}

export type SnapshotFile = {
  filePath: string;
  stem: string;
  data: Record<string, unknown>;
};

function readSnapshotFile(filePath: string): SnapshotFile | null {
  try {
    const data = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    return { filePath, stem: path.basename(filePath, ".json"), data };
  } catch {
    return null;
  }
}

export function readSnapshotDirectory(directory: string): SnapshotFile[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readSnapshotFile(path.join(directory, name)))
    .filter((snapshot): snapshot is SnapshotFile => snapshot !== null);
}

function createdAtOf(snapshot: SnapshotFile): string {
  const meta = snapshot.data.snapshot as { createdAt?: unknown } | undefined;
  return typeof meta?.createdAt === "string" ? meta.createdAt : "";
}

/**
 * The most recent snapshot strictly older than `current`, which is the baseline
 * both the skeleton generator and the comparability checker work against.
 */
export function findPriorSnapshot(
  directory: string,
  current: { stem: string; createdAt: string },
): SnapshotFile | null {
  const candidates = readSnapshotDirectory(directory)
    .filter((snapshot) => snapshot.stem !== current.stem)
    .filter((snapshot) => {
      const createdAt = createdAtOf(snapshot);
      return createdAt !== "" && createdAt < current.createdAt;
    })
    .sort((left, right) => createdAtOf(left).localeCompare(createdAtOf(right)));

  return candidates.at(-1) ?? null;
}

export function findLatestSnapshot(directory: string): SnapshotFile | null {
  const candidates = readSnapshotDirectory(directory).sort((left, right) =>
    createdAtOf(left).localeCompare(createdAtOf(right)),
  );
  return candidates.at(-1) ?? null;
}

const STAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})$/;

/** `YYYY-MM-DD-HHMM` in Asia/Shanghai, the repository's canonical stamp. */
export function currentStamp(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}-${get("hour")}${get("minute")}`;
}

export function stampToIso(stamp: string): string {
  const match = STAMP_PATTERN.exec(stamp);
  if (!match) {
    throw new Error(`时间戳格式必须为 YYYY-MM-DD-HHMM：${stamp}`);
  }
  const [, year, month, day, hour, minute] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:00+08:00`;
}

export function assertStamp(stamp: string): string {
  if (!STAMP_PATTERN.test(stamp)) {
    throw new Error(`时间戳格式必须为 YYYY-MM-DD-HHMM：${stamp}`);
  }
  return stamp;
}
