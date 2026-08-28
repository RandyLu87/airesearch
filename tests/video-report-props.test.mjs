import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { ReportPropsError, buildReportProps } from "../tools/video/scripts/report_props.mjs";

/**
 * Remotion 报告模板的时长换算 — tools/video/scripts/report_props.mjs。
 *
 * 这一层决定「画面切在哪一帧」，错了就是全片音画不同步，而音画不同步在成片里
 * 只能靠人耳发现。所以三件事必须自动验：帧数向上取整（画面永不截断音频）、
 * 容器时长优先于朗读时长（否则逐条少算会累积漂移）、分镜与音频对不上时报错而不是配错音。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const videoRoot = path.join(repoRoot, "tools", "video");
const biliStoryboard = path.join(videoRoot, "samples", "us-bili-bilibili.script.json");

const storyboardOf = (scenes, meta = {}) => ({
  companyId: "xx-demo-demo",
  companyName: "示例公司",
  meta: { companyId: "xx-demo-demo", companyName: "示例公司", dataCutoff: "2026-01-01", ...meta },
  scenes,
});

const dimensionScene = (id, score, extra = {}) => ({
  id: `dimension-${id}`,
  kind: "dimension",
  title: id,
  narration: "…",
  data: { dimensionId: id, ordinal: 1, score, scoreLabel: score === null ? "暂无评分" : `${score} 分`, conclusion: "结论。" },
  estimatedSeconds: 5,
  ...extra,
});

const manifestOf = (scenes) => ({ scenes });

test("帧数向上取整并加留白：画面时长永远 ≥ 音频时长", () => {
  const { props, segments } = buildReportProps({
    storyboard: storyboardOf([dimensionScene("moat", 6)]),
    manifest: manifestOf([{ index: 1, id: "dimension-moat", audio: "01.mp3", containerDurationSeconds: 7.968 }]),
    fps: 30,
    scenePadSeconds: 0.2,
  });
  // ceil(7.968 * 30) = 240 帧，加 6 帧留白
  assert.equal(props.scenes[0].durationInFrames, 246);
  assert.ok(props.scenes[0].durationInFrames / 30 >= 7.968);
  // 音轨补静音的目标长度必须等于画面帧数换算回来的秒数，否则拼接会漂移
  assert.equal(segments[0].quantizedSeconds, 246 / 30);
});

test("留白设 0 时也不会把音频截掉，帧数仍向上取整", () => {
  const { props } = buildReportProps({
    storyboard: storyboardOf([dimensionScene("moat", 6)]),
    manifest: manifestOf([{ index: 1, id: "dimension-moat", audio: "01.mp3", containerDurationSeconds: 7.9681 }]),
    fps: 30,
    scenePadSeconds: 0,
  });
  assert.equal(props.scenes[0].durationInFrames, 240);
  assert.ok(240 / 30 >= 7.9681);
});

test("容器时长优先于朗读时长；容器时长缺失才退回朗读时长", () => {
  const { props } = buildReportProps({
    storyboard: storyboardOf([dimensionScene("a", 6), dimensionScene("b", 6)]),
    manifest: manifestOf([
      { index: 1, id: "dimension-a", audio: "01.mp3", durationSeconds: 7.9, containerDurationSeconds: 8.4 },
      { index: 2, id: "dimension-b", audio: "02.mp3", durationSeconds: 7.9, containerDurationSeconds: null },
    ]),
    fps: 30,
    scenePadSeconds: 0,
  });
  assert.equal(props.scenes[0].audioSeconds, 8.4);
  assert.equal(props.scenes[1].audioSeconds, 7.9);
});

test("分镜首帧连续排布，总帧数等于各分镜之和", () => {
  const { props } = buildReportProps({
    storyboard: storyboardOf([dimensionScene("a", 6), dimensionScene("b", 6), dimensionScene("c", 6)]),
    manifest: manifestOf([
      { index: 1, id: "dimension-a", audio: "01.mp3", containerDurationSeconds: 3 },
      { index: 2, id: "dimension-b", audio: "02.mp3", containerDurationSeconds: 4 },
      { index: 3, id: "dimension-c", audio: "03.mp3", containerDurationSeconds: 5 },
    ]),
    fps: 30,
    scenePadSeconds: 0,
  });
  assert.deepEqual(
    props.scenes.map((scene) => [scene.from, scene.durationInFrames]),
    [
      [0, 90],
      [90, 120],
      [210, 150],
    ],
  );
  assert.equal(props.totals.durationInFrames, 360);
  assert.equal(props.totals.videoSeconds, 12);
});

test("分数缺失走空态：score 为 null，不当成 0 分", () => {
  const { props } = buildReportProps({
    storyboard: storyboardOf([dimensionScene("valuation", null)]),
    manifest: null,
  });
  assert.deepEqual(props.dimensions, [
    { id: "valuation", title: "valuation", score: null, scoreLabel: "暂无评分" },
  ]);
});

test("生成器没写 scoreLabel 时，空态兜底为「暂无数据」", () => {
  const scene = dimensionScene("valuation", null);
  delete scene.data.scoreLabel;
  const { props } = buildReportProps({ storyboard: storyboardOf([scene]), manifest: null });
  assert.equal(props.dimensions[0].scoreLabel, "暂无数据");
});

test("无音频清单时退回估时预览，且不挂音轨", () => {
  const { props, segments } = buildReportProps({
    storyboard: storyboardOf([dimensionScene("a", 6, { estimatedSeconds: 6.5 })]),
    manifest: null,
    fps: 30,
    scenePadSeconds: 0,
  });
  assert.equal(props.scenes[0].durationInFrames, 195);
  assert.equal(props.scenes[0].audioSeconds, null);
  assert.equal(props.audioTrack, null);
  assert.deepEqual(segments, []);
});

test("分镜与音频清单对不上时报错，不静默配错音", () => {
  const storyboard = storyboardOf([dimensionScene("a", 6), dimensionScene("b", 6)]);
  assert.throws(
    () =>
      buildReportProps({
        storyboard,
        manifest: manifestOf([{ index: 1, id: "dimension-a", audio: "01.mp3", containerDurationSeconds: 3 }]),
      }),
    (error) => error instanceof ReportPropsError && /dimension-b/.test(error.message),
  );
  assert.throws(
    () =>
      buildReportProps({
        storyboard: storyboardOf([dimensionScene("a", 6)]),
        manifest: manifestOf([
          { index: 1, id: "dimension-a", audio: "01.mp3", containerDurationSeconds: 3 },
          { index: 2, id: "dimension-zzz", audio: "02.mp3", containerDurationSeconds: 3 },
        ]),
      }),
    (error) => error instanceof ReportPropsError && /dimension-zzz/.test(error.message),
  );
});

test("同 id 的分镜按出现顺序各认领一条音频", () => {
  const { props } = buildReportProps({
    storyboard: storyboardOf([dimensionScene("a", 6), dimensionScene("a", 6)]),
    manifest: manifestOf([
      { index: 1, id: "dimension-a", audio: "01.mp3", containerDurationSeconds: 3 },
      { index: 2, id: "dimension-a", audio: "02.mp3", containerDurationSeconds: 9 },
    ]),
    fps: 30,
    scenePadSeconds: 0,
  });
  assert.deepEqual(
    props.scenes.map((scene) => scene.durationInFrames),
    [90, 270],
  );
});

test("哔哩哔哩样本：11 个分镜、七维度全在，估时预览落在 2-3 分钟", () => {
  const storyboard = JSON.parse(readFileSync(biliStoryboard, "utf8"));
  const { props } = buildReportProps({ storyboard, manifest: null, fps: 30, scenePadSeconds: 0.2 });
  assert.equal(props.scenes.length, 11);
  assert.equal(props.dimensions.length, 7);
  assert.equal(props.companyId, "us-bili-bilibili");
  assert.ok(props.dimensions.every((d) => typeof d.score === "number"));
  assert.ok(props.totals.videoSeconds > 120 && props.totals.videoSeconds < 180, `${props.totals.videoSeconds}s`);
  // 模板只吃分镜文案里已有的字段，不去读 financials-summary.json
  assert.deepEqual(
    props.scenes.map((scene) => scene.kind),
    ["opening", ...Array(7).fill("dimension"), "strategy", "strategy", "closing"],
  );
});

test("空分镜数组与非法 fps 直接报错", () => {
  assert.throws(() => buildReportProps({ storyboard: storyboardOf([]) }), ReportPropsError);
  assert.throws(() => buildReportProps({ storyboard: storyboardOf([dimensionScene("a", 6)]), fps: 0 }), ReportPropsError);
});

test("被控时裁光的策略卡仍带着 itemsAvailable，模板才能区分「本来就没有」和「没播报」", () => {
  const { props } = buildReportProps({
    storyboard: storyboardOf([
      {
        id: "strategy-noPosition",
        kind: "strategy",
        title: "尚未建仓",
        narration: "…",
        data: { strategyId: "noPosition", advice: "建议。", items: [], itemsAvailable: 4 },
        estimatedSeconds: 5,
      },
    ]),
    manifest: null,
  });
  assert.deepEqual(props.scenes[0].data.items, []);
  assert.equal(props.scenes[0].data.itemsAvailable, 4);
});

test("认不出的 kind 与缺 audio 的清单条目都是硬错，不静默兜底", () => {
  assert.throws(
    () => buildReportProps({ storyboard: storyboardOf([{ ...dimensionScene("a", 6), kind: "summary" }]) }),
    (error) => error instanceof ReportPropsError && /summary/.test(error.message),
  );
  assert.throws(
    () =>
      buildReportProps({
        storyboard: storyboardOf([dimensionScene("a", 6)]),
        manifest: manifestOf([{ index: 1, id: "dimension-a", containerDurationSeconds: 3 }]),
      }),
    (error) => error instanceof ReportPropsError && /audio/.test(error.message),
  );
});

// ---------------------------------------------------------------- 深讲分镜与句级时间轴

/**
 * 详解版新增四种深讲分镜，以及「字幕 + 要点逐条点亮」两条时间轴。
 *
 * 时间轴这层最容易出的错是**看起来对、其实错半句**：帧号越界、字幕用了口播改写稿、
 * 要点点亮的时刻和念到它的时刻差一句。这些在成片里只能靠人耳人眼发现，所以全部在这里验。
 */

const deepScene = (id, kind, extra = {}) => ({
  id,
  kind,
  title: id,
  narration: "第一句话。第二句话。第三句话。",
  data: { beats: [{ group: "g", text: "第二句话", sentenceIndex: 1 }] },
  estimatedSeconds: 6,
  ...extra,
});

/** 三句话的句级边界事件，和 narration 的三句一一对应。 */
const threeCues = [
  { kind: "SentenceBoundary", text: "第一句话。", start: 0, end: 2 },
  { kind: "SentenceBoundary", text: "第二句话。", start: 2, end: 5 },
  { kind: "SentenceBoundary", text: "第三句话。", start: 5, end: 9 },
];

test("四种深讲 kind 都认，帧数换算与其他分镜一视同仁", () => {
  const kinds = ["business-model", "moat-checklist", "moat-trend", "inquiry"];
  const { props } = buildReportProps({
    storyboard: storyboardOf(kinds.map((kind) => deepScene(`s-${kind}`, kind))),
    manifest: manifestOf(
      kinds.map((kind, index) => ({
        index: index + 1,
        id: `s-${kind}`,
        audio: `0${index + 1}.mp3`,
        containerDurationSeconds: 9,
      })),
    ),
    fps: 30,
    scenePadSeconds: 0,
  });
  assert.deepEqual(props.scenes.map((scene) => scene.kind), kinds);
  assert.ok(props.scenes.every((scene) => scene.durationInFrames === 270));
});

test("字幕帧号取自句级边界事件，一句一条", () => {
  const { props } = buildReportProps({
    storyboard: storyboardOf([deepScene("moat-trend", "moat-trend")]),
    manifest: manifestOf([
      { index: 1, id: "moat-trend", audio: "01.mp3", containerDurationSeconds: 9, cues: threeCues },
    ]),
    fps: 30,
    scenePadSeconds: 0,
  });
  assert.deepEqual(
    props.scenes[0].captions.map((caption) => [caption.text, caption.from, caption.durationInFrames]),
    [
      ["第一句话。", 0, 60],
      ["第二句话。", 60, 90],
      ["第三句话。", 150, 120],
    ],
  );
});

test("字幕文本用 narration 原文，不用 TTS 的口播改写稿", () => {
  const scene = deepScene("business-model-revenue", "business-model", {
    narration: "广告收入 10058.43 百万元 CNY。",
    data: { beats: [] },
  });
  const { props } = buildReportProps({
    storyboard: storyboardOf([scene]),
    manifest: manifestOf([
      {
        index: 1,
        id: "business-model-revenue",
        audio: "01.mp3",
        containerDurationSeconds: 6,
        text: "广告收入 10058.43 百万元 CNY。",
        normalizedText: "广告收入一百亿零五十八点四三百万元人民币。",
        cues: [{ kind: "SentenceBoundary", text: "广告收入一百亿零五十八点四三百万元人民币。", start: 0, end: 6 }],
      },
    ]),
    fps: 30,
  });
  assert.equal(props.scenes[0].captions[0].text, "广告收入 10058.43 百万元 CNY。");
});

test("要点的点亮帧号落在念它的那一句上", () => {
  const { props } = buildReportProps({
    storyboard: storyboardOf([deepScene("moat-checklist", "moat-checklist")]),
    manifest: manifestOf([
      { index: 1, id: "moat-checklist", audio: "01.mp3", containerDurationSeconds: 9, cues: threeCues },
    ]),
    fps: 30,
    scenePadSeconds: 0,
  });
  // sentenceIndex 1 → 第二句，边界事件说它从 2.0s 开始 → 第 60 帧
  assert.deepEqual(props.scenes[0].beats, [{ group: "g", text: "第二句话", sentenceIndex: 1, from: 60 }]);
});

test("句数与边界事件对不上时按字数比例兜底，不报错也不错位", () => {
  const { props } = buildReportProps({
    storyboard: storyboardOf([deepScene("inquiry", "inquiry")]),
    manifest: manifestOf([
      {
        index: 1,
        id: "inquiry",
        audio: "01.mp3",
        containerDurationSeconds: 9,
        // 引擎只给了一条边界事件，和 narration 的三句对不上
        cues: [{ kind: "SentenceBoundary", text: "整段", start: 0, end: 9 }],
      },
    ]),
    fps: 30,
    scenePadSeconds: 0,
  });
  const captions = props.scenes[0].captions;
  assert.equal(captions.length, 3);
  // 三句等长 → 均分 9 秒
  assert.deepEqual(captions.map((caption) => caption.from), [0, 90, 180]);
  assert.equal(props.scenes[0].beats[0].from, 90);
});

test("完全没有边界事件时仍有字幕，帧号不越界", () => {
  const { props } = buildReportProps({
    storyboard: storyboardOf([deepScene("inquiry", "inquiry")]),
    manifest: manifestOf([{ index: 1, id: "inquiry", audio: "01.mp3", containerDurationSeconds: 9 }]),
    fps: 30,
    scenePadSeconds: 0.2,
  });
  const scene = props.scenes[0];
  assert.equal(scene.captions.length, 3);
  for (const caption of scene.captions) {
    assert.ok(caption.from >= 0 && caption.from < scene.durationInFrames, `字幕起点 ${caption.from} 越界`);
    assert.ok(caption.from + caption.durationInFrames <= scene.durationInFrames, "字幕跑出了分镜时长");
  }
});

test("sentenceIndex 越界的要点退回分镜开头，不产出负数或越界帧号", () => {
  const scene = deepScene("moat-trend", "moat-trend", {
    data: { beats: [{ group: "g", text: "越界", sentenceIndex: 99 }, { group: "g", text: "负数", sentenceIndex: -1 }] },
  });
  const { props } = buildReportProps({
    storyboard: storyboardOf([scene]),
    manifest: manifestOf([{ index: 1, id: "moat-trend", audio: "01.mp3", containerDurationSeconds: 9, cues: threeCues }]),
    fps: 30,
  });
  assert.deepEqual(props.scenes[0].beats.map((beat) => beat.from), [0, 0]);
});

test("没有 beats 的分镜照样有字幕，beats 为空数组而不是缺字段", () => {
  const { props } = buildReportProps({
    storyboard: storyboardOf([dimensionScene("moat", 6)]),
    manifest: manifestOf([{ index: 1, id: "dimension-moat", audio: "01.mp3", containerDurationSeconds: 6 }]),
    fps: 30,
  });
  assert.deepEqual(props.scenes[0].beats, []);
  assert.ok(props.scenes[0].captions.length >= 1);
});
