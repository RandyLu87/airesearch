import { existsSync } from "node:fs";
import path from "node:path";
import {
  DRIVER_COMPATIBILITY_KEYS,
  RECALIBRATION_GRADES,
  isCurrentSnapshot,
  researchSnapshotSchema,
  splitCausalChain,
  type DriverMetric,
} from "../index.ts";
import {
  compareLedgerToHistory,
  coverageShortfall,
  ledgerPathForCompanyDir,
  loadLedgerAt,
} from "../ledger.ts";
import {
  commitmentLedgerPathForCompanyDir,
  compareCommitmentLedgerToSummary,
  loadCommitmentLedgerAt,
} from "../commitments.ts";
import {
  SENTINEL,
  findLatestSnapshot,
  findPriorSnapshot,
  readSnapshotDirectory,
} from "./shared.ts";

type Json = Record<string, unknown>;

/**
 * Snapshots that already existed when the driver continuity contract landed,
 * keyed as `<company.id>/<snapshot.id>`.
 *
 * These were authored when every research run was free to reselect its drivers.
 * Holding them to continuity would permanently block the repository on history
 * we deliberately chose not to rewrite, so their comparability layer is skipped;
 * sentinel and schema checks still apply.
 *
 * Deliberately an explicit list and not a cutoff date: a date test keyed on the
 * snapshot's own timestamp would let any new snapshot exempt itself just by
 * being backdated. Nothing can join this list by accident — only by editing it,
 * which is a reviewable act. Every snapshot authored from now on is governed.
 */
export const CONTINUITY_EXEMPT_SNAPSHOTS: ReadonlySet<string> = new Set([
  "hk-9899-netease-cloud-music/2026-07-31-1927-analysis",
]);

export type CheckResult = {
  errors: string[];
  warnings: string[];
};

/** Every JSON path whose string value still carries the skeleton placeholder. */
function findSentinels(value: unknown, trail: string[] = [], found: string[] = []): string[] {
  if (typeof value === "string") {
    if (value.includes(SENTINEL)) found.push(trail.join("."));
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => findSentinels(item, [...trail, String(index)], found));
    return found;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      findSentinels(nested, [...trail, key], found);
    }
  }
  return found;
}

/** Index a list of `{ id }` entities by id, skipping anything without one. */
function indexById(entities: unknown): Map<string, Json> {
  const list = Array.isArray(entities) ? (entities as Json[]) : [];
  return new Map(
    list
      .filter((entity) => typeof entity?.id === "string")
      .map((entity) => [entity.id as string, entity]),
  );
}

function driverChangeIndex(snapshot: Json): Map<string, string> {
  const thesisChange = snapshot.thesisChange as Json | undefined;
  const changes = (thesisChange?.driverChanges as Json[] | undefined) ?? [];
  const index = new Map<string, string>();
  for (const change of changes) {
    if (typeof change?.driverId === "string" && typeof change?.change === "string") {
      index.set(change.driverId, change.change);
    }
  }
  return index;
}

/**
 * Enforce the continuity contract: a driver may be added, dropped or recalibrated,
 * but never silently. Redefinition additionally has to be reflected in the
 * business-model change grade, so a calibration shift cannot masquerade as noise.
 */
function checkComparability(current: Json, prior: Json): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const priorDrivers = indexById(prior.driverMetrics);
  const currentDrivers = indexById(current.driverMetrics);
  const declared = driverChangeIndex(current);
  const summary = current.summary as Json | undefined;
  const modelChange = summary?.businessModelChange;
  const escalated = RECALIBRATION_GRADES.some((grade) => grade === modelChange);

  for (const driverId of priorDrivers.keys()) {
    if (currentDrivers.has(driverId)) continue;
    if (declared.get(driverId) !== "removed") {
      errors.push(
        `comparability: 驱动指标 ${driverId} 相对上一份研究快照被移除，` +
          `但 thesisChange.driverChanges 没有对应的 removed 记录。` +
          `补一条 {"driverId":"${driverId}","change":"removed","reason":"..."}，或恢复该驱动。`,
      );
    }
  }

  for (const driverId of currentDrivers.keys()) {
    if (priorDrivers.has(driverId)) continue;
    if (declared.get(driverId) !== "added") {
      errors.push(
        `comparability: 驱动指标 ${driverId} 是本次新增，` +
          `但 thesisChange.driverChanges 没有对应的 added 记录。` +
          `补一条 {"driverId":"${driverId}","change":"added","reason":"..."}。`,
      );
    }
  }

  for (const [driverId, currentDriver] of currentDrivers) {
    const priorDriver = priorDrivers.get(driverId);
    if (!priorDriver) continue;
    const mismatch = DRIVER_COMPATIBILITY_KEYS.find(
      (key) => priorDriver[key] !== (currentDriver as Partial<DriverMetric>)[key],
    );
    if (!mismatch) continue;

    if (declared.get(driverId) !== "redefined") {
      errors.push(
        `comparability: 驱动指标 ${driverId} 的口径字段 ${mismatch} 发生变化` +
          `（${String(priorDriver[mismatch])} → ${String(currentDriver[mismatch])}），` +
          `但 thesisChange.driverChanges 没有对应的 redefined 记录。`,
      );
    }
    if (!escalated) {
      errors.push(
        `comparability: 驱动指标 ${driverId} 的口径字段 ${mismatch} 发生变化，` +
          `summary.businessModelChange 必须升级为「机制变化」或「结构性变化」，当前为「${String(modelChange)}」。`,
      );
    }
  }

  // Moat churn warns rather than blocks, following the constraint precedent: a
  // moat being disproved or a new one forming is a normal research outcome, and
  // a moat carries no calibration fields for `driverChanges` to compare. The
  // obligation to explain it in `thesisChange.thesis` is a process rule in
  // WORKFLOW.md, not something a checker can verify.
  const priorMoats = indexById((prior.businessModel as Json | undefined)?.moat);
  const currentMoats = indexById((current.businessModel as Json | undefined)?.moat);
  const droppedMoats = [...priorMoats.keys()].filter((id) => !currentMoats.has(id));
  const addedMoats = [...currentMoats.keys()].filter((id) => !priorMoats.has(id));
  if (droppedMoats.length > 0) {
    warnings.push(
      `护城河不再声明：${droppedMoats.join("、")}。` +
        `确认它确实已被证伪，并在 thesisChange 中说明。`,
    );
  }
  if (addedMoats.length > 0) {
    warnings.push(
      `护城河新增：${addedMoats.join("、")}。确认它有驱动指标支撑，而不是换了个说法。`,
    );
  }
  for (const [moatId, currentMoat] of currentMoats) {
    const priorMoat = priorMoats.get(moatId);
    if (!priorMoat || priorMoat.trend === currentMoat.trend) continue;
    warnings.push(
      `护城河 ${moatId} 的趋势由「${String(priorMoat.trend)}」变为「${String(currentMoat.trend)}」。`,
    );
  }

  const priorConstraints = indexById(prior.constraints);
  const currentConstraints = indexById(current.constraints);
  const droppedConstraints = [...priorConstraints.keys()].filter((id) => !currentConstraints.has(id));
  const addedConstraints = [...currentConstraints.keys()].filter((id) => !priorConstraints.has(id));
  if (droppedConstraints.length > 0) {
    warnings.push(`最紧约束不再出现：${droppedConstraints.join("、")}。确认它们确实已解除。`);
  }
  if (addedConstraints.length > 0) {
    warnings.push(`最紧约束新增：${addedConstraints.join("、")}。确认它们确实是当前的瓶颈。`);
  }

  return { errors, warnings };
}

/**
 * Hold the snapshot's embedded `financialHistory` against the company ledger.
 *
 * Only the company's *current* snapshot is governed. Earlier snapshots are
 * frozen records under ADR-0002, so when an issuer restates a prior year the
 * ledger moves forward and the published history legitimately keeps the figure
 * it was written against. Enforcing consistency on all of them would turn every
 * restatement into a repository-wide failure with no correct fix.
 */
function checkLedger(input: {
  data: { company: { id: string }; financialHistory: unknown };
  directory: string;
  stem: string;
}): CheckResult {
  const { data, directory, stem } = input;
  const latest = findLatestSnapshot(directory);
  if (latest && latest.stem !== stem) return { errors: [], warnings: [] };

  const companyDirectory = path.dirname(directory);
  const filePath = ledgerPathForCompanyDir(companyDirectory);
  if (!existsSync(filePath)) {
    return {
      errors: [],
      warnings: [
        `该公司还没有财报账本 ${path.relative(companyDirectory, filePath)}；` +
          `financialHistory 目前只存在于快照里，下次研究会重复取数。`,
      ],
    };
  }

  try {
    const ledger = loadLedgerAt(filePath, data.company.id);
    const shortfall = coverageShortfall(ledger);
    return {
      errors: compareLedgerToHistory(
        ledger,
        (data.financialHistory as never[]) ?? [],
      ),
      warnings: shortfall ? [shortfall] : [],
    };
  } catch (error) {
    return {
      errors: [error instanceof Error ? error.message : String(error)],
      warnings: [],
    };
  }
}

/**
 * Hold the snapshot's `commitmentSummary` against the commitment ledger.
 *
 * Only the company's current snapshot is governed, same reasoning as the
 * financial ledger: earlier snapshots are frozen records, and a promise that
 * settles later legitimately leaves them showing the state they were written at.
 *
 * A missing ledger is a warning, not an error — a newly listed company may have
 * nothing to record. A snapshot that carries a summary with no ledger behind it
 * *is* an error, because that summary then came from nowhere.
 */
function checkCommitments(input: {
  data: { company: { id: string }; commitmentSummary?: unknown };
  directory: string;
  stem: string;
}): CheckResult {
  const { data, directory, stem } = input;
  const latest = findLatestSnapshot(directory);
  if (latest && latest.stem !== stem) return { errors: [], warnings: [] };

  const companyDirectory = path.dirname(directory);
  const filePath = commitmentLedgerPathForCompanyDir(companyDirectory);
  const relative = path.relative(companyDirectory, filePath);

  if (!existsSync(filePath)) {
    if (data.commitmentSummary !== undefined) {
      return {
        errors: [
          `快照有 commitmentSummary 但公司目录没有 ${relative}；` +
            `该块必须由 npm run snapshot:sync 从台账物化，不能手写。`,
        ],
        warnings: [],
      };
    }
    return {
      errors: [],
      warnings: [
        `该公司还没有承诺台账 ${relative}；管理层说过的话无处累积，` +
          `治理评价只能停留在横截面。见 docs/adr/0019-commit-a-management-commitment-ledger.md。`,
      ],
    };
  }

  try {
    const ledger = loadCommitmentLedgerAt(filePath, data.company.id);
    if (data.commitmentSummary === undefined) {
      return {
        errors: [
          `公司目录有 ${relative} 但快照没有 commitmentSummary；` +
            `运行 npm run snapshot:sync 物化它。`,
        ],
        warnings: [],
      };
    }
    const warnings = ledger.entries.length === 0
      ? [`承诺台账为空（覆盖自 ${ledger.coverageFrom}）；确认这段时间确实没有可判定的承诺。`]
      : [];
    return {
      errors: compareCommitmentLedgerToSummary(ledger, data.commitmentSummary),
      warnings,
    };
  } catch (error) {
    return {
      errors: [error instanceof Error ? error.message : String(error)],
      warnings: [],
    };
  }
}

function valueAtPath(root: unknown, jsonPath: PropertyKey[]): unknown {
  let cursor: unknown = root;
  for (const key of jsonPath) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<PropertyKey, unknown>)[key];
  }
  return cursor;
}

/**
 * True when a schema complaint is merely the downstream echo of an unreplaced
 * sentinel. Reporting those alongside the sentinel itself would bury the real
 * schema errors on the parts already filled in.
 */
function causedBySentinel(jsonPath: PropertyKey[], sentinels: Set<string>): boolean {
  const joined = jsonPath.join(".");
  // Root-level refinements (dangling evidence ids, fair-value ordering) cannot
  // be attributed to a field, and a skeleton always trips them.
  if (joined === "") return sentinels.size > 0;
  for (const sentinel of sentinels) {
    if (joined === sentinel || joined.startsWith(`${sentinel}.`) || sentinel.startsWith(`${joined}.`)) {
      return true;
    }
  }
  return false;
}

export function checkSnapshotData(input: {
  data: Json;
  directory: string;
  stem: string;
}): CheckResult {
  const { data, directory, stem } = input;
  const errors: string[] = [];
  const warnings: string[] = [];

  // Layer 1 — unreplaced skeleton placeholders.
  const sentinels = findSentinels(data);
  const sentinelSet = new Set(sentinels);
  for (const jsonPath of sentinels) {
    errors.push(`sentinel: ${jsonPath}: 仍是待办哨兵 ${SENTINEL}，必须替换为取证后的值；该字段可选时直接删除整个键。`);
  }

  // Layer 2 — schema, minus the complaints the sentinels themselves cause, so
  // the parts already filled in still get real feedback.
  const parsed = researchSnapshotSchema.safeParse(data);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      if (causedBySentinel(issue.path, sentinelSet)) continue;
      // A root-level refinement has no offending field, so echoing "the actual
      // value" would print the entire snapshot. The message already names what
      // is wrong; cross-field rules carry their own numbers.
      if (issue.path.length === 0) {
        errors.push(`schema: <root>: ${issue.message}`);
        continue;
      }
      const actual = valueAtPath(data, issue.path);
      const rendered = actual === undefined ? "缺失" : JSON.stringify(actual);
      errors.push(
        `schema: ${issue.path.join(".")}: ${issue.message}；实际值 ${rendered}`,
      );
    }
  }
  if (sentinels.length > 0) {
    warnings.push(`仍有 ${sentinels.length} 处待办哨兵；可比性校验待哨兵清空后才会运行。`);
  }

  // Layer 3 — continuity against the previous snapshot. Needs a fully valid
  // snapshot, since it reads driver calibration and the model change grade.
  if (!parsed.success || sentinels.length > 0) return { errors, warnings };

  // The causal chain is rendered as a stepped flow by splitting on the arrow the
  // driver-tree template mandates. That makes an arrow-less chain a silent
  // downgrade to a paragraph, so say so — but only as a warning: how many links
  // a business actually has is a research judgment, not a rendering constraint.
  if (isCurrentSnapshot(parsed.data)) {
    const links = splitCausalChain(parsed.data.businessModel.causalChain);
    if (links.length < 3) {
      warnings.push(
        `businessModel.causalChain 只解析出 ${links.length} 个环节（按 → 分隔），` +
          `因果链会降级为散文渲染而不是阶梯流；按 business-model-playbook 第 2 节的驱动树模板` +
          `用 → 连接各环节即可恢复图形。`,
      );
    }
  }

  const ledger = checkLedger({ data: parsed.data, directory, stem });
  errors.push(...ledger.errors);
  warnings.push(...ledger.warnings);

  const commitments = checkCommitments({ data: parsed.data, directory, stem });
  errors.push(...commitments.errors);
  warnings.push(...commitments.warnings);

  const exemptionKey = `${parsed.data.company.id}/${parsed.data.snapshot.id}`;
  if (CONTINUITY_EXEMPT_SNAPSHOTS.has(exemptionKey)) return { errors, warnings };

  const prior = findPriorSnapshot(directory, {
    stem,
    createdAt: parsed.data.snapshot.createdAt,
  });
  if (!prior) return { errors, warnings };

  const comparability = checkComparability(parsed.data as unknown as Json, prior.data);
  return {
    errors: [...errors, ...comparability.errors],
    warnings: [...warnings, ...comparability.warnings],
  };
}

export function checkSnapshotFile(filePath: string): CheckResult {
  const directory = path.dirname(filePath);
  const stem = path.basename(filePath, ".json");
  const snapshot = readSnapshotDirectory(directory).find((entry) => entry.stem === stem);
  if (!snapshot) {
    return { errors: [`无法读取研究快照或它不是有效 JSON：${filePath}`], warnings: [] };
  }
  return checkSnapshotData({ data: snapshot.data, directory, stem });
}
