#!/usr/bin/env node
/**
 * 端到端：research/companies/<company>/financials-summary.json → 成片 mp4。
 *
 *   node scripts/pipeline.mjs --company us-bili-bilibili
 *
 * 只是把已有的三步串起来并逐段计时，不重新实现任何一步：
 *   1. scripts/script_gen.py  → out/script/<company>.json
 *   2. scripts/tts_batch.py   → out/tts/<company>/{NN-*.mp3, manifest.json}
 *   3. scripts/render.mjs     → out/render/<company>/<company>.mp4
 *
 * 每步的耗时、退出码与产物大小写进 out/pipeline/<company>/run.json，
 * 供 MVP 评估直接引用；任一步非零退出就地中断，不会拿半成品往下走。
 */

import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(projectRoot, '..', '..');

const USAGE = `用法：node scripts/pipeline.mjs --company <公司目录或目录名> [选项]

  --company <path|id>   必填，research/companies/<id> 的目录名或任意路径
  --out <path>          输出 mp4，默认 out/render/<id>/<id>.mp4
  --voice <name>        TTS 音色，默认 zh-CN-YunyangNeural（沉稳男声）
  --rate <n>            TTS 语速，如 +10%（默认 -8%）
  --skip-tts            复用已存在的 out/tts/<id>/manifest.json（不联网重合成）；
                        文案若与旧音频对不上会直接报错，不会拿旧音频配新画面
  --                    之后的参数原样透传给 remotion（如 --concurrency=10）
`;

function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = {company: null, out: null, voice: null, rate: null, skipTts: false, passthrough: []};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      opts.passthrough = argv.slice(i + 1);
      break;
    }
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    if (arg === '--skip-tts') {
      opts.skipTts = true;
      continue;
    }
    // 先认参数名再取值，否则末位的未知参数会报成「缺少取值」
    if (arg !== '--company' && arg !== '--out' && arg !== '--voice' && arg !== '--rate') {
      die(`未知参数 ${arg}\n\n${USAGE}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) die(`${arg} 缺少取值`);
    i += 1;
    opts[arg.slice(2)] = value;
  }
  if (!opts.company) die(`--company 必填\n\n${USAGE}`);
  return opts;
}

/**
 * `us-bili-bilibili` 与 `research/companies/us-bili-bilibili` 都认，前者按仓库根解析。
 *
 * 同目录下有 `financials-analysis.json` 就一起带上，走 4-5 分钟的详解版；没有就只用总结，
 * script_gen 会降级成 2-3 分钟并把这件事记进 omissions。缺分析文件不是错误——18 个公司
 * 目录里就有没跑完第 2 步的，整批渲染不该为此中断。
 */
function resolveCompany(value) {
  const candidates = value.includes(path.sep)
    ? [path.resolve(value)]
    : [path.resolve(repoRoot, 'research', 'companies', value), path.resolve(value)];
  const dir = candidates.find((candidate) => existsSync(path.join(candidate, 'financials-summary.json')));
  if (!dir) {
    die(`找不到 financials-summary.json，试过：\n  ${candidates.map((c) => path.join(c, 'financials-summary.json')).join('\n  ')}`);
  }
  const analysis = path.join(dir, 'financials-analysis.json');
  return {
    id: path.basename(dir),
    summary: path.join(dir, 'financials-summary.json'),
    analysis: existsSync(analysis) ? analysis : null,
  };
}

/** 子进程输出直接透到终端——每一步的告警（unknownTokens、控时提示）都要看得见。 */
function runStep(label, command, args, steps) {
  process.stdout.write(`\n▸ ${label}\n  ${command} ${args.join(' ')}\n`);
  const startedAt = process.hrtime.bigint();
  const result = spawnSync(command, args, {cwd: projectRoot, stdio: 'inherit'});
  const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
  steps.push({step: label, seconds: Number(seconds.toFixed(3)), exitCode: result.status ?? -1});
  process.stdout.write(`  ${label} 用时 ${seconds.toFixed(1)}s\n`);
  if (result.error) die(`${label} 启动失败：${result.error.message}`);
  if (result.status !== 0) {
    process.stderr.write(`${label} 失败（退出码 ${result.status}），链路中断\n`);
    process.exit(result.status ?? 1);
  }
}

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    die(`读不了${label} ${path.relative(repoRoot, file)}：${error.message}`);
  }
}

/**
 * --skip-tts 复用旧音频，但第一步刚把分镜重新生成过一遍：只要文案变了（改了
 * financials-summary.json、动过 script_gen.py），旧音频就配不上新画面，而分镜 id
 * 是固定的（opening / dimension-* / …），render 那边按 id 认领一个都不会缺，
 * 于是整条链路会静默产出「念旧稿、放新卡片」的成片。这里按 render 的同一套
 * 认领规则（同 id 先到先得）逐条比对文案，对不上就报错，不往下渲。
 */
function assertNarrationMatchesAudio(scriptFile, manifestFile) {
  const scenes = readJson(scriptFile, '分镜稿')?.scenes;
  const entries = readJson(manifestFile, '音频清单')?.scenes;
  if (!Array.isArray(scenes) || !Array.isArray(entries)) {
    die('--skip-tts：分镜稿或音频清单里没有 scenes 数组，无法确认音画一致，去掉 --skip-tts 重跑');
  }
  const spokenById = new Map();
  for (const entry of entries) {
    const id = entry?.id;
    if (!spokenById.has(id)) spokenById.set(id, []);
    spokenById.get(id).push(entry?.text);
  }
  const drifted = [];
  for (const [index, scene] of scenes.entries()) {
    const id = scene?.id ?? `scene-${String(index + 1).padStart(2, '0')}`;
    const spoken = spokenById.get(id)?.shift();
    if (spoken !== scene?.narration) drifted.push(id);
  }
  const orphaned = [...spokenById.values()].flat().length;
  if (drifted.length || orphaned) {
    die(
      `--skip-tts：分镜文案与已有音频对不上（${drifted.length ? `文案已变：${drifted.join('、')}` : ''}` +
        `${drifted.length && orphaned ? '；' : ''}${orphaned ? `多出 ${orphaned} 条无主音频` : ''}），` +
        '复用会念旧稿配新画面，去掉 --skip-tts 重跑',
    );
  }
}

function artifact(file) {
  return existsSync(file) ? {path: path.relative(repoRoot, file), bytes: statSync(file).size} : null;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const {id, summary, analysis} = resolveCompany(opts.company);
  if (!analysis) {
    process.stderr.write(
      `提示：${id} 没有 financials-analysis.json，本片按纯总结模式产出（2-3 分钟，无商业模式与护城河深讲）\n`,
    );
  }

  const scriptFile = path.join(projectRoot, 'out', 'script', `${id}.json`);
  const ttsDir = path.join(projectRoot, 'out', 'tts', id);
  const manifestFile = path.join(ttsDir, 'manifest.json');
  const videoFile = opts.out ? path.resolve(opts.out) : path.join(projectRoot, 'out', 'render', id, `${id}.mp4`);
  mkdirSync(path.dirname(scriptFile), {recursive: true});
  // --skip-tts 缺 manifest 就在跑第一步之前报掉，别让人等完文案生成才发现
  if (opts.skipTts && !existsSync(manifestFile)) {
    die(`--skip-tts 需要已有 ${path.relative(repoRoot, manifestFile)}，先跑一次不带该参数的链路`);
  }

  const steps = [];
  const startedAt = process.hrtime.bigint();

  runStep(
    '文案生成',
    'python3',
    [
      'scripts/script_gen.py',
      '--summary',
      summary,
      ...(analysis ? ['--analysis', analysis] : []),
      '--out',
      scriptFile,
    ],
    steps,
  );

  if (opts.skipTts) {
    assertNarrationMatchesAudio(scriptFile, manifestFile);
    if (opts.voice || opts.rate) {
      process.stderr.write('提示：--skip-tts 不重新合成，--voice / --rate 本次不生效\n');
    }
    process.stdout.write(`\n▸ TTS 合成（跳过，复用 ${path.relative(repoRoot, manifestFile)}）\n`);
    steps.push({step: 'TTS 合成', seconds: 0, exitCode: 0, skipped: true});
  } else {
    const ttsArgs = ['scripts/py.sh', 'tts_batch.py', '--storyboard', scriptFile, '--out-dir', ttsDir];
    if (opts.voice) ttsArgs.push('--voice', opts.voice);
    if (opts.rate) ttsArgs.push('--rate', opts.rate);
    runStep('TTS 合成', 'bash', ttsArgs, steps);
  }

  runStep(
    '视频渲染',
    'node',
    ['scripts/render.mjs', '--storyboard', scriptFile, '--manifest', manifestFile, '--out', videoFile, ...(opts.passthrough.length ? ['--', ...opts.passthrough] : [])],
    steps,
  );

  const totalSeconds = Number(Number(process.hrtime.bigint() - startedAt) / 1e9).toFixed(3);
  const runDir = path.join(projectRoot, 'out', 'pipeline', id);
  mkdirSync(runDir, {recursive: true});
  const run = {
    companyId: id,
    summary: path.relative(repoRoot, summary),
    analysis: analysis ? path.relative(repoRoot, analysis) : null,
    mode: analysis ? 'detailed' : 'summary-only',
    totalSeconds: Number(totalSeconds),
    steps,
    artifacts: {
      storyboard: artifact(scriptFile),
      manifest: artifact(manifestFile),
      video: artifact(videoFile),
    },
  };
  const runFile = path.join(runDir, 'run.json');
  writeFileSync(runFile, `${JSON.stringify(run, null, 2)}\n`, 'utf8');

  process.stdout.write(
    `\n端到端完成 ${totalSeconds}s：` +
      `${steps.map((s) => `${s.step} ${s.seconds}s`).join(' · ')}\n` +
      `成片 → ${path.relative(repoRoot, videoFile)}（${((run.artifacts.video?.bytes ?? 0) / 1e6).toFixed(1)} MB）\n` +
      `计时 → ${path.relative(repoRoot, runFile)}\n`,
  );
}

main();
