import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * 评估记账链路测试 — 研究流程第 7 步（docs/research/workflow/07-evaluation-and-feedback.md）。
 *
 * 把三个 Python 工具当子进程跑，断言它们写出的 JSONL：这是外部行为，不触碰任何
 * 内部函数。评估目录用环境变量指向临时目录，测试全程不读写真实的 research/evals/；
 * 公司夹具用临时公司目录，收尾删除。
 *
 * 不引入第二套测试基础设施：沿用 node --test，与发布链路测试同一个入口。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const toolsDir = path.join(repoRoot, "docs", "research", "tools");
const modelDir = path.join(repoRoot, "docs", "model");

const fixtureCompany = "us-tst-evals-fixture";
const fixtureDir = path.join(repoRoot, "research", "companies", fixtureCompany);

let evalsDir;
let workDir;

/** 直接照模板生成一份"全部填好"的实例，得分必然满分，与模板改动解耦。 */
function instanceFromTemplate(node) {
  if (Array.isArray(node)) return node.map(instanceFromTemplate);
  if (node && typeof node === "object") {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (["_spec", "_dimension", "_hint"].includes(key)) continue;
      out[key] = instanceFromTemplate(value);
    }
    return out;
  }
  if (typeof node === "string" && (node.includes("__TODO__") || node.includes(" | "))) {
    return "夹具值";
  }
  return node;
}

function buildFixtureFile(templateName, outName, meta) {
  const template = JSON.parse(readFileSync(path.join(modelDir, templateName), "utf8"));
  const instance = instanceFromTemplate(template);
  instance.meta = { ...(instance.meta ?? {}), ...meta };
  const outPath = path.join(fixtureDir, outName);
  writeFileSync(outPath, JSON.stringify(instance, null, 2));
  return outPath;
}

function runPython(script, args, extraEnv = {}) {
  return spawnSync("python3", [path.join(toolsDir, script), ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, AIRESEARCH_EVALS_DIR: evalsDir, ...extraEnv },
  });
}

function readJsonl(filename) {
  let raw;
  try {
    raw = readFileSync(path.join(evalsDir, filename), "utf8");
  } catch {
    return [];
  }
  return raw.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
}

let files;

before(() => {
  evalsDir = mkdtempSync(path.join(tmpdir(), "airesearch-evals-cli-"));
  workDir = mkdtempSync(path.join(tmpdir(), "airesearch-evals-work-"));
  mkdirSync(fixtureDir, { recursive: true });
  const meta = {
    companyId: fixtureCompany,
    companyName: "记账链路测试公司",
    dataCutoff: "2026-08-08",
  };
  files = {
    collection: buildFixtureFile("financials—model-template.json", "financials-collection.json", meta),
    analysis: buildFixtureFile("financials—analysis-template.json", "financials-analysis.json", meta),
    summary: buildFixtureFile("financials—summary-template.json", "financials-summary.json", meta),
  };
});

after(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
  rmSync(evalsDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

test("the validator records a run event on every invocation", () => {
  const passing = runPython("data_validator.py", [
    "check", "--collection", files.collection, "--analysis", files.analysis,
    "--summary", files.summary,
  ]);
  assert.equal(passing.status, 0, passing.stderr);

  // 未过也必须记：「第 4 步跑了几轮、是不是一次过」靠的正是失败那几行。
  const failing = runPython("data_validator.py", [
    "check", "--collection", files.collection, "--threshold", "11",
  ]);
  assert.equal(failing.status, 1);

  const events = readJsonl("events.jsonl").filter((e) => e.tool === "data_validator");
  assert.equal(events.length, 2, `expected two validate events, got ${events.length}`);
  assert.equal(events[0].company, fixtureCompany);
  assert.equal(events[0].exitCode, 0);
  assert.equal(events[1].exitCode, 1, "a failed gate must still be recorded");
  assert.equal(typeof events[0].scores.collection, "number");
});

test("the merge tool records a run event", () => {
  const merged = runPython("build_final.py", [
    "--collection", files.collection, "--analysis", files.analysis,
    "--summary", files.summary, "--out", path.join(workDir, "financials-final.json"),
  ]);
  assert.equal(merged.status, 0, merged.stderr);
  const events = readJsonl("events.jsonl").filter((e) => e.tool === "build_final");
  assert.equal(events.length, 1);
  assert.equal(events[0].company, fixtureCompany);
  assert.equal(events[0].exitCode, 0);
  assert.equal(events[0].companyName, "记账链路测试公司");
});

test("recording feedback merges events and rating into one record", () => {
  const ratingPath = path.join(workDir, "rating.json");
  writeFileSync(ratingPath, JSON.stringify({
    trust: 4, insight: 3, readability: 4, actionable: 2, density: 3,
    vsLast: "better", worstPart: "触发条件无法当天判定", defectStep: "summary",
    changedMyPosition: false, familiarIndustry: true,
    correctionMessages: 5, model: "test-model",
  }));

  const ran = runPython("research_feedback.py", [
    "--company", fixtureCompany, "--rating-json", ratingPath, "--no-publish",
  ]);
  assert.equal(ran.status, 0, ran.stderr);

  const runs = readJsonl("runs.jsonl");
  assert.equal(runs.length, 1);
  const run = runs[0];
  assert.equal(run.company, fixtureCompany);
  assert.equal(run.rating.trust, 4);
  assert.equal(run.rating.vsLast, "better");
  assert.equal(run.machine.correctionMessages, 5);
  // 机器指标取自运行事件，不靠人填：上面跑了两次校验，第二次是失败的。
  assert.equal(run.machine.validationRounds, 2);
  assert.equal(run.machine.firstPassValidation, true, "the first validation passed");
  assert.equal(run.companyName, "记账链路测试公司");

  // 「最差的一处」落地即是一条缺陷记录。
  const defects = readJsonl("defects.jsonl");
  assert.equal(defects.length, 1);
  assert.equal(defects[0].symptom, "触发条件无法当天判定");
  assert.equal(defects[0].step, "summary");
  assert.equal(defects[0].status, "open");
});

test("cost metrics degrade to empty values when no transcript matches", () => {
  const ratingPath = path.join(workDir, "rating-2.json");
  writeFileSync(ratingPath, JSON.stringify({
    trust: 3, insight: 3, readability: 3, actionable: 3, density: 3,
    vsLast: "same", worstPart: "第二条夹具缺陷",
    changedMyPosition: false, familiarIndustry: false,
  }));
  const emptyTranscripts = mkdtempSync(path.join(tmpdir(), "airesearch-transcripts-"));

  const ran = runPython("research_feedback.py", [
    "--company", fixtureCompany, "--rating-json", ratingPath,
    "--transcript-dir", emptyTranscripts, "--no-publish",
  ]);
  // 会话日志取不到只让成本字段为空，绝不阻断收尾——记账的准确性让位于流程的健壮性。
  assert.equal(ran.status, 0, ran.stderr);

  const runs = readJsonl("runs.jsonl");
  assert.equal(runs.length, 2, "append-only: the earlier record must survive");
  assert.equal(runs[0].rating.worstPart, "触发条件无法当天判定", "earlier row must not be rewritten");
  const latest = runs[1];
  assert.equal(latest.machine.costSource, "unavailable");
  assert.equal(latest.machine.outputTokens, null, "an unknown cost is null, never 0");
  assert.equal(typeof latest.machine.costReason, "string");
  rmSync(emptyTranscripts, { recursive: true, force: true });
});

test("an invalid rating writes nothing at all", () => {
  const before = { runs: readJsonl("runs.jsonl").length, defects: readJsonl("defects.jsonl").length };
  const ratingPath = path.join(workDir, "rating-bad.json");
  writeFileSync(ratingPath, JSON.stringify({
    trust: 9, insight: 3, readability: 4, actionable: 2, density: 3,
    vsLast: "nope", worstPart: "   ",
    changedMyPosition: "no", familiarIndustry: true,
  }));

  const ran = runPython("research_feedback.py", [
    "--company", fixtureCompany, "--rating-json", ratingPath, "--no-publish",
  ]);
  assert.equal(ran.status, 2);
  // 所有问题一次报全，而不是修一个报一个。
  for (const probe of ["trust", "vsLast", "worstPart", "changedMyPosition"]) {
    assert.equal(ran.stderr.includes(probe), true, `stderr must name ${probe}: ${ran.stderr}`);
  }
  assert.deepEqual(
    { runs: readJsonl("runs.jsonl").length, defects: readJsonl("defects.jsonl").length },
    before,
    "a rejected rating must not leave a partial record behind",
  );
});

test("an unknown company fails before writing anything", () => {
  const before = readJsonl("runs.jsonl").length;
  const ran = runPython("research_feedback.py", [
    "--company", "us-nope-not-a-company", "--rating-json", path.join(workDir, "rating.json"),
    "--no-publish",
  ]);
  assert.equal(ran.status, 2);
  assert.equal(readJsonl("runs.jsonl").length, before);
});
