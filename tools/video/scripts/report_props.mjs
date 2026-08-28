/**
 * 分镜文案 JSON + 音频时长清单 → Remotion composition props。
 *
 * 纯函数、不碰文件系统，所以 render.mjs 和 tests/video-report-props.test.mjs 用的是同一份
 * 换算逻辑：每个分镜的画面帧数由它自己的音频时长决定，而不是反过来给音频派一个时长。
 *
 * 对齐口径（两处都必须一致，否则画面切点会和音轨越走越偏）：
 *   1. 单条音频取 `containerDurationSeconds ?? durationSeconds`——前者是 mp3 文件实际长度，
 *      后者是引擎边界事件给的朗读时长、不含尾部静音，逐条少算 0.05~0.07s 会累积成漂移。
 *   2. 帧数一律向上取整再加 `scenePadSeconds` 的留白：画面时长永远 ≥ 音频时长，
 *      宁可句末多留几帧，也绝不让画面切早半句把音频截掉。
 *   3. 拼接音轨时按同一个「帧量化后的时长」给每段补静音（见 render.mjs 的 apad），
 *      于是第 N 段音频的起点恰好落在第 N 个 Sequence 的第一帧上，零漂移。
 */

const KINDS = new Set(["opening", "dimension", "strategy", "closing"]);

export class ReportPropsError extends Error {}

const fail = (message) => {
  throw new ReportPropsError(message);
};

/** 拿 scene 的音频秒数：容器长度优先，缺了退回朗读时长，都没有才算没有。 */
export function audioSecondsOf(entry) {
  for (const key of ["containerDurationSeconds", "durationSeconds"]) {
    const value = entry?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

/**
 * 音频清单按 id 认领分镜。id 允许重复（tts_batch.py 只保证文件名唯一），
 * 所以同 id 的按出现顺序先到先得；认不出来的直接报错，不静默配错音。
 */
function claimEntries(manifest) {
  const entries = manifest?.scenes;
  if (!Array.isArray(entries)) fail("音频清单里找不到 scenes 数组，manifest.json 结构不对");
  const byId = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") fail("音频清单的 scenes 里有非对象元素");
    const id = typeof entry.id === "string" ? entry.id : null;
    if (!id) fail(`音频清单第 ${entry.index ?? "?"} 条没有 id`);
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(entry);
  }
  return {
    claim(id) {
      const queue = byId.get(id);
      if (!queue || queue.length === 0) return null;
      return queue.shift();
    },
    remaining() {
      return [...byId.values()].flatMap((queue) => queue).map((entry) => entry.id);
    },
  };
}

/**
 * @param {object} args
 * @param {object} args.storyboard 分镜文案 JSON（script_gen.py 产出）
 * @param {object|null} args.manifest 音频时长清单（tts_batch.py 产出）；给 null 走无音轨预览
 * @param {number} args.fps
 * @param {number} args.scenePadSeconds 每条分镜句末留白
 * @param {string|null} args.audioTrack 拼接后的音轨文件名（相对 public 目录）
 */
export function buildReportProps({ storyboard, manifest = null, fps = 30, scenePadSeconds = 0.2, audioTrack = null }) {
  if (!Number.isInteger(fps) || fps <= 0) fail(`fps 必须是正整数，收到 ${fps}`);
  if (!Number.isFinite(scenePadSeconds) || scenePadSeconds < 0) fail(`scenePadSeconds 必须 ≥ 0，收到 ${scenePadSeconds}`);

  const rawScenes = storyboard?.scenes;
  if (!Array.isArray(rawScenes) || rawScenes.length === 0) fail("分镜文案里找不到 scenes 数组，或者是空的");

  const claims = manifest ? claimEntries(manifest) : null;
  const padFrames = Math.round(scenePadSeconds * fps);

  let cursor = 0;
  const segments = [];
  const scenes = rawScenes.map((scene, index) => {
    if (!scene || typeof scene !== "object") fail(`第 ${index + 1} 条分镜不是对象`);
    const id = typeof scene.id === "string" && scene.id ? scene.id : `scene-${String(index + 1).padStart(2, "0")}`;
    const kind = KINDS.has(scene.kind) ? scene.kind : "closing";

    const entry = claims ? claims.claim(id) : null;
    if (claims && !entry) fail(`分镜 ${id}（第 ${index + 1} 条）在音频清单里没有对应条目，先重跑 tts:batch`);

    // 有音频听音频，没音频（预览模式）才退回生成器的估时；两者都没有给 1 秒兜底，
    // 免得 durationInFrames 变成 0 让整条 composition 报错。
    const audioSeconds = entry ? audioSecondsOf(entry) : null;
    const seconds = audioSeconds ?? (typeof scene.estimatedSeconds === "number" ? scene.estimatedSeconds : 1);
    const durationInFrames = Math.max(1, Math.ceil(seconds * fps) + padFrames);

    if (entry) {
      segments.push({
        id,
        audio: entry.audio,
        audioSeconds: audioSeconds ?? 0,
        // 音轨里这一段要被补静音到的长度，正好等于画面帧数换算回来的秒数
        quantizedSeconds: durationInFrames / fps,
      });
    }

    const from = cursor;
    cursor += durationInFrames;
    return {
      id,
      kind,
      title: typeof scene.title === "string" ? scene.title : id,
      narration: typeof scene.narration === "string" ? scene.narration : "",
      data: scene.data && typeof scene.data === "object" ? scene.data : {},
      from,
      durationInFrames,
      audioSeconds,
    };
  });

  if (claims) {
    const leftover = claims.remaining();
    if (leftover.length > 0) fail(`音频清单里多出没有分镜认领的条目：${leftover.join("、")}`);
  }

  const meta = storyboard.meta && typeof storyboard.meta === "object" ? storyboard.meta : {};
  const props = {
    fps,
    companyName: storyboard.companyName ?? meta.companyName ?? "未命名公司",
    companyId: storyboard.companyId ?? meta.companyId ?? null,
    dataCutoff: meta.dataCutoff ?? null,
    dimensions: dimensionsOf(scenes),
    scenes,
    audioTrack: audioTrack ?? null,
    totals: {
      durationInFrames: cursor,
      videoSeconds: Number((cursor / fps).toFixed(3)),
      audioSeconds: Number(segments.reduce((sum, s) => sum + s.audioSeconds, 0).toFixed(3)),
      sceneCount: scenes.length,
    },
  };
  return { props, segments };
}

/**
 * 七维度图表的数据只从维度分镜本身取，不去读 financials-summary.json——
 * 模板的输入契约就是「分镜文案 + 音频清单」两份，多读一份就等于多一处能对不上的地方。
 */
function dimensionsOf(scenes) {
  return scenes
    .filter((scene) => scene.kind === "dimension")
    .map((scene) => {
      const score = typeof scene.data.score === "number" && Number.isFinite(scene.data.score) ? scene.data.score : null;
      return {
        id: typeof scene.data.dimensionId === "string" ? scene.data.dimensionId : scene.id,
        title: scene.title,
        score,
        // 分数缺失时优先播生成器写好的说法（「暂无评分」），它没写才用通用空态文案
        scoreLabel: typeof scene.data.scoreLabel === "string" && scene.data.scoreLabel ? scene.data.scoreLabel : score === null ? "暂无数据" : `${score} 分`,
      };
    });
}
