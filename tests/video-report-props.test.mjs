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
