import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * 分镜解说文案生成器 — tools/video/scripts/script_gen.py。
 *
 * 这个脚本要喂给 TTS 直接朗读，所以三件事必须守住，且都要能自动验：
 * 缺失字段如实说「暂无数据」而不是编一句、时长落在目标区间、裁剪动作全部记账。
 * 只要有一条破了，出去的就是一段听起来很顺但内容不实的解说词。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generator = path.join(repoRoot, "tools", "video", "scripts", "script_gen.py");
const biliSummary = path.join(repoRoot, "research", "companies", "us-bili-bilibili", "financials-summary.json");

/** 跑一次生成，返回 { code, script }。 */
function run(summary, args = []) {
  const dir = mkdtempSync(path.join(tmpdir(), "airesearch-script-"));
  try {
    const file = path.join(dir, "financials-summary.json");
    writeFileSync(file, JSON.stringify(summary));
    const result = spawnSync("python3", [generator, "--summary", file, ...args], { encoding: "utf8" });
    return { code: result.status, script: result.stdout.trim() ? JSON.parse(result.stdout) : null, stderr: result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const bili = () => JSON.parse(readFileSync(biliSummary, "utf8"));
const sceneById = (script, id) => script.scenes.find((scene) => scene.id === id);

test("哔哩哔哩样本：时长落进 2-3 分钟，七个维度一个不少", () => {
  const { code, script } = run(bili());
  assert.equal(code, 0);
  assert.equal(script.totals.withinTarget, true);
  assert.ok(script.totals.estimatedSeconds >= 120 && script.totals.estimatedSeconds <= 180);

  const dimensions = script.scenes.filter((scene) => scene.kind === "dimension");
  assert.equal(dimensions.length, 7);
  assert.equal(script.scenes.at(0).kind, "opening");
  assert.equal(script.scenes.at(-1).kind, "closing");
});

test("分数与结论逐字取自 summary，不重算也不改写", () => {
  const summary = bili();
  const { script } = run(summary);
  const valuation = summary.dimensionSummary.find((d) => d.dimensionId === "valuation");
  const scene = sceneById(script, "dimension-valuation");

  assert.equal(scene.data.score, valuation.confidence);
  assert.ok(scene.narration.includes(`信心度${valuation.confidence}分`));
  // 裁剪后的理由必须是原文的前缀（去掉句读与补的句号后逐字相同）
  const spoken = scene.data.conclusion.slice(0, 20);
  assert.ok(valuation.conclusion.replace(/\s+/g, "").startsWith(spoken.replace(/\s+/g, "").slice(0, 15)));
});

test("scoreBasis 与 basis 只供人工核对，不进解说词", () => {
  const { script } = run(bili());
  const narrations = script.scenes.map((scene) => scene.narration).join("");
  assert.ok(!narrations.includes("dimensions.valuation.analysis"));
  assert.ok(!narrations.includes("revenueBreakdown"));
});

test("unavailable / __TODO__ 播「暂无数据」并记进 omissions", () => {
  const summary = bili();
  summary.dimensionSummary[1].conclusion = { status: "unavailable", reason: "第 2 步护城河分析缺失" };
  summary.dimensionSummary[2].confidence = "__TODO__";

  const { script } = run(summary);
  assert.match(sceneById(script, "dimension-moat").narration, /暂无数据/);
  assert.match(sceneById(script, "dimension-management").narration, /暂无评分/);

  const paths = script.omissions.map((item) => item.path);
  assert.ok(paths.includes("dimensionSummary[moat].conclusion"));
  assert.ok(paths.includes("dimensionSummary[management].confidence"));
  assert.equal(
    script.omissions.find((item) => item.path === "dimensionSummary[moat].conclusion").reason,
    "第 2 步护城河分析缺失",
  );
});

test("超长素材按阶梯裁剪，每一步都记账而不是静默截断", () => {
  const { script } = run(bili(), ["--max-seconds", "60", "--min-seconds", "30"]);
  assert.ok(script.adjustments.length > 0);
  for (const step of script.adjustments) {
    assert.ok(step.step && step.detail);
    assert.notEqual(step.deltaSeconds, 0);
  }
});

test("阶梯走完仍超区间：带 warning 且退出码非 0，不假装达标", () => {
  const { code, script } = run(bili(), ["--max-seconds", "30", "--min-seconds", "10"]);
  assert.equal(code, 1);
  assert.equal(script.totals.withinTarget, false);
  assert.match(script.totals.warning, /仍在目标区间/);
});

test("素材不足时补播卖出/加仓信号，同样记账", () => {
  const summary = bili();
  for (const dimension of summary.dimensionSummary) dimension.conclusion = "结论很短。";
  const { script } = run(summary, ["--min-seconds", "150", "--max-seconds", "260"]);

  assert.ok(script.adjustments.some((step) => step.direction === "expand"));
  assert.ok(sceneById(script, "strategy-sellSignals"));
});

test("策略整块缺失时跳过策略分镜，其余照常产出", () => {
  const summary = bili();
  summary.strategies = {};
  const { script } = run(summary);
  assert.equal(script.scenes.filter((scene) => scene.kind === "strategy").length, 0);
  assert.equal(script.scenes.filter((scene) => scene.kind === "dimension").length, 7);
  assert.ok(script.omissions.some((item) => item.path === "strategies.noPosition"));
});

test("不符合契约的输入直接报错，不产出半份文案", () => {
  const { code, script, stderr } = run({ meta: {} });
  assert.equal(code, 2);
  assert.equal(script, null);
  assert.match(stderr, /dimensionSummary/);
});

test("同一份输入两次生成完全一致（确定性）", () => {
  const first = run(bili()).script;
  const second = run(bili()).script;
  assert.deepEqual(first, second);
});

test("对其他公司同样跑通，没有哔哩哔哩专属逻辑", () => {
  const others = ["hk-0700-tencent-holdings", "sh-600519-kweichow-moutai", "us-nflx-netflix"];
  for (const company of others) {
    const summary = JSON.parse(
      readFileSync(path.join(repoRoot, "research", "companies", company, "financials-summary.json"), "utf8"),
    );
    const { script } = run(summary);
    assert.ok(script.scenes.length >= 3, `${company} 分镜过少`);
    assert.equal(script.totals.withinTarget, true, `${company} 时长 ${script.totals.estimatedSeconds}s 未落进区间`);
  }
});
