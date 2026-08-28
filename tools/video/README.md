# 视频渲染子项目（MVP 脚手架）

把 `research/companies/<company>/financials-summary.json` 渲染成带语音解说的视频，
技术栈固定为 **Remotion（合成）+ FFmpeg（编码）+ edge-tts（免费语音）**。

脚手架（OWLL-45）验证三者能跑通；分镜解说文案生成（OWLL-46）已落地，见下方
「分镜解说文案」一节。TTS 集成到分镜、Remotion 报告模板在后续 stage 落地。
目录独立于根 workspace（根 `package.json` 的 workspaces 只含 `apps/*`、`packages/*`），
不影响 `apps/web` 与 `research/` 的构建。

## 依赖

| 依赖 | 版本 | 安装 |
| --- | --- | --- |
| Node | ≥ 22 | 与仓库根一致 |
| Remotion / React | 4.0.518 / 19.2.8 | `npm install`（`package-lock.json` 已锁定） |
| FFmpeg | n7.1 | **无需系统安装**，`@remotion/renderer` 自带；可用 `npx remotion ffmpeg -version` 自检 |
| Chromium headless | Remotion 首次渲染时自动下载 | 需要联网，约 150MB |
| edge-tts | 7.2.8 | `scripts/tts.sh` 优先用 `uv` 拉起隔离环境；无 uv 时 `pip install -r scripts/requirements.txt` |

```bash
cd tools/video
npm install
```

## 跑通最小示例

两条命令互不依赖，可以单独验证。

**1) Remotion 渲染 → mp4**

```bash
npm run render          # 输出 out/hello.mp4（1920x1080 / 30fps / 5 秒）
npm run studio          # 可选：交互式预览
```

**2) 中文文本 → TTS 音频 + 时长**

```bash
npm run tts -- --text "哔哩哔哩交出首个 GAAP 盈利的完整财年。" --out out/tts/smoke
npm run tts -- --text-file path/to/script.txt --voice zh-CN-XiaoxiaoNeural --out out/tts/bili
```

输出 `<out>.mp3` 与 `<out>.json`：

```json
{
  "voice": "zh-CN-XiaoxiaoNeural",
  "duration_seconds": 8.0,
  "cues": [{ "kind": "SentenceBoundary", "text": "…", "start": 0.1, "end": 8.0 }]
}
```

`duration_seconds` 与 `cues` 供后续分镜对齐使用，直接取自 edge-tts 的边界事件，
不需要额外的 ffprobe 调用（需要复核时：`npx remotion ffprobe out/tts/smoke.mp3`）。

## 本机验证结果（2026-08-28, macOS arm64 / Node 22.22）

- `npm run render` → `out/hello.mp4` 336.5 kB，150 帧渲染 + 编码通过。
- `npm run tts` → `smoke.mp3` 8.0s；`npx remotion ffprobe` 读到 8.02s，两者一致。
- `npx remotion ffmpeg -version` → ffmpeg n7.1（Remotion 自带，系统 PATH 上无 ffmpeg）。

## 分镜解说文案（`scripts/script_gen.py`）

把任意一家公司的 `financials-summary.json` 转成分镜 JSON，供 TTS 朗读与 Remotion 模板消费。
**纯拼接，不调用 LLM**：解说词只转述 `conclusion` / `advice` / `condition` / `action` /
`disclaimer` 的原文，分数直接取 `confidence` 原值，模板只补「第几、维度名、信心度 X 分」
这类连接词——原文没有的判断和数字，成片里也不会有。

```bash
npm run script -- --summary ../../research/companies/us-bili-bilibili/financials-summary.json \
  --out out/script/us-bili-bilibili.json
```

省略 `--out` 时写 stdout；`--rate`（默认 4.5 字/秒）、`--min-seconds` / `--max-seconds`
（默认 120 / 180）、`--strategies`（默认 `noPosition,holding`）可调。

分镜顺序固定为：开场（公司名 + 一句话定位）→ 七维度（维度名 + 信心度 + 理由）→
1–2 类策略（建议正文 + 触发条件）→ 免责声明。

### 三条硬规矩

| 规矩 | 落地方式 |
| --- | --- |
| 不编、不重算 | 只转述原文字段，`confidence` 原样播；`scoreBasis` 与 `triggers[].basis` 刻意不进解说词——它们是给人核对的字段路径，念出来只是噪音 |
| 缺失如实说 | `unavailable` / `__TODO__` / 空值一律播「暂无数据」「暂无评分」，并连同缺失原因记进 `omissions` |
| 不静默截断 | 时长调节按固定阶梯走，每一步写进 `adjustments`（步骤、原因、增减秒数）；阶梯走完仍不达标就 `withinTarget: false` + `totals.warning`，退出码 1 |

### 时长怎么控

`estimatedSeconds` 按「中文 1 字 1 拍、数字逐位、拉丁字母半拍 + 标点停顿」估算，只用于
合成前判断要不要裁剪；**真实时长以 `scripts/tts.py` 输出的 `duration_seconds` 为准**。

超过上限时逐级裁剪，够了就停：维度理由只播第一句 → 只播前 K 个句读（取仍放得下的最大 K）
→ 开场定位只播第一个句读 → 策略不播触发条件 → 只留一类策略 → 从最长的维度开始只播分数。
不足下限时反向补：策略播全部触发条件 → 补播卖出/加仓信号，且补完不得重新超上限。

七维度是这份报告的主干，所以策略排在维度之前被裁——契约本身也只要求播 1–2 类策略。

### 验证样本

`samples/us-bili-bilibili.script.json` 是哔哩哔哩的产出（11 个分镜 / 预估 167.18 秒 /
无缺失字段），随脚本一起提交，既是人工核对的样本，也是 stage 3 Remotion 模板的输入夹具。
改动脚本后用上面的命令重新生成即可。

仓库内 16 家公司全部跑通且落在 2–3 分钟区间；自动化用例见 `tests/video-script-gen.test.mjs`
（`npm test` 在仓库根执行）。

## 已知限制

- **edge-tts 需要联网**调用微软 Edge 朗读接口，非离线方案；接口无官方 SLA，可能限流或变更。
- **中文音色只返回 `SentenceBoundary`**（英文音色才有 `WordBoundary`），所以时间轴颗粒度是
  句级不是词级。分镜按句切足够，若后续需要更细的对齐，得把文案拆成更短的句子分多次合成。
- **Remotion 依赖 headless Chromium**，首次渲染会下载浏览器；无外网的 CI 需要预置缓存或
  自带 Chrome（`--browser-executable`）。
- 渲染耗时与 CPU 强相关，本机 5 秒 1080p 约数秒；2–3 分钟成片的耗时需在 stage 4 实测。

## 备选方案（edge-tts 不可用时）

[Piper TTS](https://github.com/rhasspy/piper) —— 完全离线、MIT 许可，提供中文模型
（`zh_CN-huayan-medium`）。代价是不返回边界事件，时长需要改用
`npx remotion ffprobe` 读取，且句级对齐要自己按标点切分多段合成。切换时只需替换
`scripts/tts.py` 的合成实现，保持 `<out>.json` 的 `duration_seconds` / `cues` 契约不变。

## 目录

- `src/` — Remotion composition（`Hello` 为自检示例，报告模板在 stage 3 新增）
- `scripts/script_gen.py` — 分镜解说文案生成（纯标准库，无额外依赖）
- `scripts/tts.py` — TTS 合成 + 时间轴；`scripts/tts.sh` 为运行入口
- `samples/` — 随脚本提交的验证样本（哔哩哔哩分镜文案）
- `out/` — 渲染与合成产物，已 gitignore
