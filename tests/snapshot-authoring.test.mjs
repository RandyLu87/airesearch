import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseSnapshot = JSON.parse(
  readFileSync(path.join(repoRoot, "tests", "fixtures", "base-snapshot.json"), "utf8"),
);
const SENTINEL = "__TODO__";
const fixtureCompany = "hk-0001-fixture-co";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** A ledger that mirrors a snapshot's own history, so the two agree by construction. */
function ledgerFor(snapshot, companyId) {
  return {
    ledgerVersion: "1.0.0",
    companyId,
    reportingCurrency: snapshot.company.reportingCurrency,
    minimumYears: 2,
    periods: clone(snapshot.financialHistory),
  };
}

/** Build an isolated research tree so tests never touch research/companies. */
function makeTree(snapshots, companyId = fixtureCompany, { withLedger = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "snapshot-authoring-"));
  const companyDirectory = path.join(root, "research", "companies", companyId);
  const snapshotsDirectory = path.join(companyDirectory, "snapshots");
  mkdirSync(snapshotsDirectory, { recursive: true });
  if (withLedger && snapshots.length > 0) {
    writeFileSync(
      path.join(companyDirectory, "financials.json"),
      `${JSON.stringify(ledgerFor(snapshots.at(-1), companyId), null, 2)}\n`,
    );
  }
  for (const snapshot of snapshots) {
    writeFileSync(
      path.join(snapshotsDirectory, `${snapshot.snapshot.id}.json`),
      `${JSON.stringify(snapshot, null, 2)}\n`,
    );
  }
  return { root, snapshotsDirectory, companyDirectory };
}

function snapshotFile(snapshotsDirectory, snapshot) {
  const filePath = path.join(snapshotsDirectory, `${snapshot.snapshot.id}.json`);
  writeFileSync(filePath, `${JSON.stringify(snapshot, null, 2)}\n`);
  return filePath;
}

function run(script, args) {
  return spawnSync("npm", ["run", "--silent", script, "--", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

function newSnapshot(args) {
  return run("snapshot:new", args);
}

function checkSnapshot(args) {
  return run("snapshot:check", args);
}

/** A later snapshot that keeps every prior driver id and calibration. */
function successor(prior, id = "2026-09-01-1000-analysis") {
  const next = clone(prior);
  next.snapshot.id = id;
  next.snapshot.createdAt = "2026-09-01T10:00:00+08:00";
  next.snapshot.dataCutoff = "2026-09-01T09:00:00+08:00";
  return next;
}

test("snapshot:new prints a fully sentinelled skeleton without touching disk", () => {
  const { root } = makeTree([]);
  const result = newSnapshot([
    "hk-0002-greenfield-co",
    "--at",
    "2026-05-04-0930",
    "--stdout",
    "--root",
    root,
  ]);

  assert.equal(result.status, 0, result.stderr);
  const skeleton = JSON.parse(result.stdout);
  assert.equal(skeleton.company.id, "hk-0002-greenfield-co");
  assert.equal(skeleton.snapshot.id, "2026-05-04-0930-analysis");
  assert.equal(skeleton.schemaVersion, "1.2.0");
  assert.equal(skeleton.company.name, SENTINEL);
  assert.equal(skeleton.summary.businessModel, SENTINEL);
  assert.equal(
    "stance" in skeleton.summary,
    false,
    "1.2.0 publishes no stance; a sentinelled one would invite the author to write it back",
  );
  assert.ok(skeleton.driverMetrics.length >= 4, "skeleton must satisfy the driver minimum");
  assert.ok(skeleton.financialHistory.length >= 2);
  assert.ok(skeleton.sections.length >= 3);
  // A starting list of seats, not a floor: an author deletes the ones this
  // company has no source for. Every seat still owes its bias.
  assert.deepEqual(
    skeleton.valuation.assumptionSets.map((set) => set.sourceKind),
    ["发行人指引", "卖方一致预期", "历史区间回归"],
  );
  for (const set of skeleton.valuation.assumptionSets) {
    assert.equal(set.sourceBias, SENTINEL, "every seat must be asked for its source's lean");
  }
  assert.equal("actionZones" in skeleton.valuation, false);
  assert.ok(skeleton.evidence.length >= 2);

  assert.equal(
    existsSync(
      path.join(
        root,
        "research",
        "companies",
        "hk-0002-greenfield-co",
        "snapshots",
        "2026-05-04-0930-analysis.json",
      ),
    ),
    false,
    "--stdout must not write to the research tree",
  );
});

test("snapshot:new inherits calibration from the prior snapshot but never its numbers", () => {
  const { root } = makeTree([baseSnapshot]);
  const result = newSnapshot([
    fixtureCompany,
    "--at",
    "2026-09-01-1000",
    "--stdout",
    "--root",
    root,
  ]);

  assert.equal(result.status, 0, result.stderr);
  const skeleton = JSON.parse(result.stdout);

  assert.deepEqual(skeleton.company, baseSnapshot.company, "company identity carries over whole");
  assert.equal(skeleton.snapshot.id, "2026-09-01-1000-analysis");
  assert.equal(skeleton.snapshot.createdAt, "2026-09-01T10:00:00+08:00");

  assert.deepEqual(
    skeleton.driverMetrics.map((driver) => driver.id),
    baseSnapshot.driverMetrics.map((driver) => driver.id),
    "driver identity must carry over so the next snapshot is comparable by default",
  );

  const calibration = [
    "label",
    "definition",
    "definitionVersion",
    "causalRole",
    "dimension",
    "signalType",
    "unit",
    "currency",
    "scale",
    "precision",
    "periodType",
    "accountingBasis",
  ];
  for (const [index, driver] of skeleton.driverMetrics.entries()) {
    const prior = baseSnapshot.driverMetrics[index];
    for (const key of calibration) {
      assert.deepEqual(driver[key], prior[key], `driver ${driver.id}.${key} must be inherited`);
    }
    for (const key of ["value", "displayValue", "period", "baseline", "threshold", "status", "trend", "confidence"]) {
      assert.equal(driver[key], SENTINEL, `driver ${driver.id}.${key} must be re-sourced`);
    }
    assert.deepEqual(driver.evidenceIds, [SENTINEL]);
  }

  assert.deepEqual(
    skeleton.standardMetrics.map((metric) => metric.metricId),
    baseSnapshot.standardMetrics.map((metric) => metric.metricId),
  );
  for (const [index, metric] of skeleton.standardMetrics.entries()) {
    const prior = baseSnapshot.standardMetrics[index];
    for (const key of ["label", "definitionVersion", "unit", "currency", "scale", "precision", "periodType", "accountingBasis"]) {
      assert.deepEqual(metric[key], prior[key], `standard metric ${metric.metricId}.${key} must be inherited`);
    }
    assert.equal(metric.value, SENTINEL);
    assert.equal(metric.period, SENTINEL);
  }

  assert.deepEqual(
    skeleton.constraints.map((constraint) => constraint.id),
    baseSnapshot.constraints.map((constraint) => constraint.id),
  );
  for (const constraint of skeleton.constraints) {
    assert.equal(constraint.explanation, SENTINEL);
    assert.equal(constraint.status, SENTINEL);
  }

  assert.equal(skeleton.summary.referencePrice.value, SENTINEL);
  assert.equal(skeleton.summary.marketCap.value, SENTINEL);
  // Which multiple this company is read on is calibration; the reading is not.
  assert.equal(skeleton.summary.multiplePercentile.metricLabel, "P/E（正常化）");
  assert.equal(skeleton.summary.multiplePercentile.percentile, SENTINEL);
  assert.equal(skeleton.summary.multiplePercentile.adjustmentBasis, SENTINEL);
  // Which source a seat draws on carries over; what the source said does not.
  assert.deepEqual(
    skeleton.valuation.assumptionSets.map((set) => set.id),
    baseSnapshot.valuation.assumptionSets.map((set) => set.id),
  );
  assert.equal(skeleton.thesisChange.investmentLogic, SENTINEL);
});

test("snapshot:new writes the canonical path and refuses to clobber a same-day snapshot", () => {
  const { root } = makeTree([baseSnapshot]);
  const target = path.join(
    root,
    "research",
    "companies",
    fixtureCompany,
    "snapshots",
    "2026-09-01-1000-analysis.json",
  );

  const created = newSnapshot([fixtureCompany, "--at", "2026-09-01-1000", "--root", root]);
  assert.equal(created.status, 0, created.stderr);
  assert.equal(existsSync(target), true, "skeleton must land on the canonical snapshot path");
  JSON.parse(readFileSync(target, "utf8"));

  const again = newSnapshot([fixtureCompany, "--at", "2026-09-01-1000", "--root", root]);
  assert.equal(again.status, 1, "a second write for the same day must fail");
  assert.match(`${again.stdout}${again.stderr}`, /已存在|already exists/);
});

test("snapshot:check accepts a valid snapshot", () => {
  const { snapshotsDirectory } = makeTree([baseSnapshot]);
  const result = checkSnapshot([path.join(snapshotsDirectory, `${baseSnapshot.snapshot.id}.json`)]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test("snapshot:check reports leftover sentinels with their JSON paths", () => {
  const draft = clone(baseSnapshot);
  draft.summary.businessModel = SENTINEL;
  draft.driverMetrics[0].displayValue = SENTINEL;
  const { snapshotsDirectory } = makeTree([]);
  const filePath = snapshotFile(snapshotsDirectory, draft);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 1);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /summary\.businessModel/);
  assert.match(output, /driverMetrics\.0\.displayValue/);
  assert.match(output, /待办|哨兵/);
});

test("snapshot:check reports schema violations with path and expectation", () => {
  const broken = clone(baseSnapshot);
  broken.driverMetrics[0].trend = "上升";
  const { snapshotsDirectory } = makeTree([]);
  const filePath = snapshotFile(snapshotsDirectory, broken);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 1);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /driverMetrics\.0\.trend/);
  assert.match(output, /改善/, "the expectation should name the allowed values");
});

test("snapshot:check skips the comparability layer when there is no prior snapshot", () => {
  const only = successor(baseSnapshot);
  // A changed driver set is the point; the slice stops short of the drivers the
  // fixture's moat and disagreement point at, because dropping those is a
  // referential-integrity error rather than a comparability one.
  only.driverMetrics = only.driverMetrics.slice(0, 5);
  const { snapshotsDirectory } = makeTree([]);
  const filePath = snapshotFile(snapshotsDirectory, only);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test("snapshot:check blocks a dropped driver that has no recorded reason", () => {
  const next = successor(baseSnapshot);
  next.driverMetrics = next.driverMetrics.filter((driver) => driver.id !== "content-cost-ratio");
  const { snapshotsDirectory } = makeTree([baseSnapshot]);
  const filePath = snapshotFile(snapshotsDirectory, next);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 1);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /content-cost-ratio/);
  assert.match(output, /driverChanges/);
});

test("snapshot:check accepts a dropped driver once the reason is recorded", () => {
  const next = successor(baseSnapshot);
  next.driverMetrics = next.driverMetrics.filter((driver) => driver.id !== "content-cost-ratio");
  next.thesisChange.driverChanges = [
    {
      driverId: "content-cost-ratio",
      change: "removed",
      reason: "内容成本已并入毛利率驱动，单独跟踪产生重复计数。",
    },
  ];
  const { snapshotsDirectory } = makeTree([baseSnapshot]);
  const filePath = snapshotFile(snapshotsDirectory, next);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test("snapshot:check blocks an added driver that has no recorded reason", () => {
  const next = successor(baseSnapshot);
  next.driverMetrics.push({
    ...clone(baseSnapshot.driverMetrics[0]),
    id: "arpu",
    label: "订阅 ARPU",
    definition: "订阅收入除以月均付费用户数。",
  });
  const { snapshotsDirectory } = makeTree([baseSnapshot]);
  const filePath = snapshotFile(snapshotsDirectory, next);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /arpu/);
});

test("snapshot:check blocks a redefined driver while the model change is still 参数变化", () => {
  const next = successor(baseSnapshot);
  next.driverMetrics[0].periodType = "quarter";
  next.thesisChange.driverChanges = [
    {
      driverId: "subscription-mix",
      change: "redefined",
      reason: "改为按季度跟踪以更早发现结构变化。",
    },
  ];
  const { snapshotsDirectory } = makeTree([baseSnapshot]);
  const filePath = snapshotFile(snapshotsDirectory, next);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 1);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /subscription-mix/);
  assert.match(output, /机制变化|结构性变化/);
});

test("snapshot:check accepts a redefined driver when the model change is escalated", () => {
  const next = successor(baseSnapshot);
  next.driverMetrics[0].periodType = "quarter";
  next.summary.businessModelChange = "机制变化";
  next.thesisChange.driverChanges = [
    {
      driverId: "subscription-mix",
      change: "redefined",
      reason: "改为按季度跟踪以更早发现结构变化。",
    },
  ];
  const { snapshotsDirectory } = makeTree([baseSnapshot]);
  const filePath = snapshotFile(snapshotsDirectory, next);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

/** A promise settled in the company's favour, and a buyback with its valuation. */
function commitmentLedger(companyId = fixtureCompany, entries = undefined) {
  return {
    ledgerVersion: "1.0.0",
    companyId,
    coverageFrom: "2023-01-01",
    entries: entries ?? [
      {
        id: "2024-q4-subscription-breakeven",
        kind: "承诺",
        statedAt: "2025-03-18",
        venue: "业绩发布会",
        quote: "我们预计在 2026 年内让社交娱乐业务的单季经营利润转正。",
        commitment: "2026 年内社交娱乐业务单季经营利润转正",
        dueBy: "2026-12-31",
        status: "待到期",
        evidence: [
          {
            title: "2024 年度业绩发布会记录",
            publisher: "公司投资者关系",
            url: "https://example.com/ir/2024-results",
            retrievedAt: "2026-08-03T20:00:00+08:00",
          },
        ],
      },
      {
        id: "2025-buyback-tranche-1",
        kind: "回购",
        statedAt: "2025-09-10",
        venue: "公告",
        quote: "董事会批准不超过 10 亿港元的股份回购计划。",
        commitment: "首期回购 6.2 亿港元，均价 HK$118",
        dueBy: "2026-03-31",
        status: "兑现",
        resolvedAt: "2026-03-20",
        outcome: "累计回购 6.2 亿港元、注销 525 万股，与公告口径一致。",
        amount: { value: "6.20", unit: "currency", currency: "HKD", scale: "hundred-million", precision: 2 },
        valuationAtTime: "均价 HK$118，对应当时 11.2x 正常化 P/E，处于自身五年区间下沿",
        returnAssessment: "回购价低于本次基准价值中枢，时点判断成立。",
        evidence: [
          {
            title: "回购完成公告",
            publisher: "香港交易所",
            url: "https://example.com/hkex/buyback-complete",
            retrievedAt: "2026-08-03T20:10:00+08:00",
          },
        ],
      },
    ],
  };
}

/** The summary the ledger above materialises into, written out by hand. */
const LEDGER_SUMMARY = {
  coverageFrom: "2023-01-01",
  counts: { 兑现: 1, 部分兑现: 0, 未兑现: 0, 待到期: 1, 已撤回: 0 },
  outstanding: [],
  latestResolution: {
    id: "2025-buyback-tranche-1",
    commitment: "首期回购 6.2 亿港元，均价 HK$118",
    status: "兑现",
    resolvedAt: "2026-03-20",
  },
  capitalAllocation: [
    {
      id: "2025-buyback-tranche-1",
      kind: "回购",
      statedAt: "2025-09-10",
      commitment: "首期回购 6.2 亿港元，均价 HK$118",
      status: "兑现",
      amount: { value: "6.20", unit: "currency", currency: "HKD", scale: "hundred-million", precision: 2 },
      valuationAtTime: "均价 HK$118，对应当时 11.2x 正常化 P/E，处于自身五年区间下沿",
      returnAssessment: "回购价低于本次基准价值中枢，时点判断成立。",
    },
  ],
};

function writeCommitments(companyDirectory, ledger) {
  writeFileSync(
    path.join(companyDirectory, "commitments.json"),
    `${JSON.stringify(ledger, null, 2)}\n`,
  );
}

test("a snapshot whose commitment summary matches the ledger is accepted", () => {
  const draft = clone(baseSnapshot);
  draft.commitmentSummary = clone(LEDGER_SUMMARY);
  const { snapshotsDirectory, companyDirectory } = makeTree([]);
  writeCommitments(companyDirectory, commitmentLedger());
  const filePath = snapshotFile(snapshotsDirectory, draft);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test("a hand-edited commitment summary is caught against the ledger", () => {
  const draft = clone(baseSnapshot);
  draft.commitmentSummary = clone(LEDGER_SUMMARY);
  draft.commitmentSummary.counts.兑现 = 2;
  const { snapshotsDirectory, companyDirectory } = makeTree([]);
  writeCommitments(companyDirectory, commitmentLedger());
  const filePath = snapshotFile(snapshotsDirectory, draft);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 1);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /commitmentSummary/);
  assert.match(output, /snapshot:sync/);
});

test("a commitment summary with no ledger behind it is rejected", () => {
  const draft = clone(baseSnapshot);
  draft.commitmentSummary = clone(LEDGER_SUMMARY);
  const { snapshotsDirectory } = makeTree([]);
  const filePath = snapshotFile(snapshotsDirectory, draft);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /commitments\.json/);
});

test("the skeleton materialises the commitment summary when a ledger exists", () => {
  const { root, companyDirectory } = makeTree([baseSnapshot]);
  writeCommitments(companyDirectory, commitmentLedger());
  const result = newSnapshot([fixtureCompany, "--at", "2026-09-03-1000", "--stdout", "--root", root]);

  assert.equal(result.status, 0, result.stderr);
  const skeleton = JSON.parse(result.stdout);
  assert.deepEqual(skeleton.commitmentSummary, LEDGER_SUMMARY);
});

test("the skeleton omits the commitment summary when the company has no ledger", () => {
  const { root } = makeTree([baseSnapshot]);
  const result = newSnapshot([fixtureCompany, "--at", "2026-09-04-1000", "--stdout", "--root", root]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal("commitmentSummary" in JSON.parse(result.stdout), false);
});

test("a missing commitment ledger warns without blocking", () => {
  const { snapshotsDirectory } = makeTree([baseSnapshot]);
  const result = checkSnapshot([
    path.join(snapshotsDirectory, `${baseSnapshot.snapshot.id}.json`),
  ]);

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(`${result.stdout}${result.stderr}`, /承诺台账/);
});

test("an empty commitment ledger is legal but says so, keeping it distinct from unchecked", () => {
  const ledger = commitmentLedger(fixtureCompany, []);
  const draft = clone(baseSnapshot);
  draft.commitmentSummary = {
    coverageFrom: "2023-01-01",
    counts: { 兑现: 0, 部分兑现: 0, 未兑现: 0, 待到期: 0, 已撤回: 0 },
    outstanding: [],
    latestResolution: null,
    capitalAllocation: [],
  };
  const { snapshotsDirectory, companyDirectory } = makeTree([]);
  writeCommitments(companyDirectory, ledger);
  const filePath = snapshotFile(snapshotsDirectory, draft);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(`${result.stdout}${result.stderr}`, /台账为空/);
});

test("a settled commitment without a settlement basis is rejected", () => {
  const ledger = commitmentLedger();
  ledger.entries[0].status = "未兑现";
  ledger.entries[0].resolvedAt = "2026-06-30";
  const draft = clone(baseSnapshot);
  draft.commitmentSummary = clone(LEDGER_SUMMARY);
  const { snapshotsDirectory, companyDirectory } = makeTree([]);
  writeCommitments(companyDirectory, ledger);
  const filePath = snapshotFile(snapshotsDirectory, draft);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /outcome/);
});

test("a buyback recorded without the valuation it was executed at is rejected", () => {
  const ledger = commitmentLedger();
  delete ledger.entries[1].valuationAtTime;
  const draft = clone(baseSnapshot);
  draft.commitmentSummary = clone(LEDGER_SUMMARY);
  const { snapshotsDirectory, companyDirectory } = makeTree([]);
  writeCommitments(companyDirectory, ledger);
  const filePath = snapshotFile(snapshotsDirectory, draft);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /valuationAtTime|当时的估值口径/);
});

test("the path validator accepts a commitment ledger beside the financial one", () => {
  const withSummary = clone(baseSnapshot);
  withSummary.commitmentSummary = clone(LEDGER_SUMMARY);
  const { companyDirectory } = makeTree([withSummary]);
  writeCommitments(companyDirectory, commitmentLedger());

  const result = spawnSync(
    "python3",
    [path.join(repoRoot, "scripts", "research", "validate_research_paths.py"), "--root", path.resolve(companyDirectory, "../../..")],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

/**
 * The density of the untouched fixture, computed by hand rather than by calling
 * the implementation: 14 status-bearing entries (5 standard metrics, 6 drivers,
 * 2 share denominators, 3 assumption sets) with 2 unavailable, 4 evidence records
 * with none inferred, 6 drivers with 1 on low confidence and none resting on
 * inference alone. Pinning the arithmetic independently is the point
 * — re-deriving it from the same function would assert nothing.
 */
const BASE_DENSITY = {
  unavailableShare: "0.1429",
  inferenceShare: "0.0000",
  lowConfidenceDriverShare: "0.1667",
  unsupportedDriverShare: "0.0000",
  idealMethodBlocked: false,
};

test("a synced evidence density block with no rule triggered is accepted", () => {
  const draft = clone(baseSnapshot);
  draft.evidenceDensity = { computed: { ...BASE_DENSITY }, responses: [] };
  const { snapshotsDirectory } = makeTree([]);
  const filePath = snapshotFile(snapshotsDirectory, draft);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test("a hand-edited density statistic is rejected and told to re-sync", () => {
  const draft = clone(baseSnapshot);
  draft.evidenceDensity = {
    computed: { ...BASE_DENSITY, unavailableShare: "0.0000" },
    responses: [],
  };
  const { snapshotsDirectory } = makeTree([]);
  const filePath = snapshotFile(snapshotsDirectory, draft);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 1);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /evidenceDensity\.computed\.unavailableShare/);
  assert.match(output, /0\.1429/);
  assert.match(output, /snapshot:sync/);
});

/** A driver whose only citation is an inference record, which fires the hardest rule. */
function withUnsupportedDriver() {
  const draft = clone(baseSnapshot);
  draft.evidence.push({
    id: "ev-analyst-inference",
    kind: "inference",
    title: "对付费率路径的区间估算",
    publisher: "本研究",
    periodOrEventDate: "2026-08-03",
    publishedAt: "2026-08-03",
    retrievedAt: "2026-08-03T21:00:00+08:00",
    url: "https://example.com/inference-note",
  });
  draft.driverMetrics[0].evidenceIds = ["ev-analyst-inference"];
  return draft;
}

test("an unsourced assumption set shows up in the evidence density", () => {
  // The whole point of counting seats: a snapshot resting on one attributed source
  // must not report the same density as one resting on three.
  const draft = clone(baseSnapshot);
  for (const id of ["issuer-guidance", "sellside-consensus"]) {
    const target = seat(draft, id);
    target.status = "unavailable";
    target.reason = "本次取不到。";
    delete target.assumptions;
    delete target.components;
    delete target.computed;
    delete target.impliedExpectation;
  }
  draft.valuation.disagreement.assumptionSetId = "historical-range";
  // 4 of 14 now unavailable, up from 2 — and past the 25% rule, so it has to be answered.
  draft.evidenceDensity = {
    computed: { ...BASE_DENSITY, unavailableShare: "0.2857" },
    responses: [],
  };
  const { snapshotsDirectory } = makeTree([]);
  const filePath = snapshotFile(snapshotsDirectory, draft);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 1);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /high-unavailable-share/);
  assert.match(output, /假设集/, "the rule text must say seats are counted");
});

test("a driver resting only on inference triggers a density rule that must be answered", () => {
  const draft = withUnsupportedDriver();
  draft.evidenceDensity = {
    computed: {
      unavailableShare: "0.1429",
      inferenceShare: "0.2000",
      lowConfidenceDriverShare: "0.1667",
      unsupportedDriverShare: "0.1667",
      idealMethodBlocked: false,
    },
    responses: [],
  };
  const { snapshotsDirectory } = makeTree([]);
  const filePath = snapshotFile(snapshotsDirectory, draft);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 1);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /unsupported-drivers/);
  assert.match(output, /没有回应/);
});

test("answering the triggered density rule publishes; density itself never blocks", () => {
  const draft = withUnsupportedDriver();
  draft.evidenceDensity = {
    computed: {
      unavailableShare: "0.1429",
      inferenceShare: "0.2000",
      lowConfidenceDriverShare: "0.1667",
      unsupportedDriverShare: "0.1667",
      idealMethodBlocked: false,
    },
    responses: [
      {
        ruleId: "unsupported-drivers",
        observed: "16.7% 的驱动指标没有任何 fact 或 calculation 证据支撑",
        response: "blocked",
        note: "付费率的分子分母公司均未单独披露，只能按年报用户口径区间估算。",
        blockedBy: [
          {
            dataItem: "月均付费用户数与在线音乐服务月活",
            whyNeeded: "两者相除即付费率，可把该驱动从推断升级为可复算",
            whereToGet: "年报「在线音乐服务」经营数据表；公司业绩发布会材料同一页",
          },
        ],
      },
    ],
  };
  const { snapshotsDirectory } = makeTree([]);
  const filePath = snapshotFile(snapshotsDirectory, draft);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test("a blocked density response with no retrievable gap is rejected", () => {
  const draft = withUnsupportedDriver();
  draft.evidenceDensity = {
    computed: {
      unavailableShare: "0.1429",
      inferenceShare: "0.2000",
      lowConfidenceDriverShare: "0.1667",
      unsupportedDriverShare: "0.1667",
      idealMethodBlocked: false,
    },
    responses: [
      {
        ruleId: "unsupported-drivers",
        observed: "16.7% 的驱动指标没有任何 fact 或 calculation 证据支撑",
        response: "blocked",
        note: "需要更多数据。",
      },
    ],
  };
  const { snapshotsDirectory } = makeTree([]);
  const filePath = snapshotFile(snapshotsDirectory, draft);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /blockedBy/);
});

test("answering a density rule that did not fire is rejected", () => {
  const draft = clone(baseSnapshot);
  draft.evidenceDensity = {
    computed: { ...BASE_DENSITY },
    responses: [
      {
        ruleId: "inference-heavy-evidence",
        observed: "无",
        response: "acknowledged",
        note: "顺手写一条以示谨慎。",
      },
    ],
  };
  const { snapshotsDirectory } = makeTree([]);
  const filePath = snapshotFile(snapshotsDirectory, draft);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /未触发的规则/);
});

test("the skeleton sentinels the density statistics and starts with no responses", () => {
  const { root } = makeTree([baseSnapshot]);
  const result = newSnapshot([fixtureCompany, "--at", "2026-09-02-1000", "--stdout", "--root", root]);

  assert.equal(result.status, 0, result.stderr);
  const skeleton = JSON.parse(result.stdout);
  assert.equal(skeleton.evidenceDensity.computed.unavailableShare, SENTINEL);
  assert.equal(skeleton.evidenceDensity.computed.idealMethodBlocked, false);
  assert.deepEqual(skeleton.evidenceDensity.responses, []);
});

test("a moat pointing at a driver that does not exist is rejected by name", () => {
  const draft = clone(baseSnapshot);
  draft.businessModel.moat[0].driverIds = ["subscription-mix", "brand-strength"];
  const { snapshotsDirectory } = makeTree([]);
  const filePath = snapshotFile(snapshotsDirectory, draft);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 1);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /businessModel\.moat\.0\.driverIds/);
  assert.match(output, /brand-strength/);
  assert.match(output, /catalog-social-lock/, "the message should name the offending moat");
});

test("a moat typed 其他 must say what it actually is", () => {
  const draft = clone(baseSnapshot);
  draft.businessModel.moat[0].type = "其他";
  const { snapshotsDirectory } = makeTree([]);
  const filePath = snapshotFile(snapshotsDirectory, draft);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /typeNote/);
});

test("more than three moats is a checklist, not a declaration, and is rejected", () => {
  const draft = clone(baseSnapshot);
  const base = draft.businessModel.moat[0];
  draft.businessModel.moat = ["a", "b", "c", "d"].map((suffix) => ({
    ...clone(base),
    id: `${base.id}-${suffix}`,
  }));
  const { snapshotsDirectory } = makeTree([]);
  const filePath = snapshotFile(snapshotsDirectory, draft);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /businessModel\.moat/);
});

test("a moat whose trend moved warns without blocking", () => {
  const next = successor(baseSnapshot);
  next.businessModel.moat[0].trend = "变窄";
  const { snapshotsDirectory } = makeTree([baseSnapshot]);
  const filePath = snapshotFile(snapshotsDirectory, next);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /catalog-social-lock/);
  assert.match(output, /稳定/);
  assert.match(output, /变窄/);
});

test("a dropped moat warns without blocking, unlike a dropped driver", () => {
  const next = successor(baseSnapshot);
  next.businessModel.moat = [
    { ...clone(baseSnapshot.businessModel.moat[0]), id: "scale-cost-curve" },
  ];
  const { snapshotsDirectory } = makeTree([baseSnapshot]);
  const filePath = snapshotFile(snapshotsDirectory, next);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /护城河不再声明/);
  assert.match(output, /护城河新增/);
});

test("a disagreement anchored to a driver that does not exist is rejected", () => {
  const draft = clone(baseSnapshot);
  draft.valuation.disagreement.driverId = "competitive-intensity";
  const { snapshotsDirectory } = makeTree([]);
  const filePath = snapshotFile(snapshotsDirectory, draft);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 1);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /valuation\.disagreement\.driverId/);
  assert.match(output, /competitive-intensity/);
});

test("the skeleton carries a moat's structure forward but re-asks for its trend", () => {
  const { root } = makeTree([baseSnapshot]);
  const result = newSnapshot([fixtureCompany, "--at", "2026-09-01-1000", "--stdout", "--root", root]);

  assert.equal(result.status, 0, result.stderr);
  const skeleton = JSON.parse(result.stdout);
  const [moat] = skeleton.businessModel.moat;
  assert.equal(moat.id, "catalog-social-lock");
  assert.equal(moat.type, "转换成本");
  assert.deepEqual(moat.driverIds, ["subscription-mix", "paying-ratio"]);
  assert.equal(moat.breaker, baseSnapshot.businessModel.moat[0].breaker);
  assert.equal(moat.trend, SENTINEL, "the reading must be re-judged, never inherited");
  assert.deepEqual(moat.evidenceIds, [SENTINEL]);

  const { disagreement } = skeleton.valuation;
  assert.equal(disagreement.driverId, "paying-ratio", "which observable is disputed is calibration");
  assert.equal(disagreement.assumptionSetId, "issuer-guidance", "so is which seat it contrasts with");
  assert.equal(disagreement.marketAssumption, SENTINEL);
  assert.equal(disagreement.referenceAssumption, SENTINEL);
  assert.equal(disagreement.converged, false);
});

/** The seat the fixture's disagreement contrasts against. */
function seat(snapshot, id) {
  return snapshot.valuation.assumptionSets.find((set) => set.id === id);
}

test("an assumption set with no declared source bias is rejected", () => {
  const draft = clone(baseSnapshot);
  delete seat(draft, "sellside-consensus").sourceBias;
  const { snapshotsDirectory } = makeTree([]);
  const filePath = snapshotFile(snapshotsDirectory, draft);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /sourceBias/);
});

test("a declared but unsourced seat is legal when it says why, keeping it distinct from unchecked", () => {
  const draft = clone(baseSnapshot);
  const target = seat(draft, "sellside-consensus");
  target.status = "unavailable";
  target.reason = "港股无已登记的一致预期取数源，注册表第 3.1 节的 FMP 仅覆盖美股。";
  delete target.assumptions;
  delete target.components;
  delete target.computed;
  delete target.impliedExpectation;
  // The disagreement has to move off the seat it can no longer read.
  draft.valuation.disagreement.assumptionSetId = "historical-range";
  draft.valuation.disagreement.referenceAssumption = "历史区间对应的付费率停在五年均值。";
  const { snapshotsDirectory } = makeTree([]);
  const filePath = snapshotFile(snapshotsDirectory, draft);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test("an unsourced seat that does not say why is rejected", () => {
  const draft = clone(baseSnapshot);
  const target = seat(draft, "sellside-consensus");
  target.status = "unavailable";
  delete target.assumptions;
  delete target.components;
  delete target.computed;
  delete target.impliedExpectation;
  const { snapshotsDirectory } = makeTree([]);
  const filePath = snapshotFile(snapshotsDirectory, draft);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /reason/);
});

test("an unsourced seat that still carries numbers is rejected", () => {
  const draft = clone(baseSnapshot);
  const target = seat(draft, "sellside-consensus");
  target.status = "unavailable";
  target.reason = "公司不提供指引。";
  const { snapshotsDirectory } = makeTree([]);
  const filePath = snapshotFile(snapshotsDirectory, draft);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /不得填写/);
});

test("a valuation block where every seat is unsourced has nothing to compare a price against", () => {
  const draft = clone(baseSnapshot);
  for (const set of draft.valuation.assumptionSets) {
    set.status = "unavailable";
    set.reason = "本次未取到。";
    delete set.assumptions;
    delete set.components;
    delete set.computed;
    delete set.impliedExpectation;
  }
  delete draft.valuation.disagreement;
  const { snapshotsDirectory } = makeTree([]);
  const filePath = snapshotFile(snapshotsDirectory, draft);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 1);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /至少需要一组 available/);
  assert.match(output, /历史区间回归/, "the message should name the seat any ledger can compute");
});

test("a disagreement contrasted against an unsourced seat is rejected", () => {
  const draft = clone(baseSnapshot);
  const target = seat(draft, "issuer-guidance");
  target.status = "unavailable";
  target.reason = "公司自 FY2025 起不再提供全年指引。";
  delete target.assumptions;
  delete target.components;
  delete target.computed;
  delete target.impliedExpectation;
  const { snapshotsDirectory } = makeTree([]);
  const filePath = snapshotFile(snapshotsDirectory, draft);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 1);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /valuation\.disagreement\.assumptionSetId/);
  assert.match(output, /没有可对比的数字/);
});

test("a disagreement pointing at a seat that does not exist is rejected by name", () => {
  const draft = clone(baseSnapshot);
  draft.valuation.disagreement.assumptionSetId = "buyside-whisper";
  const { snapshotsDirectory } = makeTree([]);
  const filePath = snapshotFile(snapshotsDirectory, draft);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /buyside-whisper/);
});

test("a hand-written market capitalisation is caught against the engine", () => {
  const draft = clone(baseSnapshot);
  draft.summary.marketCap.value = "9000000000.00";
  const { snapshotsDirectory } = makeTree([]);
  const filePath = snapshotFile(snapshotsDirectory, draft);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 1);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /summary\.marketCap\.value/);
  assert.match(output, /8600000000\.00/);
  assert.match(output, /snapshot:sync/);
});

test("a market capitalisation timed differently from its own price is rejected", () => {
  const draft = clone(baseSnapshot);
  draft.summary.marketCap.asOf = "2026-08-01T08:00:00+08:00";
  const { snapshotsDirectory } = makeTree([]);
  const filePath = snapshotFile(snapshotsDirectory, draft);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /summary\.marketCap\.asOf/);
});

test("a hand-edited per-seat price implication is caught against the engine", () => {
  const draft = clone(baseSnapshot);
  seat(draft, "historical-range").impliedExpectation.multipleHigh = "9.00";
  const { snapshotsDirectory } = makeTree([]);
  const filePath = snapshotFile(snapshotsDirectory, draft);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 1);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /historical-range/);
  assert.match(output, /impliedExpectation\.multipleHigh/);
});

test("a multiple percentile computed on an unadjusted series is rejected", () => {
  // The distortion this blocks is silent: the number looks entirely normal.
  const draft = clone(baseSnapshot);
  draft.summary.multiplePercentile.adjustmentBasis = "不复权";
  const { snapshotsDirectory } = makeTree([]);
  const filePath = snapshotFile(snapshotsDirectory, draft);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 1);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /adjustmentBasis/);
  assert.match(output, /前复权/);
});

test("an unavailable multiple percentile is legal with a reason", () => {
  const draft = clone(baseSnapshot);
  draft.summary.multiplePercentile = {
    metricLabel: "P/E（正常化）",
    status: "unavailable",
    reason: "上市不足两年，没有足以构成分位的历史序列。",
    evidenceIds: [],
  };
  const { snapshotsDirectory } = makeTree([]);
  const filePath = snapshotFile(snapshotsDirectory, draft);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test("a percentile outside 0–100 is rejected", () => {
  const draft = clone(baseSnapshot);
  draft.summary.multiplePercentile.percentile = "112.0";
  const { snapshotsDirectory } = makeTree([]);
  const filePath = snapshotFile(snapshotsDirectory, draft);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /0–100/);
});

test("a vanished assumption set blocks until the reason is recorded", () => {
  const next = successor(baseSnapshot);
  next.valuation.assumptionSets = next.valuation.assumptionSets.filter(
    (set) => set.id !== "sellside-consensus",
  );
  const { snapshotsDirectory } = makeTree([baseSnapshot]);
  const filePath = snapshotFile(snapshotsDirectory, next);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 1);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /sellside-consensus/);
  assert.match(output, /assumptionSetChanges/);
  assert.match(output, /这次没查/, "the message should name what the record distinguishes");
});

test("a vanished assumption set is accepted once the reason is recorded", () => {
  const next = successor(baseSnapshot);
  next.valuation.assumptionSets = next.valuation.assumptionSets.filter(
    (set) => set.id !== "sellside-consensus",
  );
  next.thesisChange.assumptionSetChanges = [
    {
      assumptionSetId: "sellside-consensus",
      change: "removed",
      reason: "覆盖券商降到两家，聚合值不再构成一致预期。",
    },
  ];
  const { snapshotsDirectory } = makeTree([baseSnapshot]);
  const filePath = snapshotFile(snapshotsDirectory, next);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test("a newly introduced source has to say why it was introduced", () => {
  const next = successor(baseSnapshot);
  next.valuation.assumptionSets.push({
    ...clone(seat(baseSnapshot, "historical-range")),
    id: "short-report",
    sourceKind: "做空报告",
    sourceLabel: "某做空机构 2026-07 报告的自建模型",
    sourceBias: "报告作者持有空头仓位，其假设组合在方向上服务于该仓位。",
  });
  const { snapshotsDirectory } = makeTree([baseSnapshot]);
  const filePath = snapshotFile(snapshotsDirectory, next);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /short-report/);
});

test("a seat that keeps its id while changing source must declare the swap", () => {
  const next = successor(baseSnapshot);
  seat(next, "sellside-consensus").sourceLabel = "另一家数据商的聚合，覆盖 4 家券商";
  const { snapshotsDirectory } = makeTree([baseSnapshot]);
  const filePath = snapshotFile(snapshotsDirectory, next);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 1);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /sourceLabel/);
  assert.match(output, /redefined/);
});

test("the first 1.2.0 snapshot after a 1.1.0 one does not have to re-declare every seat", () => {
  // The generation boundary. Every one of the four covered companies hits this on
  // its first 1.2.0 run, and demanding an `added` record per seat there would be
  // asking each company to re-declare a contract change ADR-0021 already records.
  const frozen = JSON.parse(
    readFileSync(path.join(repoRoot, "tests", "fixtures", "prior-snapshot.json"), "utf8"),
  );
  frozen.snapshot.id = "2026-08-01-1000-analysis";
  frozen.snapshot.createdAt = "2026-08-01T10:00:00+08:00";
  frozen.snapshot.dataCutoff = "2026-08-01T09:00:00+08:00";

  const next = successor(baseSnapshot);
  const { snapshotsDirectory } = makeTree([frozen]);
  const filePath = snapshotFile(snapshotsDirectory, next);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /assumptionSetChanges/);
});

test("the frozen 1.1.0 generation is still verified against the engine that produced it", () => {
  // Those six snapshots are not migrated, so the only thing standing between a
  // committed file and a hand edit is that this verification still runs.
  const frozen = JSON.parse(
    readFileSync(path.join(repoRoot, "tests", "fixtures", "prior-snapshot.json"), "utf8"),
  );
  assert.equal(frozen.schemaVersion, "1.1.0");

  const { snapshotsDirectory } = makeTree([]);
  const clean = checkSnapshot([snapshotFile(snapshotsDirectory, frozen)]);
  assert.equal(clean.status, 0, `${clean.stdout}${clean.stderr}`);

  const tampered = clone(frozen);
  tampered.summary.fairValue.center = "120.0";
  const result = checkSnapshot([snapshotFile(snapshotsDirectory, tampered)]);
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /summary\.fairValue/);
});

test("a monthly driver is accepted when its period is written YYYY-MM", () => {
  const draft = clone(baseSnapshot);
  draft.driverMetrics[0].periodType = "month";
  draft.driverMetrics[0].period = "2026-01";
  const { snapshotsDirectory } = makeTree([]);
  const filePath = snapshotFile(snapshotsDirectory, draft);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test("a monthly driver written 2026 M1 is rejected before it can misorder", () => {
  const draft = clone(baseSnapshot);
  draft.driverMetrics[0].periodType = "month";
  draft.driverMetrics[0].period = "2026 M1";
  const { snapshotsDirectory } = makeTree([]);
  const filePath = snapshotFile(snapshotsDirectory, draft);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 1);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /driverMetrics\.0\.period/);
  assert.match(output, /YYYY-MM/);
});

test("the financial period ledger refuses a monthly period", () => {
  const draft = clone(baseSnapshot);
  draft.financialHistory.at(-1).periodType = "month";
  draft.financialHistory.at(-1).period = "2026-01";
  const { snapshotsDirectory } = makeTree([]);
  const filePath = snapshotFile(snapshotsDirectory, draft);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /financialHistory\.\d+\.periodType/);
});

test("snapshot:check warns about constraint churn without blocking", () => {
  const next = successor(baseSnapshot);
  next.constraints = [
    {
      id: "user-time-share",
      label: "用户时长份额",
      status: "恶化",
      explanation: "短视频平台继续挤占音乐收听时长。",
      evidenceIds: ["ev-annual-report"],
    },
  ];
  const { snapshotsDirectory } = makeTree([baseSnapshot]);
  const filePath = snapshotFile(snapshotsDirectory, next);

  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /警告|warning/i);
  assert.match(output, /content-licensing/);
});

test("snapshot:check --json emits machine-readable findings and still exits 0", () => {
  const broken = clone(baseSnapshot);
  broken.driverMetrics[0].trend = "上升";
  const { snapshotsDirectory } = makeTree([]);
  const filePath = snapshotFile(snapshotsDirectory, broken);

  const result = checkSnapshot([filePath, "--json"]);
  assert.equal(result.status, 0, "--json communicates through the payload, not the exit code");
  const payload = JSON.parse(result.stdout);
  assert.equal(Array.isArray(payload.errors), true);
  assert.ok(payload.errors.length > 0);
  assert.ok(payload.errors.some((message) => message.includes("driverMetrics.0.trend")));
});

test("snapshot:check --all walks an entire research tree", () => {
  const broken = successor(baseSnapshot);
  broken.driverMetrics[0].trend = "上升";
  const { root } = makeTree([baseSnapshot, broken]);

  const result = checkSnapshot(["--all", "--root", root, "--json"]);
  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.errors.some((message) => message.includes("2026-09-01-1000-analysis")));
});

test("the skeleton omits optional calibration the prior snapshot lacks", () => {
  // A percent driver has no currency. Sentinelling it would demand a value the
  // schema forbids, and the only valid fix is deleting the key.
  const { root } = makeTree([baseSnapshot]);
  const result = newSnapshot([fixtureCompany, "--at", "2026-09-01-1000", "--stdout", "--root", root]);
  assert.equal(result.status, 0, result.stderr);
  const skeleton = JSON.parse(result.stdout);

  for (const [index, driver] of skeleton.driverMetrics.entries()) {
    const prior = baseSnapshot.driverMetrics[index];
    if (prior.currency === undefined) {
      assert.equal(
        Object.hasOwn(driver, "currency"),
        false,
        `driver ${driver.id} must omit currency, not sentinel it`,
      );
    } else {
      assert.equal(driver.currency, prior.currency);
    }
  }
  for (const [index, metric] of skeleton.standardMetrics.entries()) {
    const prior = baseSnapshot.standardMetrics[index];
    assert.equal(Object.hasOwn(metric, "currency"), prior.currency !== undefined);
  }

  // A holding period is a stance, not a calibration.
  assert.equal(skeleton.investmentHorizon, SENTINEL);
});

test("a real company skeleton never sentinels an absent optional field", () => {
  const result = newSnapshot([
    "hk-9899-netease-cloud-music",
    "--at",
    "2026-09-01-1000",
    "--stdout",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const skeleton = JSON.parse(result.stdout);
  const offenders = [
    ...skeleton.driverMetrics.filter((driver) => driver.currency === SENTINEL).map((d) => d.id),
    ...skeleton.standardMetrics.filter((metric) => metric.currency === SENTINEL).map((m) => m.metricId),
  ];
  assert.deepEqual(offenders, [], "no field may be sentinelled that the schema wants absent");
});

test("snapshot:check reports sentinels and real schema errors together", () => {
  // Half-filled draft: one field genuinely wrong, others still placeholders.
  const draft = clone(baseSnapshot);
  draft.summary.businessModel = SENTINEL;
  draft.driverMetrics[0].trend = "上升";
  const { snapshotsDirectory } = makeTree([]);
  const filePath = snapshotFile(snapshotsDirectory, draft);

  const result = checkSnapshot([filePath, "--json"]);
  const payload = JSON.parse(result.stdout);
  assert.ok(
    payload.errors.some((message) => message.startsWith("sentinel: summary.businessModel")),
    "the placeholder must be reported",
  );
  assert.ok(
    payload.errors.some((message) => message.includes("schema: driverMetrics.0.trend")),
    "a schema error on an already-filled field must not be withheld until every placeholder is gone",
  );
});

test("snapshot:check suppresses schema noise that the sentinels themselves cause", () => {
  const { root } = makeTree([]);
  const generated = newSnapshot(["hk-0003-blank-co", "--at", "2026-09-01-1000", "--root", root]);
  assert.equal(generated.status, 0, generated.stderr);
  const target = path.join(
    root, "research", "companies", "hk-0003-blank-co", "snapshots", "2026-09-01-1000-analysis.json",
  );

  const result = checkSnapshot([target, "--json"]);
  const payload = JSON.parse(result.stdout);
  const schemaErrors = payload.errors.filter((message) => message.startsWith("schema:"));
  assert.deepEqual(schemaErrors, [], "an untouched skeleton must not produce a wall of schema errors");
  assert.ok(payload.errors.every((message) => message.startsWith("sentinel:")));
});

test("schema errors carry the offending value", () => {
  const broken = clone(baseSnapshot);
  broken.driverMetrics[0].trend = "上升";
  const { snapshotsDirectory } = makeTree([]);
  const filePath = snapshotFile(snapshotsDirectory, broken);
  const payload = JSON.parse(checkSnapshot([filePath, "--json"]).stdout);
  const issue = payload.errors.find((message) => message.includes("driverMetrics.0.trend"));
  assert.match(issue, /实际值 "上升"/);
});

test("only the explicitly listed legacy snapshot escapes the continuity contract", () => {
  // The Cloud Music pair genuinely breaks driver continuity. That is history we
  // chose not to rewrite, so it must not block every future turn.
  const exempt = checkSnapshot([
    path.join(
      repoRoot, "research", "companies", "hk-9899-netease-cloud-music", "snapshots",
      "2026-07-31-1927-analysis.json",
    ),
  ]);
  assert.equal(exempt.status, 0, `${exempt.stdout}${exempt.stderr}`);

  // Backdating must NOT buy an exemption — the allowlist is by identity, not date.
  const backdated = successor(baseSnapshot, "2026-01-02-1000-analysis");
  backdated.snapshot.createdAt = "2026-01-02T10:00:00+08:00";
  backdated.snapshot.dataCutoff = "2026-01-02T09:00:00+08:00";
  backdated.driverMetrics = backdated.driverMetrics.filter((d) => d.id !== "content-cost-ratio");
  const older = clone(baseSnapshot);
  older.snapshot.id = "2026-01-01-1000-analysis";
  older.snapshot.createdAt = "2026-01-01T10:00:00+08:00";
  older.snapshot.dataCutoff = "2026-01-01T09:00:00+08:00";
  const { snapshotsDirectory } = makeTree([older]);
  const filePath = snapshotFile(snapshotsDirectory, backdated);
  const result = checkSnapshot([filePath]);
  assert.equal(result.status, 1, "a backdated snapshot must still be governed");
  assert.match(`${result.stdout}${result.stderr}`, /content-cost-ratio/);
});

test("constraint-churn warnings reach the hook payload without blocking", () => {
  const next = successor(baseSnapshot);
  next.constraints = [
    {
      id: "user-time-share",
      label: "用户时长份额",
      status: "恶化",
      explanation: "短视频平台继续挤占音乐收听时长。",
      evidenceIds: ["ev-annual-report"],
    },
  ];
  next.driverMetrics = next.driverMetrics.filter((d) => d.id !== "content-cost-ratio");
  const { root, snapshotsDirectory } = makeTree([baseSnapshot]);
  snapshotFile(snapshotsDirectory, next);

  const script = path.join(repoRoot, "scripts", "research", "validate_research_paths.py");
  const blocked = spawnSync("python3", [script, "--hook", "--root", root], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(blocked.status, 0);
  const payload = JSON.parse(blocked.stdout);
  assert.equal(payload.decision, "block");
  assert.match(payload.reason, /content-licensing/, "the constraint warning must not be discarded");
  assert.match(payload.reason, /不阻断/);
});

test("--help succeeds on both commands", () => {
  assert.equal(newSnapshot(["--help"]).status, 0);
  assert.equal(checkSnapshot(["--help"]).status, 0);
});

test("the real research tree passes the hook that guards every turn", () => {
  const result = checkSnapshot(["--all", "--json"]);
  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(
    payload.errors,
    [],
    "committed research must never leave the repository in a permanently blocked state",
  );
});

test("the published snapshots stay valid without the new optional field", () => {
  const published = path.join(
    repoRoot,
    "research",
    "companies",
    "hk-9899-netease-cloud-music",
    "snapshots",
  );
  for (const stem of ["2026-03-26-2203-analysis", "2026-07-31-1927-analysis"]) {
    const snapshot = JSON.parse(readFileSync(path.join(published, `${stem}.json`), "utf8"));
    assert.equal(
      snapshot.thesisChange.driverChanges,
      undefined,
      "existing snapshots predate driverChanges and must stay legal",
    );
    const result = checkSnapshot([path.join(published, `${stem}.json`), "--json"]);
    const payload = JSON.parse(result.stdout);
    const schemaErrors = payload.errors.filter((message) => message.startsWith("schema:"));
    assert.deepEqual(schemaErrors, [], `${stem} must remain schema-valid`);
  }
});

test("the research path validator blocks through the shared hook contract", () => {
  const script = path.join(repoRoot, "scripts", "research", "validate_research_paths.py");
  const clean = spawnSync("python3", [script, "--hook"], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(clean.status, 0, "hook mode always exits 0");
  assert.deepEqual(JSON.parse(clean.stdout), {}, "a clean tree produces an empty hook payload");

  const broken = clone(baseSnapshot);
  broken.driverMetrics[0].trend = "上升";
  const { root } = makeTree([broken]);
  const blocked = spawnSync("python3", [script, "--hook", "--root", root], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(blocked.status, 0, "hook mode always exits 0");
  const payload = JSON.parse(blocked.stdout);
  assert.equal(payload.decision, "block");
  assert.match(payload.reason, /driverMetrics\.0\.trend/, "schema findings reach the hook payload");
  assert.match(payload.reason, /不要询问用户/);
});

test("the research path validator still catches malformed snapshot names", () => {
  const { root } = makeTree([baseSnapshot]);
  writeFileSync(
    path.join(root, "research", "companies", fixtureCompany, "snapshots", "draft.json"),
    "{}\n",
  );
  const script = path.join(repoRoot, "scripts", "research", "validate_research_paths.py");
  const result = spawnSync("python3", [script, "--root", root], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /draft\.json/);
});
