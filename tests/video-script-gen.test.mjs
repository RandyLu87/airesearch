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
const companyDir = (id) => path.join(repoRoot, "research", "companies", id);
const biliSummary = path.join(companyDir("us-bili-bilibili"), "financials-summary.json");
const biliAnalysis = path.join(companyDir("us-bili-bilibili"), "financials-analysis.json");

/**
 * 跑一次生成，返回 { code, script }。
 *
 * `analysis` 给了就走详解版（目标 4-5 分钟），不给就是纯总结模式（目标 2-3 分钟）——
 * 这个分流本身就是契约的一部分，所以两条路都要有测试直接走。
 */
function run(summary, args = [], analysis = null) {
  const dir = mkdtempSync(path.join(tmpdir(), "airesearch-script-"));
  try {
    const file = path.join(dir, "financials-summary.json");
    writeFileSync(file, JSON.stringify(summary));
    const extra = [];
    if (analysis) {
      const analysisFile = path.join(dir, "financials-analysis.json");
      writeFileSync(analysisFile, JSON.stringify(analysis));
      extra.push("--analysis", analysisFile);
    }
    const result = spawnSync("python3", [generator, "--summary", file, ...extra, ...args], { encoding: "utf8" });
    return { code: result.status, script: result.stdout.trim() ? JSON.parse(result.stdout) : null, stderr: result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const bili = () => JSON.parse(readFileSync(biliSummary, "utf8"));
const biliDeep = () => JSON.parse(readFileSync(biliAnalysis, "utf8"));
/** 详解版跑法：总结 + 维度分析两份都给。 */
const runDeep = (summary = bili(), args = [], analysis = biliDeep()) => run(summary, args, analysis);
const sceneById = (script, id) => script.scenes.find((scene) => scene.id === id);
const kindsOf = (script, kind) => script.scenes.filter((scene) => scene.kind === kind);

test("纯总结模式：时长落进 2-3 分钟，七个维度一个不少", () => {
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

test("advice 缺失但触发条件在时，裁剪级真的生效且 omissions 不与产出矛盾", () => {
  const summary = bili();
  summary.strategies.noPosition.advice = { status: "unavailable", reason: "待补" };
  const { script } = run(summary, ["--min-seconds", "40", "--max-seconds", "80"]);

  // omissions 不得声称跳过了一个其实播出去了的策略
  const spokenStrategies = new Set(
    script.scenes.filter((scene) => scene.kind === "strategy").map((scene) => `strategies.${scene.data.strategyId}`),
  );
  for (const item of script.omissions) assert.ok(!spokenStrategies.has(item.path), `${item.path} 既播报又被记为跳过`);

  // 记了 strategy-drop-triggers 就必须真的一条触发条件都不剩
  if (script.adjustments.some((step) => step.step === "strategy-drop-triggers")) {
    for (const scene of script.scenes.filter((s) => s.kind === "strategy")) {
      assert.equal(scene.data.items.length, 0, `${scene.id} 记了裁剪却仍在播触发条件`);
      // 认模板拼的前缀「触发条件：」，不认裸词——建议正文本身就可能写着「非现阶段减仓触发条件」
      assert.ok(!scene.narration.includes("触发条件："), `${scene.id} 记了裁剪却仍在念触发条件`);
    }
  }
});

test("advice 缺失仍如实记一条 omission，正文播「暂无建议正文」", () => {
  const summary = bili();
  summary.strategies.noPosition.advice = { status: "unavailable", reason: "待补" };
  const { script } = run(summary);

  const scene = sceneById(script, "strategy-noPosition");
  assert.ok(scene.narration.includes("暂无建议正文"));
  const omission = script.omissions.find((item) => item.path === "strategies.noPosition.advice");
  assert.ok(omission, "advice 缺失未记入 omissions");
  assert.equal(omission.reason, "待补");
});

test("confidence 超出 0-10 契约区间时，omission 说的是填错而不是没填", () => {
  const summary = bili();
  summary.dimensionSummary.find((d) => d.dimensionId === "valuation").confidence = 12;
  const { script } = run(summary);

  assert.ok(sceneById(script, "dimension-valuation").narration.includes("暂无评分"));
  const omission = script.omissions.find((item) => item.path === "dimensionSummary[valuation].confidence");
  assert.match(omission.reason, /不在 0-10 契约区间/);
});

test("形状违约的输入退 2，不与「产出了但超区间」的退 1 混淆", () => {
  for (const broken of [{ dimensionSummary: {} }, { dimensionSummary: ["oops"] }]) {
    const { code, script } = run(broken);
    assert.equal(code, 2);
    assert.equal(script, null);
  }
  const summary = bili();
  summary.strategies = [];
  const { code, stderr } = run(summary);
  assert.equal(code, 2);
  assert.match(stderr, /strategies/);
});

test("顶层 companyId / companyName 有值且与 meta 一致，tts_batch 的 manifest 才认得出公司", () => {
  // tts_batch.py 只读顶层这两个键，缺了会静默写出 null 的 manifest，不报错。
  const summary = bili();
  const { script } = run(summary);

  assert.equal(script.companyId, summary.meta.companyId);
  assert.equal(script.companyName, summary.meta.companyName);
  assert.ok(script.companyId && script.companyName);
  assert.equal(script.companyId, script.meta.companyId);
  assert.equal(script.companyName, script.meta.companyName);
});

test("扩展探针不得插入零内容的策略分镜——记了补播就必须真的补进了内容", () => {
  const summary = bili();
  for (const dimension of summary.dimensionSummary) dimension.conclusion = dimension.conclusion.slice(0, 8) + "。";
  // 契约模板原样的信号占位：块在、条目在，但每个字段都是 __TODO__
  for (const key of ["sellSignals", "addSignals"]) {
    summary.strategies[key] = { title: key, signals: [{ signal: "__TODO__", observable: "__TODO__" }] };
  }
  const { script } = run(summary, ["--min-seconds", "150", "--max-seconds", "210"]);

  // 反向断言：正文与触发条件都空的分镜不许存在，除非 omissions 指名道姓
  const named = new Set(script.omissions.map((item) => item.path));
  for (const scene of script.scenes.filter((s) => s.kind === "strategy")) {
    if (scene.data.advice || scene.data.items.length) continue;
    assert.ok(named.has(`strategies.${scene.data.strategyId}`), `${scene.id} 零内容却一条 omission 都没记`);
  }
  for (const step of script.adjustments.filter((s) => s.step === "strategy-add-class")) {
    const key = step.detail.replace("补充播报 ", "");
    const scene = sceneById(script, `strategy-${key}`);
    assert.ok(scene.data.advice || scene.data.items.length, `${step.detail} 补的是一条「暂无建议正文」`);
  }
});

test("正文与触发条件都缺时只记一条「已跳过」，不再同时声称「只播触发条件」", () => {
  const summary = bili();
  summary.strategies.noPosition = {
    title: "空仓者",
    advice: "__TODO__",
    triggers: [{ condition: "__TODO__", action: "__TODO__" }],
  };
  const { script } = run(summary);

  assert.equal(sceneById(script, "strategy-noPosition"), undefined);
  const paths = script.omissions.filter((item) => item.path.startsWith("strategies.noPosition")).map((i) => i.path);
  assert.deepEqual(paths, ["strategies.noPosition"], "分镜没播出去，却记了一条描述播报方式的 omission");
});

test("触发条件被控时裁掉后，omission 的 handling 跟着产出走而不是停在构造时", () => {
  const summary = bili();
  summary.strategies.noPosition.advice = { status: "unavailable", reason: "待补" };
  const { script } = run(summary, ["--min-seconds", "40", "--max-seconds", "80"]);

  const scene = sceneById(script, "strategy-noPosition");
  const omission = script.omissions.find((item) => item.path === "strategies.noPosition.advice");
  if (scene && !scene.data.items.length) {
    assert.ok(!omission.handling.includes("只播触发条件"), "触发条件已裁掉，handling 仍称在播");
    assert.ok(omission.handling.includes("未播报"));
  }
});

// ---------------------------------------------------------------- 详解版（--analysis）

/**
 * 详解版把第 2 步维度分析接进来，商业模式与护城河从「一句结论」变成核心段落。
 * 这一层最容易出的错不是崩，是**悄悄编内容**或**悄悄把核心裁光**，所以断言集中在
 * 三件事：深讲分镜的每个字都能在 analysis 原文里找到、控时压力下核心层最后才动、
 * 逐条点亮用的 sentenceIndex 真的指向 narration 里对应的那句。
 */

test("详解版：时长落进 4-5 分钟，商业模式与护城河深讲分镜齐全", () => {
  const { code, script } = runDeep();
  assert.equal(code, 0);
  assert.equal(script.totals.withinTarget, true);
  assert.ok(
    script.totals.estimatedSeconds >= 240 && script.totals.estimatedSeconds <= 300,
    `实际 ${script.totals.estimatedSeconds}s`,
  );
  assert.equal(script.meta.mode, "detailed");

  assert.equal(kindsOf(script, "business-model").length, 2);
  assert.equal(kindsOf(script, "moat-checklist").length, 1);
  assert.equal(kindsOf(script, "moat-trend").length, 1);
  assert.equal(kindsOf(script, "inquiry").length, 1);
  // 七维度一条不少：深讲是加料，不是替换
  assert.equal(kindsOf(script, "dimension").length, 7);
});

test("深讲分镜紧跟它对应的维度分镜，观众先听结论再听展开", () => {
  const { script } = runDeep();
  const order = script.scenes.map((scene) => scene.id);
  const at = (id) => order.indexOf(id);

  assert.ok(at("dimension-businessQuality") < at("business-model-revenue"));
  assert.ok(at("business-model-revenue") < at("business-model-economics"));
  assert.ok(at("business-model-economics") < at("dimension-moat"));
  assert.ok(at("dimension-moat") < at("moat-checklist"));
  assert.ok(at("moat-checklist") < at("moat-trend"));
  assert.ok(at("moat-trend") < at("moat-inquiry"));
  // 其余五维排在核心段落之后
  assert.ok(at("moat-inquiry") < at("dimension-management"));
});

test("收入结构逐字取自 analysis，不换算金额也不重算占比", () => {
  const analysis = biliDeep();
  const source = analysis.dimensions.businessEssence.analysis.revenueBreakdown;
  const scene = sceneById(runDeep().script, "business-model-revenue");

  assert.equal(scene.data.period, source.period);
  // 画面拿到的是**全部**业务线，一条不少：控时裁的是解说时间，不是报告内容
  assert.equal(scene.data.items.length, source.items.length);
  for (const [index, item] of scene.data.items.entries()) {
    assert.equal(item.segment, source.items[index].segment);
    // 金额换算成中文量级后，原文仍原样留在 revenueRaw 里，随时能回去核对换算对不对
    assert.equal(item.revenueRaw, source.items[index].revenue);
    // 占比不换算也不重算，逐字照抄
    assert.equal(item.sharePct, source.items[index].sharePct);
  }

  // 念到的那几条，金额与占比必须原样出现在解说里
  assert.ok(scene.data.spokenCount > 0 && scene.data.spokenCount <= scene.data.items.length);
  for (const item of scene.data.items.slice(0, scene.data.spokenCount)) {
    assert.ok(scene.narration.includes(item.revenue), `${item.revenue} 没有原样进解说`);
    assert.ok(scene.narration.includes(item.sharePct), `${item.sharePct} 没有原样进解说`);
  }
});

test("金额换算成中文量级，解说里不再出现「百万元CNY」这种中英混搭", () => {
  const scene = sceneById(runDeep().script, "business-model-revenue");
  assert.ok(!scene.narration.includes("百万元CNY"));
  assert.ok(!scene.narration.includes("CNY"));
  // 换算结果必须是精确的：11928.29 百万 = 119.28 亿
  assert.equal(scene.data.items[0].revenue, "119.28亿元");
  assert.equal(scene.data.items[0].revenueRaw, "11928.29百万元CNY");
});

test("原文没写量级或币种时不换算，并如实记一条", () => {
  const analysis = biliDeep();
  // AMD 与富途的原文就是这样：纯数字，既可能是百万也可能是亿
  analysis.dimensions.businessEssence.analysis.revenueBreakdown.items[0].revenue = "16635";

  const { script } = runDeep(bili(), ["--min-seconds", "120", "--max-seconds", "300"], analysis);
  const scene = sceneById(script, "business-model-revenue");
  assert.equal(scene.data.items[0].revenue, "16635", "没写单位却被猜了一个量级");
  assert.ok(
    script.omissions.some((item) => /没写量级或币种/.test(item.reason ?? "")),
    "没换算这件事没有记账",
  );
});

test("控时裁的是解说时间，不是画面内容：没念到的要点仍在 data 里", () => {
  const analysis = biliDeep();
  // 逼到最紧，让深讲全部降到 minimal
  const { script } = runDeep(bili(), ["--min-seconds", "150", "--max-seconds", "170"], analysis);

  const past = sceneById(script, "moat-trend").data.past;
  // 画面上的依据条数 = 原报告的条数，与念了几条无关
  assert.equal(past.points.length, past.pointsAvailable);
  assert.ok(past.spokenCount < past.pointsAvailable, "没有触发裁剪，这条断言就没意义");
  // 每一条被念到的依据都必须逐字出现在解说里；没念到的不出现，也不该有点亮时刻
  const trend = sceneById(script, "moat-trend");
  const spokenBeats = trend.data.beats.filter((beat) => beat.group === "past");
  assert.equal(spokenBeats.length, past.spokenCount);
  for (const beat of spokenBeats) assert.ok(trend.narration.includes(beat.text));
  for (const point of past.points.slice(past.spokenCount)) {
    assert.ok(!trend.narration.includes(point), `没念到的依据出现在解说里：${point}`);
  }
});

test("护城河清单逐条取自 analysis 的判定，不自己下结论", () => {
  const analysis = biliDeep();
  const types = analysis.dimensions.moat.analysis.types;
  const scene = sceneById(runDeep().script, "moat-checklist");

  assert.equal(scene.data.items.length, types.length);
  for (const [index, item] of scene.data.items.entries()) {
    assert.equal(item.type, types[index].type);
    assert.equal(item.verdict, types[index].verdict);
    assert.ok(scene.narration.includes(types[index].verdict));
  }
});

test("护城河趋势与十年之问取原文方向与回答", () => {
  const analysis = biliDeep();
  const moat = analysis.dimensions.moat;
  const trend = sceneById(runDeep().script, "moat-trend");
  const inquiry = sceneById(runDeep().script, "moat-inquiry");

  assert.equal(trend.data.past.direction, moat.analysis.trendPast5y.direction);
  assert.equal(trend.data.next.direction, moat.analysis.trendNext5y.direction);
  assert.ok(trend.narration.includes(moat.analysis.trendPast5y.direction));

  assert.equal(inquiry.data.question, moat.inquiry.question);
  // 回答按 ①②③ 拆成要点，每一条都必须是原文的子串
  assert.ok(inquiry.data.beats.length > 0);
  const answer = moat.inquiry.answer.replace(/\s+/g, "");
  for (const beat of inquiry.data.beats) {
    assert.ok(answer.includes(beat.text.replace(/\s+/g, "").replace(/。$/, "")), `要点不在原文里：${beat.text}`);
  }
});

test("每个要点的 sentenceIndex 指向 narration 里真正念它的那一句", () => {
  const { script } = runDeep();
  const deep = script.scenes.filter((scene) => Array.isArray(scene.data.beats));
  assert.ok(deep.length >= 5, "详解版应当有多条带要点的深讲分镜");

  for (const scene of deep) {
    const sentences = scene.narration.split(/(?<=[。！？!?])/).filter((s) => s.trim());
    for (const beat of scene.data.beats) {
      assert.ok(
        Number.isInteger(beat.sentenceIndex) && beat.sentenceIndex >= 0 && beat.sentenceIndex < sentences.length,
        `${scene.id} 的要点 sentenceIndex=${beat.sentenceIndex} 越界（共 ${sentences.length} 句）`,
      );
      const head = beat.text.replace(/\s+/g, "").slice(0, 8);
      assert.ok(
        sentences[beat.sentenceIndex].replace(/\s+/g, "").includes(head),
        `${scene.id} 的要点「${head}」不在第 ${beat.sentenceIndex} 句里：${sentences[beat.sentenceIndex]}`,
      );
    }
  }
});

test("URL 与字段路径引用既不进解说词也不进画面正文，且如实记账", () => {
  const analysis = biliDeep();
  analysis.dimensions.moat.inquiry.answer =
    "护城河大概率仍在，详见 https://example.com/report 与 moat.analysis.trendNext5y 的判断。";
  analysis.dimensions.businessEssence.analysis.stickiness.mechanism =
    "习惯与生态锁定，见 businessEssence.analysis.stickiness.evidence[0]。";

  const { script } = runDeep(bili(), [], analysis);
  const spoken = script.scenes.map((scene) => scene.narration).join("");
  const shown = JSON.stringify(script.scenes.map((scene) => scene.data));

  for (const noise of ["https://example.com/report", "moat.analysis.trendNext5y", "businessEssence.analysis.stickiness"]) {
    assert.ok(!spoken.includes(noise), `${noise} 被念了出来`);
    assert.ok(!shown.includes(noise), `${noise} 出现在画面数据里`);
  }
  assert.ok(
    script.omissions.some((item) => /URL|字段路径/.test(item.reason ?? "")),
    "过滤动作没有记进 omissions",
  );
});

test("紧贴在中文后面的字段引用照样摘掉，不靠前面有没有空格", () => {
  // 研究正文里「另见下方latestQuarterUpdate」这种写法没有分隔符，是最常见的形态。
  // 用 \w 做左边界会因为中文也算词字符而全部漏掉，这条就是钉住那个回归。
  const analysis = biliDeep();
  analysis.dimensions.businessEssence.analysis.revenueBreakdown.period =
    "FY2025，另见下方latestQuarterUpdate对最新一期的补充分析";
  analysis.dimensions.moat.analysis.trendPast5y.basis = "参考moat.analysis.trendNext5y的判断，护城河变宽。";

  const { script } = runDeep(bili(), ["--min-seconds", "120", "--max-seconds", "300"], analysis);
  const spoken = script.scenes.map((scene) => scene.narration).join("");
  assert.ok(!spoken.includes("latestQuarterUpdate"), "紧跟中文的字段名被念了出来");
  assert.ok(!spoken.includes("moat.analysis.trendNext5y"), "紧跟中文的字段路径被念了出来");
  // 同一段里的正常内容不能被误伤
  assert.ok(spoken.includes("FY2025"));
});

test("小写开头的商标不当成字段名摘掉", () => {
  const analysis = biliDeep();
  analysis.dimensions.moat.inquiry.answer = "iPhone与eBay渠道仍在，护城河大概率还在。";
  const { script } = runDeep(bili(), ["--min-seconds", "120", "--max-seconds", "300"], analysis);
  const spoken = script.scenes.map((scene) => scene.narration).join("");
  assert.ok(spoken.includes("iPhone"), "iPhone 被当成字段名摘掉了");
  assert.ok(spoken.includes("eBay"), "eBay 被当成字段名摘掉了");
});

test("公司英文名括注只在解说里摘掉，画面标题保留全称", () => {
  const { script } = runDeep();
  const opening = sceneById(script, "opening");
  assert.ok(opening.title.includes("Bilibili"), "画面标题丢了英文全称");
  assert.ok(!opening.narration.includes("Bilibili"), "开场把英文全称念了出来");
  assert.ok(opening.narration.includes("哔哩哔哩"));
});

test("证据里的 source 与 url 永不进入解说词", () => {
  const spoken = runDeep().script.scenes.map((scene) => scene.narration).join("");
  assert.ok(!spoken.includes("http"));
  assert.ok(!spoken.includes("globenewswire"));
  assert.ok(!spoken.includes("stockanalysis"));
});

test("analysis 缺失时降级为纯总结模式：产出照旧、退 0、如实记一条", () => {
  const { code, script } = run(bili());
  assert.equal(code, 0);
  assert.equal(script.meta.mode, "summary-only");
  assert.deepEqual(script.totals.targetRange, [120, 180]);
  assert.equal(kindsOf(script, "business-model").length, 0);
  assert.ok(script.omissions.some((item) => item.path === "analysis"));
});

test("analysis 在但护城河整块缺失：只跳过护城河深讲，商业模式照常", () => {
  const analysis = biliDeep();
  delete analysis.dimensions.moat;

  const { script } = runDeep(bili(), ["--min-seconds", "120", "--max-seconds", "300"], analysis);
  assert.equal(kindsOf(script, "moat-checklist").length, 0);
  assert.equal(kindsOf(script, "inquiry").length, 0);
  assert.equal(kindsOf(script, "business-model").length, 2);
  assert.ok(script.omissions.some((item) => item.path.startsWith("dimensions.moat")));
});

test("深讲字段是 __TODO__ 占位时不播，也不拿别的字段顶替", () => {
  const analysis = biliDeep();
  analysis.dimensions.moat.analysis.trendNext5y.basis = "__TODO__（预判逻辑与前提）";
  analysis.dimensions.businessEssence.analysis.revenueBreakdown.items[0].sharePct = "__TODO__";

  const { script } = runDeep(bili(), ["--min-seconds", "120", "--max-seconds", "300"], analysis);
  const spoken = script.scenes.map((scene) => scene.narration).join("");
  assert.ok(!spoken.includes("__TODO__"));
  assert.ok(!spoken.includes("预判逻辑与前提"));
  assert.ok(script.omissions.some((item) => item.path.includes("trendNext5y")));
});

test("控时压力下先裁快讲层与策略，核心层最后才动", () => {
  // 目标区间压到刚好放不下全部素材，逼出裁剪阶梯
  const { script } = runDeep(bili(), ["--min-seconds", "200", "--max-seconds", "230"]);
  const steps = script.adjustments.map((item) => item.step);
  const core = steps.findIndex((step) => step.startsWith("core-"));
  const fast = steps.findIndex((step) => step.startsWith("fast-"));

  assert.ok(fast >= 0, "快讲层一步都没裁，说明阶梯没走");
  if (core >= 0) assert.ok(fast < core, `核心层(${steps[core]})先于快讲层(${steps[fast]})被裁`);

  // 无论怎么裁，五条深讲分镜都还在——核心层可以变短，不能整块消失
  assert.equal(kindsOf(script, "business-model").length, 2);
  assert.equal(kindsOf(script, "moat-checklist").length, 1);
});

test("详解版同一份输入两次生成完全一致（确定性）", () => {
  assert.deepEqual(runDeep().script, runDeep().script);
});

test("详解版对其他公司同样跑通，没有哔哩哔哩专属逻辑", () => {
  for (const company of ["hk-0700-tencent-holdings", "sh-600519-kweichow-moutai", "us-nflx-netflix", "sh-600900-yangtze-power"]) {
    const summary = JSON.parse(readFileSync(path.join(companyDir(company), "financials-summary.json"), "utf8"));
    const analysis = JSON.parse(readFileSync(path.join(companyDir(company), "financials-analysis.json"), "utf8"));
    const { script } = run(summary, [], analysis);
    assert.equal(script.totals.withinTarget, true, `${company} 时长 ${script.totals.estimatedSeconds}s 未落进区间`);
    assert.ok(kindsOf(script, "business-model").length >= 1, `${company} 没有商业模式深讲`);
    assert.ok(!script.scenes.map((s) => s.narration).join("").includes("http"), `${company} 解说里有 URL`);
  }
});

test("公司名括注摘掉这件事本身也要记账，不能悄悄摘", () => {
  const { script } = runDeep();
  const omission = script.omissions.find((item) => item.path === "meta.companyName");
  assert.ok(omission, "解说里摘掉了英文括注却一条记录都没有");
  assert.match(omission.reason, /英文括注/);
});

test("降级为纯总结模式时，totals 里直接说清楚，而不是只留一条 omission", () => {
  const { script } = run(bili());
  // 看时长的人第一眼看 totals，「120-180 且达标」本身不会告诉任何人少了核心段落
  assert.match(script.totals.note, /纯总结模式/);
  assert.match(script.totals.note, /没有深讲分镜/);
  assert.equal(runDeep().script.totals.note, undefined, "详解版不该带降级说明");
});

test("策略的触发条件也逐条带点亮锚点，和深讲分镜一视同仁", () => {
  // 哔哩哔哩的建议正文够长，默认区间下触发条件总会被裁掉；把维度结论压短腾出时间，
  // 让触发条件真的播出来，这条断言才有东西可验。
  const summary = bili();
  for (const dimension of summary.dimensionSummary) dimension.conclusion = "结论很短。";
  const { script } = run(summary, ["--min-seconds", "150", "--max-seconds", "260"]);

  const withTriggers = kindsOf(script, "strategy").filter((scene) => scene.data.items.length > 0);
  assert.ok(withTriggers.length > 0, "没有一条策略播了触发条件，这条断言就没意义");

  for (const scene of withTriggers) {
    assert.equal(scene.data.beats.length, scene.data.items.length, `${scene.id} 的锚点与触发条件条数对不上`);
    const sentences = scene.narration.split(/(?<=[。！？!?])/).filter((s) => s.trim());
    for (const beat of scene.data.beats) {
      assert.ok(sentences[beat.sentenceIndex].includes("触发条件"), `${scene.id} 的锚点没指向触发条件那一句`);
    }
  }
});
