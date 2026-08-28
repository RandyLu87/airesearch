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
import {existsSync, mkdirSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(projectRoot, '..', '..');

const USAGE = `用法：node scripts/pipeline.mjs --company <公司目录或目录名> [选项]

  --company <path|id>   必填，research/companies/<id> 的目录名或任意路径
  --out <path>          输出 mp4，默认 out/render/<id>/<id>.mp4
  --voice <name>        TTS 音色，默认 zh-CN-XiaoxiaoNeural
  --rate <n>            TTS 语速，如 +10%
  --skip-tts            复用已存在的 out/tts/<id>/manifest.json（不联网重合成）
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
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) die(`${arg} 缺少取值`);
    i += 1;
    if (arg === '--company' || arg === '--out' || arg === '--voice' || arg === '--rate') {
      opts[arg.slice(2)] = value;
      continue;
    }
    die(`未知参数 ${arg}\n\n${USAGE}`);
  }
  if (!opts.company) die(`--company 必填\n\n${USAGE}`);
  return opts;
}

/** `us-bili-bilibili` 与 `research/companies/us-bili-bilibili` 都认，前者按仓库根解析。 */
function resolveCompany(value) {
  const candidates = value.includes(path.sep)
    ? [path.resolve(value)]
    : [path.resolve(repoRoot, 'research', 'companies', value), path.resolve(value)];
  const dir = candidates.find((candidate) => existsSync(path.join(candidate, 'financials-summary.json')));
  if (!dir) {
    die(`找不到 financials-summary.json，试过：\n  ${candidates.map((c) => path.join(c, 'financials-summary.json')).join('\n  ')}`);
  }
  return {id: path.basename(dir), summary: path.join(dir, 'financials-summary.json')};
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

function artifact(file) {
  return existsSync(file) ? {path: path.relative(repoRoot, file), bytes: statSync(file).size} : null;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const {id, summary} = resolveCompany(opts.company);

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

  runStep('文案生成', 'python3', ['scripts/script_gen.py', '--summary', summary, '--out', scriptFile], steps);

  if (opts.skipTts) {
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
