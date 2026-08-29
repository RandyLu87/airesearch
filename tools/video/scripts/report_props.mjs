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

const KINDS = new Set([
  "opening",
  "dimension",
  "strategy",
  "closing",
  // 详解版的四种深讲分镜
  "business-model",
  "moat-overview",
  "moat-trend",
  "inquiry",
]);

export class ReportPropsError extends Error {}

const fail = (message) => {
  throw new ReportPropsError(message);
};

/** 与 script_gen.py 的 split_sentences 同一套切法，字幕才和解说词逐句对得上。 */
const splitSentences = (text) =>
  String(text ?? "")
    .split(/(?<=[。！？!?])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

/**
 * 一条字幕最多显示多少字。
 *
 * 版面推出来的：字幕框宽 1680px、字号 38px，一行约 44 个汉字，`CAPTION_MAX_LINES` 是 3 行。
 * 取 70 是留一行余量——超过 3 行时字幕框会从底部往上长，压住正文（护城河那一屏的
 * 五张判定卡就是这么被盖掉的）。**这个数改了要回去看 Scenes.tsx 的字幕版面常量。**
 */
const CAPTION_MAX_CHARS = 70;

/** 断句优先级：分号最靠得住，其次逗号顿号，最后括号收尾。 */
const CAPTION_BREAKS = ["；", ";", "，", ",", "、", "）", ")"];

/**
 * 把过长的一句切成几条字幕。**只在标点处切，不改一个字**。
 *
 * 解说词里一句话动辄一两百字（研究结论本来就是长句），整句铺在字幕条上会占五六行。
 * 切开之后每条各自计时，时间轴仍在原句的区间内按字数摊——不动 TTS 的句级对齐。
 */
const chunkSentence = (sentence, max = CAPTION_MAX_CHARS) => {
  const text = String(sentence ?? "");
  if (text.length <= max) return [text];

  const chunks = [];
  let rest = text;
  while (rest.length > max) {
    // 在上限之内找最靠后的一个断点：越靠后，切出来的每条越接近满行
    let cut = -1;
    for (const mark of CAPTION_BREAKS) {
      cut = Math.max(cut, rest.lastIndexOf(mark, max - 1));
    }
    // 上限内没有任何标点（长串数字、连写的专名）就硬切：宁可切在字中间，
    // 也不要让这一条撑爆字幕框——切错一个词是瑕疵，盖住正文不是
    const at = cut > 0 ? cut + 1 : max;
    chunks.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
};

/**
 * 每句话的起止秒数。
 *
 * 首选 TTS 的句级边界事件（中文音色一句一条，见 tts_engine.py）：那是**引擎实际念到
 * 哪里**的时刻，比任何估算都准。只有在句数对不上时才退回按字数比例摊——引擎换了、
 * 音色换成给 WordBoundary 的英文音色、或者解说词里有引擎不当作句末的标点，都会走到这条。
 * 兜底不报错是故意的：字幕差半拍是瑕疵，整条链路断掉不是。
 */
function sentenceSpans(sentences, cues, totalSeconds) {
  const boundaries = Array.isArray(cues) ? cues.filter((cue) => cue?.kind === "SentenceBoundary") : [];
  if (boundaries.length === sentences.length && boundaries.length > 0) {
    return sentences.map((_, index) => {
      const start = Number(boundaries[index].start) || 0;
      const end = index + 1 < boundaries.length ? Number(boundaries[index + 1].start) || start : totalSeconds;
      return [start, Math.max(start, end)];
    });
  }

  const lengths = sentences.map((sentence) => sentence.length);
  const totalLength = lengths.reduce((sum, length) => sum + length, 0) || 1;
  let consumed = 0;
  return sentences.map((_, index) => {
    const start = (consumed / totalLength) * totalSeconds;
    consumed += lengths[index];
    const end = index + 1 === sentences.length ? totalSeconds : (consumed / totalLength) * totalSeconds;
    return [start, end];
  });
}

/**
 * 一条分镜的字幕轨与要点点亮帧号。
 *
 * 字幕**文本取 narration 原文**，时间取边界事件：manifest 里的 `normalizedText` 是喂给
 * 引擎的口播改写稿（`35.11x PE` → `35.11倍市盈率`），念出来对、写在屏幕上却和报告对不上。
 */
function timelineOf(scene, entry, seconds, fps, durationInFrames) {
  const sentences = splitSentences(scene.narration);
  const spans = sentenceSpans(sentences, entry?.cues, seconds);
  const lastFrame = Math.max(0, durationInFrames - 1);
  const clampFrom = (value) => Math.min(lastFrame, Math.max(0, Math.round(value * fps)));

  // 逐句切成字幕条：一句太长就按标点分成几条，各自在**本句的时间区间内**按字数摊。
  // 切分只影响字幕，不动 TTS 的句级对齐，也不动 beats 认领的句下标。
  const captions = [];
  const firstCaptionOfSentence = [];
  sentences.forEach((text, index) => {
    const from = clampFrom(spans[index][0]);
    // 末句一路铺到分镜结尾：句末到画面切走之间的留白不该是一段没有字幕的空白
    const until = index + 1 === sentences.length ? durationInFrames : clampFrom(spans[index + 1][0]);
    const total = Math.max(1, until - from);

    firstCaptionOfSentence.push(captions.length);
    const chunks = chunkSentence(text);
    const chars = chunks.reduce((sum, chunk) => sum + chunk.length, 0) || 1;
    let consumed = 0;
    chunks.forEach((chunk, chunkIndex) => {
      const start = from + Math.round((consumed / chars) * total);
      consumed += chunk.length;
      const end = chunkIndex + 1 === chunks.length ? from + total : from + Math.round((consumed / chars) * total);
      captions.push({ text: chunk, from: start, durationInFrames: Math.max(1, end - start) });
    });
  });

  const rawBeats = Array.isArray(scene.data?.beats) ? scene.data.beats : [];
  const beats = rawBeats.map((beat) => {
    const index = Number.isInteger(beat?.sentenceIndex) ? beat.sentenceIndex : -1;
    // 认不出是哪一句就从分镜开头亮着：宁可早亮，也不要因为一条要点错位而整屏空着。
    // 下标认的是**句**，长句被切成几条字幕后要落到它的第一条上，否则要点会晚亮半句。
    const captionIndex = index >= 0 && index < firstCaptionOfSentence.length ? firstCaptionOfSentence[index] : -1;
    const from = captionIndex >= 0 ? captions[captionIndex].from : 0;
    return { ...beat, from };
  });

  return { captions, beats };
}

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
    // audio 缺了要在这里拦住，否则会一路漏到 path.resolve 抛裸 ERR_INVALID_ARG_TYPE
    if (typeof entry.audio !== "string" || !entry.audio) fail(`音频清单条目 ${id} 没有 audio 文件名`);
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
    // 认不出的 kind 会静默渲染成免责声明卡，画面和文案对不上；跟其他契约不符一样直接报错。
    if (!KINDS.has(scene.kind)) fail(`分镜 ${id}（第 ${index + 1} 条）的 kind=${JSON.stringify(scene.kind)} 不认识，可选：${[...KINDS].join(" / ")}`);
    const kind = scene.kind;

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
    const { captions, beats } = timelineOf(scene, entry, seconds, fps, durationInFrames);
    return {
      id,
      kind,
      title: typeof scene.title === "string" ? scene.title : id,
      narration: typeof scene.narration === "string" ? scene.narration : "",
      data: scene.data && typeof scene.data === "object" ? scene.data : {},
      // 图表与主数字整块透传，不在这里重算也不校验形状：数值口径的闸门在
      // scripts/visuals.py 一处守着，这里再判一次只会多出一个能和它对不上的地方。
      visuals: scene.visuals && typeof scene.visuals === "object" ? scene.visuals : null,
      // 字幕与要点的帧号都相对分镜起点，模板里直接当 Sequence 内的 frame 用
      captions,
      beats,
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
