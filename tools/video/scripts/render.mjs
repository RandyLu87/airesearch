#!/usr/bin/env node
/**
 * 分镜文案 JSON + 音频时长清单 → 成片 mp4。
 *
 *   node scripts/render.mjs --storyboard samples/us-bili-bilibili.script.json \
 *                           --manifest out/tts/us-bili-bilibili/manifest.json
 *
 * 三步，产物都留在 out/render/<slug>/ 下，方便逐步复核：
 *   1. props.json     —— 画面数据与每条分镜的帧数（换算在 scripts/report_props.mjs）
 *   2. public/track.<ext> —— 按分镜顺序拼好的完整音轨，每段补静音到与画面等长
 *   3. <slug>.mp4     —— remotion render 的输出
 *
 * 模板不认识任何一家公司：换 --storyboard / --manifest 就是另一家公司的片子。
 */

import {spawnSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {ReportPropsError, buildReportProps} from './report_props.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(projectRoot, '..', '..');
const remotionBin = path.join(projectRoot, 'node_modules', '.bin', 'remotion');

const USAGE = `用法：node scripts/render.mjs --storyboard <分镜文案.json> [选项]

  --storyboard <path>   必填，script_gen.py 产出的分镜文案 JSON
  --manifest <path>     tts_batch.py 产出的音频清单；省略则无声渲染（时长退回估时）
  --out <path>          输出 mp4，默认 out/render/<slug>/<slug>.mp4
  --fps <n>             默认 30
  --scene-pad <sec>     每条分镜句末留白，默认 0.2
  --min-seconds <sec>   总时长下限，仅告警，默认取分镜文案的 totals.targetRange
  --max-seconds <sec>   总时长上限，仅告警，默认取分镜文案的 totals.targetRange
  --still <frame>       只渲染某一帧的 png（排版自检用），不出 mp4
  --props-only          只生成 props.json 与音轨，不调 remotion
  --                    之后的参数原样透传给 remotion（如 --concurrency=4）
`;

function parseArgs(argv) {
  const opts = {
    storyboard: null,
    manifest: null,
    out: null,
    fps: 30,
    scenePad: 0.2,
    // null = 跟随分镜文案自己的 totals.targetRange（详解版 240-300、纯总结 120-180）；
    // 写死 120-180 会让每一支详解版都无端报一次「超出目标区间」。
    minSeconds: null,
    maxSeconds: null,
    still: null,
    propsOnly: false,
    passthrough: [],
  };
  // 一律按浮点解析，整数参数再单独校验——parseInt 会把 --fps 29.97 悄悄吃成 29。
  const numeric = {
    '--fps': ['fps', true],
    '--scene-pad': ['scenePad', false],
    '--min-seconds': ['minSeconds', false],
    '--max-seconds': ['maxSeconds', false],
    '--still': ['still', true],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      opts.passthrough = argv.slice(i + 1);
      break;
    }
    if (arg === '--props-only') {
      opts.propsOnly = true;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) die(`${arg} 缺少取值`);
    i += 1;
    if (arg === '--storyboard' || arg === '--manifest' || arg === '--out') {
      opts[arg.slice(2)] = value;
      continue;
    }
    const spec = numeric[arg];
    if (!spec) die(`未知参数 ${arg}\n\n${USAGE}`);
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) die(`${arg} 需要数字，收到 ${value}`);
    if (spec[1] && !Number.isInteger(parsed)) die(`${arg} 需要整数，收到 ${value}`);
    opts[spec[0]] = parsed;
  }
  if (!opts.storyboard) die(`--storyboard 必填\n\n${USAGE}`);
  // 参数层的错在这里就报掉，别落到下面「分镜与音频清单对不上」那个 catch 里去
  if (opts.fps <= 0) die(`--fps 需要正整数，收到 ${opts.fps}`);
  if (opts.scenePad < 0) die(`--scene-pad 需要 ≥ 0，收到 ${opts.scenePad}`);
  return opts;
}

function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    die(`${file} 读不了或不是合法 JSON：${error.message}`);
  }
}

const slugify = (value) => (value ?? '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'report';

/** 用 Remotion 自带的 FFmpeg（不依赖系统 PATH 上有 ffmpeg）。 */
function ffmpeg(args) {
  const result = spawnSync(remotionBin, ['ffmpeg', ...args], {encoding: 'utf8'});
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? '');
    die('FFmpeg 拼接音轨失败');
  }
  return result.stdout;
}

/**
 * 按分镜顺序拼接音轨。每段先 atrim 到帧量化后的长度、再 apad 补静音到同一长度，
 * 于是第 N 段的起点严格等于第 N 个 Sequence 的第一帧——不存在逐段四舍五入的累积漂移。
 * atrim 只是防御性上限：帧数是 ceil 出来的，量化时长永远 ≥ 音频实际时长，正常不会截到声音。
 */
function concatTrack(segments, audioDir, outFile) {
  const inputs = [];
  const filters = [];
  segments.forEach((segment, index) => {
    const file = path.resolve(audioDir, segment.audio);
    if (!existsSync(file)) die(`音频文件不存在：${file}（分镜 ${segment.id}），先重跑 npm run tts:batch`);
    inputs.push('-i', file);
    const dur = segment.quantizedSeconds.toFixed(6);
    filters.push(
      `[${index}:a]aformat=sample_fmts=s16:sample_rates=44100:channel_layouts=mono,` +
        `atrim=end=${dur},apad=whole_dur=${dur},asetpts=N/SR/TB[a${index}]`,
    );
  });
  const chain = segments.map((_, index) => `[a${index}]`).join('');
  filters.push(`${chain}concat=n=${segments.length}:v=0:a=1[out]`);
  ffmpeg([
    '-y',
    ...inputs,
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[out]',
    '-c:a',
    'pcm_s16le',
    outFile,
  ]);
}

function remotion(subcommand, args) {
  const result = spawnSync(remotionBin, [subcommand, ...args], {stdio: 'inherit'});
  if (result.status !== 0) process.exit(result.status ?? 1);
}

/**
 * 把研究站点那份自托管 Inter 拷进 public 目录，成片的拉丁字形与公司研究页逐字同源。
 *
 * 从 `apps/web/public/assets/fonts/` 拷而不是在本子项目里再存一份：那是唯一的上游件
 * （子集化脚本与 OFL 许可都在它旁边），多一份副本就多一处会和站点悄悄漂移的地方。
 * 拿不到就跳过——composition 里的字族链会回退到 PingFang SC，只是拉丁字形变了。
 */
function stageFont(publicDir) {
  const source = path.join(repoRoot, 'apps', 'web', 'public', 'assets', 'fonts', 'InterVariable.woff2');
  if (!existsSync(source)) {
    process.stderr.write(`提示：找不到 ${path.relative(repoRoot, source)}，拉丁字形回退到系统字体\n`);
    return;
  }
  const target = path.join(publicDir, 'fonts');
  mkdirSync(target, {recursive: true});
  copyFileSync(source, path.join(target, 'InterVariable.woff2'));
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const storyboard = readJson(opts.storyboard);
  const manifest = opts.manifest ? readJson(opts.manifest) : null;

  const slug = slugify(storyboard.companyId ?? storyboard.meta?.companyId ?? path.basename(opts.storyboard, '.json'));
  const stageDir = path.join(projectRoot, 'out', 'render', slug);
  const publicDir = path.join(stageDir, 'public');
  mkdirSync(publicDir, {recursive: true});
  stageFont(publicDir);

  let built;
  try {
    built = buildReportProps({
      storyboard,
      manifest,
      fps: opts.fps,
      scenePadSeconds: opts.scenePad,
      audioTrack: manifest ? 'track.wav' : null,
    });
  } catch (error) {
    if (error instanceof ReportPropsError) die(`分镜与音频清单对不上：${error.message}`);
    throw error;
  }
  const {props, segments} = built;

  if (segments.length > 0) {
    concatTrack(segments, path.dirname(path.resolve(opts.manifest)), path.join(publicDir, 'track.wav'));
  }

  const propsFile = path.join(stageDir, 'props.json');
  writeFileSync(propsFile, `${JSON.stringify(props, null, 2)}\n`, 'utf8');

  const {videoSeconds, audioSeconds, sceneCount} = props.totals;
  process.stdout.write(
    `${sceneCount} 个分镜 · 画面 ${videoSeconds}s（${(videoSeconds / 60).toFixed(2)} 分钟）` +
      `${manifest ? ` · 音频 ${audioSeconds}s · 留白 ${(videoSeconds - audioSeconds).toFixed(3)}s` : ' · 无音轨（估时预览）'}\n`,
  );
  const targetRange = Array.isArray(storyboard?.totals?.targetRange) ? storyboard.totals.targetRange : [120, 180];
  const minSeconds = opts.minSeconds ?? Number(targetRange[0]);
  const maxSeconds = opts.maxSeconds ?? Number(targetRange[1]);
  if (videoSeconds < minSeconds || videoSeconds > maxSeconds) {
    process.stderr.write(
      `提示：总时长 ${videoSeconds}s 落在目标区间 [${minSeconds}, ${maxSeconds}] 之外，` +
        '需要控时请回到 script_gen.py 调 --min-seconds / --max-seconds 重出文案。\n',
    );
  }
  if (opts.propsOnly) {
    process.stdout.write(`props → ${path.relative(projectRoot, propsFile)}\n`);
    return;
  }

  const shared = [
    'src/index.ts',
    'Report',
    `--props=${propsFile}`,
    `--public-dir=${publicDir}`,
    ...opts.passthrough,
  ];
  if (opts.still !== null) {
    const stillOut = opts.out ?? path.join(stageDir, `${slug}-frame-${opts.still}.png`);
    remotion('still', [...shared, stillOut, `--frame=${opts.still}`]);
    return;
  }
  remotion('render', [...shared, opts.out ?? path.join(stageDir, `${slug}.mp4`)]);
}

main();
