# 视频渲染子项目（MVP 脚手架）

把 `research/companies/<company>/financials-summary.json` 渲染成带语音解说的视频，
技术栈固定为 **Remotion（合成）+ FFmpeg（编码）+ edge-tts（免费语音）**。

目录独立于根 workspace（根 `package.json` 的 workspaces 只含 `apps/*`、`packages/*`），
不影响 `apps/web` 与 `research/` 的构建。已落地：

- **OWLL-45** — Remotion / FFmpeg / edge-tts 最小可运行环境
- **OWLL-46** — `financials-summary.json` → 分镜解说文案 JSON（见「分镜解说文案」一节）
- **OWLL-47** — 分镜文案 JSON → 逐条音频 + 时长清单（见「批量合成」一节）
- **OWLL-48** — 分镜文案 + 音频清单 → 成片 mp4（见「成片渲染」一节）
- **OWLL-49** — 端到端串联与 MVP 可行性评估（见「端到端」一节与 `MVP-ASSESSMENT.md`）
- **#31** — 升级为 4–5 分钟详解版：接入第 2 步的 `financials-analysis.json`，
  商业模式与护城河展开成五屏核心段落，并加上随语音走的字幕与逐条点亮

整条链路一条命令（等价于下面三步手动跑）：

```bash
npm run pipeline -- --company us-bili-bilibili -- --concurrency=10
```

```bash
npm run script -- --summary ../../research/companies/<company>/financials-summary.json \
                  --analysis ../../research/companies/<company>/financials-analysis.json \
                  --out out/script/<company>.json
npm run tts:batch -- --storyboard out/script/<company>.json --out-dir out/tts/<company>
npm run render:report -- --storyboard out/script/<company>.json \
                         --manifest out/tts/<company>/manifest.json
```

## 依赖

| 依赖 | 版本 | 安装 |
| --- | --- | --- |
| Node | ≥ 22 | 与仓库根一致 |
| Remotion / React | 4.0.518 / 19.2.8 | `npm install`（`package-lock.json` 已锁定） |
| FFmpeg | n7.1 | **无需系统安装**，`@remotion/renderer` 自带；可用 `npx remotion ffmpeg -version` 自检 |
| Chromium headless | Remotion 首次渲染时自动下载 | 需要联网，约 150MB |
| edge-tts | 7.2.8 | `scripts/py.sh` 优先用 `uv` 拉起隔离环境；无 uv 时 `pip install -r scripts/requirements.txt` |

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
npm run tts -- --text-file path/to/script.txt --voice zh-CN-YunyangNeural --out out/tts/bili
```

输出 `<out>.mp3` 与 `<out>.json`：

```json
{
  "voice": "zh-CN-YunyangNeural",
  "duration_seconds": 8.0,
  "cues": [{ "kind": "SentenceBoundary", "text": "…", "start": 0.1, "end": 8.0 }]
}
```

`duration_seconds` 与 `cues` 取自 edge-tts 的边界事件，`container_duration_seconds` 是解析
mp3 帧头得到的文件实际长度，两者都不需要 ffprobe（需要复核时：`npx remotion ffprobe out/tts/smoke.mp3`）。

## 批量合成：分镜文案 → 音频清单

```bash
npm run tts:batch -- --storyboard samples/us-bili-bilibili.script.json \
                     --out-dir out/tts/us-bili-bilibili
```

一条命令跑完全部分镜，输出目录里得到 `NN-<分镜 id>.mp3`（按顺序编号、文件名与分镜 id
一一对应）和一份 `manifest.json`：

```json
{
  "companyId": "us-bili-bilibili",
  "engine": "edge-tts",
  "voice": "zh-CN-YunyangNeural",
  "sceneCount": 11,
  "totalDurationSeconds": 200.85,
  "totalContainerDurationSeconds": 201.528,
  "unknownTokens": [],
  "scenes": [
    { "index": 1, "id": "opening", "audio": "01-opening.mp3", "durationSeconds": 12.012,
      "containerDurationSeconds": 12.072,
      "text": "…原文…", "normalizedText": "…朗读改写后…", "cues": [] }
  ]
}
```

两个时长字段不一样，stage 3 要挑对：`durationSeconds` 来自引擎边界事件，停在最后一句收尾处、
不含尾部静音；`containerDurationSeconds` 是 mp3 文件本身的长度（解析帧头得到，与 `afinfo` /
ffprobe 逐条一致）。**真去拼接音频时按 `containerDurationSeconds` 对齐**，否则每条少算的
0.05~0.07s 会累积成漂移（本样例 11 条共 0.68s）；只是给单条画面配时长，用哪个都可以。
帧头解析不出来时 `containerDurationSeconds` 会是 `null`（顶层 `totalContainerDurationSeconds`
同理），stage 3 取值时按 `containerDurationSeconds ?? durationSeconds` 兜底。

输出目录不会在跑之前清空——OWLL-46 换掉 fixture、分镜 id 变了以后，旧的 `NN-<old-id>.mp3`
会留在原地。stage 3 一律按 `manifest.json` 里的 `audio` 字段取文件，不要 glob 目录。

常用参数：`--voice` / `--rate` 调音色语速，`--engine` 换引擎，`--retries`（默认 3）调重试次数，
`--no-normalize` 关掉朗读改写。

### 输入契约

分镜文案 JSON 由 OWLL-46 的生成器产出，最小形态是：

```json
{ "companyId": "us-bili-bilibili", "scenes": [{ "id": "opening", "text": "…" }] }
```

字段名做了兼容：分镜数组键接受 `scenes` / `shots` / `storyboard` / `segments`，顶层也可以直接是
数组；文案键接受 `text` / `narration` / `script` / `content` / `voiceover`；id 键接受 `id` /
`sceneId` / `scene_id` / `shotId`，缺 id 时兜底为 `scene-01`。**认不出的结构会带非零退出码明确
报错**（读取失败——路径不存在、JSON 非法、结构认不出——exit 2，合成失败 exit 1），不会静默跳过分镜。

id 字段给了但不是非空字符串（例如 `"id": 3`）也走 `scene-NN` 兜底，只在 stderr 提示一次；
manifest 与文件名仍然自洽，但生成器最好直接给字符串 id。

`samples/us-bili-bilibili.script.json` 由 `npm run script`（OWLL-46）生成，是链路验证的
标准输入；它的 `narration` / 顶层 `companyId` / `companyName` 正好落在上面列的兼容键里。

### 朗读改写（normalize）

报告原文混着英文缩写、货币前缀和百分号，直接喂中文音色会读错。`scripts/text_normalize.py`
在合成前做确定性改写，只做同义展开、不引入原文没有的判断或数字：

| 原文 | 朗读文本 |
| --- | --- |
| `PE 35.11x` | 市盈率35.11倍 |
| `FY2025` / `2026Q2` / `26H1` | 2025财年 / 2026年第二季度 / 2026年上半年 |
| `US$3亿` / `US$8.5B` / `34,639M` | 3亿美元 / 85亿美元 / 346.39亿 |
| `2026-06-30` / `2026/03/18` | 2026年6月30日 / 2026年3月18日 |
| `2026-08-19/20` | 2026年8月19日到20日 |
| `+119.0%` / `-63.4%` | 正百分之119.0 / 负百分之63.4 |
| `22-28%` | 百分之22到28 |

词表在 `scripts/tts_lexicon.json`，加缩写不用改代码。改写后仍残留的英文串（含单个字母，
`2026年Q2` 里漏掉的 `Q` 就是这么抓出来的）会记进 manifest 的 `unknownTokens` 并打到 stderr，
提示补词表 —— 不会因为漏配就悄悄读错。中文音色本来就读得对的（`A股` / `B站` / `H股`，以及
词表展开自己产出的 `I P`）在词表 `allowedLatin` 里放行，不算残留；带中文后缀的放行条目只在
那个上下文里生效，`B轮融资` 的 `B` 照样报出来。

量级后缀只认 `B` / `M`：研究数据里没有一处 `K` 是量级写法，`4K视频` / `2K分辨率` 才是常态，
认了反而会把它们读成 `4000视频`。真出现 `3.2K` 会进 `unknownTokens` 提示补词表。

规则的回归测试（不联网）：`npm test`。

### 换 TTS 引擎

`scripts/tts_engine.py` 里 `ENGINES` 是引擎注册表，MVP 只登记免费的 `edge-tts`。接付费方案
（ElevenLabs 等）时新增一个实现类并登记，调用方只改 `--engine` 参数，`tts.py` /
`tts_batch.py` 不用动。

## 本机验证结果（2026-08-28, macOS arm64 / Node 22.22）

- `npm run render` → `out/hello.mp4` 336.5 kB，150 帧渲染 + 编码通过。
- `npm run tts` → `smoke.mp3` 8.0s；`npx remotion ffprobe` 读到 8.02s，两者一致。
- `npx remotion ffmpeg -version` → ffmpeg n7.1（Remotion 自带，系统 PATH 上无 ffmpeg）。
- `npm run tts:batch`（哔哩哔哩样例）→ 11 个 mp3 + manifest，朗读总时长 200.85s、文件总长
  201.528s；`containerDurationSeconds` 与 `afinfo` 逐条完全一致（11/11 差 0.000s）。
- `npm test` → 朗读改写规则 8 组用例通过。
- `npm run render:report`（哔哩哔哩样例，`-- --concurrency=10`）→ 5375 帧 / 12.4 MB /
  `00:02:59.22`，1920x1080 30fps H.264 + AAC，14 核 macOS 约 3 分钟渲完。
- 音画同步实测：对成片跑 `silencedetect`，10 个画面切点**全部**落在静音间隙内
  （画面 179.167s / 音轨 179.17s），没有一句话被切点截断。
- 换公司验证：贵州茅台走完 `script → tts:batch → render:report`，未改一行代码。
- `npm run pipeline`（哔哩哔哩，OWLL-49）→ 端到端 75.3s（文案 0.13s / TTS 7.4s / 渲染 67.9s），
  成片 `00:02:59.22` / 12.4 MB；同输入两次跑 `props.json` sha256 一致，edge-tts 两次合成 11 条
  音频时长逐条 0.000s 差。
- 全仓 16 家有 `financials-summary.json` 的公司走 `script → render --props-only` 全部通过，
  估时 148.6~177.5s 全落在 2–3 分钟区间。

## 分镜解说文案（`scripts/script_gen.py`）

把任意一家公司的 `financials-summary.json`（可选加上第 2 步的 `financials-analysis.json`）
转成分镜 JSON，供 TTS 朗读与 Remotion 模板消费。
**纯拼接，不调用 LLM**：解说词只转述原文字段，分数直接取 `confidence` 原值，模板只补
「第几、维度名、信心度 X 分」这类连接词——原文没有的判断和数字，成片里也不会有。

```bash
# 详解版（4–5 分钟）：带上维度分析，商业模式与护城河展开成核心段落
npm run script -- --summary ../../research/companies/us-bili-bilibili/financials-summary.json \
  --analysis ../../research/companies/us-bili-bilibili/financials-analysis.json \
  --out out/script/us-bili-bilibili.json
```

省略 `--out` 时写 stdout；`--rate`（朗读估时用的字/秒，默认 4.25）、`--strategies`（默认
`noPosition,holding`）、`--min-seconds` / `--max-seconds` 可调。

### 两种模式

给不给 `--analysis` 决定素材量，目标区间跟着素材走——只有总结时全部念完也就 3 分钟，
硬拗 4–5 分钟只能靠注水：

| 模式 | 输入 | 目标区间 | 分镜 |
| --- | --- | --- | --- |
| `detailed` | 总结 + 维度分析 | 240–300s | 在下面的基础上，另加五屏深讲 |
| `summary-only` | 只有总结 | 120–180s | 开场 → 七维度 → 1–2 类策略 → 免责声明 |

`--analysis` 路径给错会直接退 2，不会静默降级成短片；文件本来就不存在（该公司没跑完第 2 步）
则由 `pipeline.mjs` 自行判断，按 `summary-only` 出片并在 `omissions` 里记一条。
产出的 `meta.mode` 写明走的是哪条路。

详解版的分镜顺序：开场 → 生意质量 → **收入结构** → **生意的经济特征** → 护城河 →
**护城河逐条检验** → **护城河的过去与未来** → **十年之问** → 其余五维（快讲）→
1–2 类策略 → 免责声明。深讲分镜紧跟它解释的那个维度（按契约的 `mapsTo` 认），
观众先听结论再听展开。

### 逐条点亮用的 `beats`

深讲分镜的 `data.beats` 每条带 `sentenceIndex`，指向 `narration` 里念它的那一句。
渲染层按同一个下标去认 TTS 的句级边界事件，换算出这一条该在第几帧亮起来
（见 `scripts/report_props.mjs`）。下标由 `NarrationBuilder` 在拼解说词时算出来，
不写字面量——一段正文自己可能就含好几个句号，手工数迟早会数错。

### 三条硬规矩

| 规矩 | 落地方式 |
| --- | --- |
| 不编、不重算 | 只转述原文字段，`confidence` 与占比原样播；`scoreBasis`、`triggers[].basis`、`evidence[].source` 整块不进解说词——它们是给人核对的引用，念出来只是噪音 |
| 换算只做量级 | 金额经 `scripts/amount_format.py` 统一成中文量级（`11928.29百万元CNY` → `119.28亿元`），走 `Decimal` 精确运算并带回归用例（`test_amount_format.py`）；原文一并存进 `revenueRaw`，随时能回去核对。**不碰汇率、不合并口径、不重算占比**，认不出量级或币种的（AMD 与富途的原文就是没有单位的纯数字）一律原样保留并记进 `omissions`——猜出来的单位比难看的单位危险得多 |
| 引用不进解说 | 进解说的正文还要过一道 `strip_speech_noise`：内嵌的 URL、`a.b.c` 字段路径、`latestQuarterUpdate` 这类字段名交叉引用都摘掉并记进 `omissions`。左边界一律用 ASCII 字符类，**不能写 `(?<![\w.])`**——Python3 的 `\w` 连中文一起匹配，紧跟在中文后面的引用会一个都拦不住，而那恰恰是研究正文里最常见的写法 |
| 缺失如实说 | `unavailable` / `__TODO__` / 空值一律播「暂无数据」「暂无评分」，并连同缺失原因记进 `omissions` |
| 不静默截断 | 时长调节按固定阶梯走，每一步写进 `adjustments`（步骤、原因、增减秒数）；阶梯走完仍不达标就 `withinTarget: false` + `totals.warning`，退出码 1 |

### 时长怎么控

`estimatedSeconds` 按「中文 1 字 1 拍、数字逐位、拉丁字母半拍 + 标点停顿」估算，只用于
合成前判断要不要裁剪；**真实时长以 `scripts/tts.py` 输出的 `duration_seconds` 为准**。
估的是**朗读改写之后**的那串字，不是原文——`11928.29百万元CNY` 原文 17 个字符，念出来是
二十来个音节，按原文估会把含大量金额的深讲分镜系统性低估（实测整片短估约 9%）。
控时上限还会先扣掉 `分镜数 × RENDER_PAD_PER_SCENE`：成片比解说词长，每条分镜有句末留白。

**按层预算裁剪，核心层最后动。** 分镜分四层：`core`（商业模式与护城河，含它们的维度分镜）、
`fast`（其余五维）、`strategy`、`frame`（开场与免责声明）。开场收尾据实占用，剩下的按
0.66 / 0.19 / 0.15 分给核心 / 快讲 / 策略；快讲与策略压到各自预算就停手，**核心层的预算在
它们压完之后重算**，把没用掉的秒数全部让给主线。

每一层内部都是「**每次只把当前最长的那一屏降一级**，降完重新排序再看下一屏，一放得下就
收手」，而不是所有分镜一起降到同一级——后者会整步跨过预算线：实测哔哩哔哩的核心层会从
429s 一步掉到 246s，再由扩展阶梯拿策略把时长填回来，于是核心层被压成骨架、策略反倒成了
最长的段落，正好和这支片子的主线相反。

还有富余时先补回核心层（深讲分镜逐级恢复），补到上限为止；仍不足才轮到策略播全部触发条件、
补播卖出/加仓信号。**不会为了几秒钟的超额去砍掉整类策略**：那是一整块内容消失，
和逐级收紧不是一回事，所以只留在兜底阶梯里，且要先确认砍完不会掉到下限以下。

裁的是**解说时间，不是画面内容**：没念到的业务线、依据、回答要点仍然进 `data`，
在画面上压暗显示，并注明「原报告共 N 条，本片按控时只播报前 M 条」。屏幕不花时间，耳朵才花。

### 验证样本

`samples/us-bili-bilibili.script.json` 是哔哩哔哩的 `summary-only` 产出（11 个分镜），
随脚本一起提交，既是人工核对的样本，也是 Remotion 模板的输入夹具。
改动脚本后用上面的命令重新生成即可。

18 个公司目录里有 16 家跑完了第 2、3 步（另两家还没有 `financials-summary.json`）；
这 16 家在详解版下全部跑通，预计成片 287–299 秒，核心层占 47–62%；
解说词里没有任何 URL 与字段路径残留。自动化用例见 `tests/video-script-gen.test.mjs`
（`npm test` 在仓库根执行）。

## 成片渲染（`scripts/render.mjs` + `Report` composition）

```bash
npm run render:report -- --storyboard samples/us-bili-bilibili.script.json \
                         --manifest out/tts/us-bili-bilibili/manifest.json
```

输入只有这两份 JSON，**模板里没有任何一家公司的字面量**——换 `--storyboard` / `--manifest`
就是另一家公司的片子，不用改代码。产物都留在 `out/render/<companyId>/` 下：

| 文件 | 说明 |
| --- | --- |
| `props.json` | 画面数据 + 每条分镜的首帧/帧数，可以单独核对 |
| `public/track.wav` | 按分镜顺序拼好的完整音轨（`--public-dir` 指向这里） |
| `<companyId>.mp4` | 成片，1920x1080 / 30fps / H.264 |

常用参数：`--out` 换输出路径，`--fps`（默认 30），`--scene-pad`（每条分镜句末留白，默认
0.2s），`--min-seconds` / `--max-seconds`（仅告警，默认 120/180），`--props-only` 只出
props 与音轨不渲染，`--still <frame>` 只出某一帧 png 排版自检，`--` 之后的参数原样透传给
remotion（如 `-- --concurrency=10`）。

### 画面怎么跟音频对齐

一句话：**画面时长跟着音频走，绝不反过来截音频。**换算在 `scripts/report_props.mjs`
（纯函数，回归测试见仓库根 `tests/video-report-props.test.mjs`），三条口径：

1. 单条音频取 `containerDurationSeconds ?? durationSeconds`——前者是 mp3 文件实际长度。
2. 帧数 `= ceil(音频秒数 × fps) + 留白帧`，**向上取整**，所以画面时长永远 ≥ 音频时长；
   最后一条音频比预期长几百毫秒也只是让那一屏多停几帧，不会被切掉。
3. 拼接音轨时每段先 `atrim` 再 `apad` 补静音到「帧量化后的时长」，于是第 N 段音频的起点
   严格等于第 N 个 `Sequence` 的第一帧——单条 `<Audio>` 挂在第 0 帧就天然对齐，
   不存在逐段四舍五入的累积漂移（本样例 11 条画面 179.167s / 音轨 179.17s）。

省掉 `--manifest` 会走无声预览：时长退回 `script_gen.py` 的 `estimatedSeconds`，用来在不联网
的情况下改排版。**估时和真实朗读时长会差几秒**（哔哩哔哩样例估 167.18s、实际朗读 176.736s），
所以成片必须带 `--manifest`。

总时长落在 `[--min-seconds, --max-seconds]` 之外时只在 stderr 告警、不阻塞渲染——控时是
`script_gen.py` 的职责（那边有裁剪阶梯），这里报出来是为了别悄悄出一条 4 分钟的片子。

### 画面构成

| 分镜 kind | 画面 |
| --- | --- |
| `opening` | 标题卡：公司名 + `companyId` + 数据截止日期 + 一句话定位 |
| `dimension` | 左侧七维度信心度条形图（点亮当前维度），右侧当前维度的分数与结论原文 |
| `strategy` | 策略要点卡：适用人群 + 建议正文 + 触发条件/应对逐条 |
| `business-model` | `data.focus` 分两屏：`revenue` 各业务线金额/占比 + 占比条形图；`economics` 粘性判定 + 粘性机制与经营杠杆要点 |
| `moat-checklist` | 五类壁垒逐行：类型 + 检验问题 + 判定标签 |
| `moat-trend` | 过去五年 / 未来五年并排：方向 + 判断依据逐条 |
| `inquiry` | 十年之问：问题 + 回答要点逐条 |
| `closing` | 免责声明结尾卡 |

每屏都有顶部公司名/数据截止、底部字幕条与整片进度条。文字一律取分镜文案里的原文字段，
模板不改写也不重算任何数字。

### 视觉口径：与研究站点同源

浅色暖调，中性色直接取 `apps/web/public/assets/research.css` 的设计令牌
（`--paper` / `--ink` / `--muted` / `--line` / `--soft`），让成片和公司研究页看起来是
同一个产品而不是两套皮肤。强调色用暖珊瑚 `#d97757`，比站点的 `--signal #ff4d00` 收敛，
盯着 5 分钟的片子不刺眼；想和站点完全一致就把 `theme.accent` 换成 `#ff4d00`，只有这一处。

字体也复用站点那份：**拉丁与数字走自托管的 Inter（子集化 woff2，SIL OFL），中文走
PingFang SC**——和公司研究页逐字同源。字体文件不在本子项目里另存一份，由 `render.mjs`
的 `stageFont()` 从 `apps/web/public/assets/fonts/` 拷进 `--public-dir`：那边是唯一上游件
（子集化脚本与许可都在它旁边），多一份副本就多一处会和站点悄悄漂移的地方。

加载走 `FontFace` + `delayRender`，**不能只靠 `@font-face` 就开渲**：Remotion 是逐帧截图，
字体没加载完开头几帧会用回退字形，成片里表现为「前两秒字突然变了一下」，只能靠人眼发现。
取不到字体时同样放行，字形回退是瑕疵、整条链路卡死不是（`npm run studio` 不经过
`render.mjs`，预览就是这条回退路径）。

浅色下有两处不能照搬深色的做法，都在 `theme.ts` 与组件注释里写明了：压暗的起点要更高
（纸面上 0.3 的墨色已经读不出字），非当前维度的条形要更深（否则七条里只剩点亮的那条可辨）。占比条形图的长度由 `sharePct` 解析而来，**标签始终显示原文那串字**，
解析不出来就只留灰轨不画条——和分数缺失时的处理同一个口径。

**字幕与逐条点亮**：`captions` 一句一条，文本取 `narration` 原文、时间取 TTS 的句级边界事件；
字幕不用 manifest 里的 `normalizedText`——那是喂给引擎的口播改写稿（`35.11x PE` →
`35.11倍市盈率`），念出来对、写在屏幕上却和报告对不上。要点按 `beats[i].from` 逐条亮起；
**原报告里有、但本片按控时没念到的要点恒定压暗摆着**，用亮度区分「正在讲」和「可查的参考」。
句数与边界事件对不上时（换引擎、换英文音色）按字数比例兜底，不报错——字幕差半拍是瑕疵，
整条链路断掉不是。

**空态**：`score` 为 `null`（原文 `unavailable` / `__TODO__` / 缺失）时，条形图只留灰色轨道，
**不画 0 分的条**——0 分和没有数据是两回事，画出来就是编数字；分数位置改用琥珀色显示生成器
写好的说法（「暂无评分」），生成器没写才兜底成「暂无数据」。结论缺失、无建议正文同理各有一句
明确文案。触发条件那一条还要再分两种：原报告本来就没有（`itemsAvailable: 0`）说「暂无触发条件」，
原报告有、但被 `script_gen.py` 控时裁光了（`itemsAvailable > 0` 而 `items` 为空）说「原报告共 N 条
触发条件，本片按控时未播报」——把裁剪讲成缺失同样是编事实。不带 `--props` 打开 `npm run studio` 用的就是一份含空态的假数据
（`src/report/demoProps.ts`），改样式时不用先跑 TTS 就能看到空态。

分镜与音频清单对不上（少一条、多一条、清单条目缺 `audio`、音频文件不存在）、以及分镜 `kind`
认不出来，一律带非零退出码报错，不会静默配错音或渲成别的卡片。

## 端到端（`scripts/pipeline.mjs`）

```bash
npm run pipeline -- --company us-bili-bilibili -- --concurrency=10
```

只是把上面三步按顺序跑一遍并逐段计时，**不重新实现任何一步**——每步的命令、耗时、退出码原样透
到终端，任一步非零退出就地中断，不会拿半成品往下走。`--company` 认目录名（按仓库根解析到
`research/companies/<id>`）也认任意路径。

同目录下有 `financials-analysis.json` 就自动带上、走详解版；没有就只用总结出片，
并在 stderr 提示一行。缺分析文件不是错误——18 个公司目录里就有没跑完第 2 步的，
整批渲染不该为此中断。`run.json` 里的 `mode` 记录本次走的是哪条路。

产物与手动跑完全一致（`out/script/` / `out/tts/<id>/` / `out/render/<id>/`），额外多一份
`out/pipeline/<id>/run.json` 记录本次各阶段耗时与产物大小，评估报告直接引它：

```json
{ "companyId": "us-bili-bilibili", "totalSeconds": 75.344,
  "steps": [{"step": "文案生成", "seconds": 0.128, "exitCode": 0}, ...] }
```

常用参数：`--voice` / `--rate` 透传给 TTS，`--out` 换成片路径，`--skip-tts` 复用已有
manifest（改模板时不用反复联网重合成），`--` 之后原样透传给 remotion。

`--skip-tts` 会先拿重新生成的分镜逐条比对 manifest 里的文案：只要文案变过（改了
`financials-summary.json`、动过 `script_gen.py`），就直接报错中断，不会拿旧音频配新画面
——分镜 id 是固定的，光靠渲染那步的 id 认领拦不住这种漂移。此时 `--voice` / `--rate`
不生效（不重新合成），会在 stderr 提示一行。

MVP 阶段的实测耗时、成本、质量评价与规模化前置问题见 **`MVP-ASSESSMENT.md`**。

## 已知限制

- **edge-tts 需要联网**调用微软 Edge 朗读接口，非离线方案；接口无官方 SLA，可能限流或变更。
- **中文音色只返回 `SentenceBoundary`**（英文音色才有 `WordBoundary`），所以时间轴颗粒度是
  句级不是词级。分镜按句切足够，若后续需要更细的对齐，得把文案拆成更短的句子分多次合成。
- **Remotion 依赖 headless Chromium**，首次渲染会下载浏览器；无外网的 CI 需要预置缓存或
  自带 Chrome（`--browser-executable`）。
- 渲染耗时与 CPU 强相关：14 核 M4 Pro 上 5 分钟 1080p 成片约 100–110 秒（`--concurrency=10`），
  冷启动多约 30 秒的 bundle 时间。
- **朗读里的英文残留只解决了一半**：字段路径与 URL 已经被 `strip_speech_noise` 挡住（16 家
  全部干净），常见财经缩写已进词表，公司英文名括注在解说里也摘掉了；但产品与机构专名
  （`YouTube` / `NVIDIA` / `EPYC` / `Kling` 等，16 家合计 76 个 token）仍会被中文音色按
  字母朗读。这类是真专有名词，要么逐个进词表给中文读法，要么接受字母读法——目前是后者，
  并在 manifest 的 `unknownTokens` 里逐条报出来。
- **控时是逐级的，偶尔会留下富余**：深讲分镜一级就是十几二十秒，补到差一点放不下时只能停手，
  所以成片长度落在 287–299 秒之间而不是齐刷刷贴着 300 秒。
- **画面动效只有字幕与逐条点亮**，仍然没有配乐、转场与封面图。

## 备选方案（edge-tts 不可用时）

[Piper TTS](https://github.com/rhasspy/piper) —— 完全离线、MIT 许可，提供中文模型
（`zh_CN-huayan-medium`）。代价是不返回边界事件，时长需要改用
`npx remotion ffprobe` 读取，且句级对齐要自己按标点切分多段合成。切换时只需替换
`scripts/tts_engine.py` 里新增一个引擎实现并登记到 `ENGINES`，保持 `SynthesisResult` 契约
（`audio` / `duration_seconds` / `cues`）不变，批量脚本与 manifest 格式都不用改。

## 目录

- `src/Hello.tsx` — 渲染链路自检示例 composition
- `src/report/` — 报告模板 composition（`Report.tsx` 主体、`Scenes.tsx` 四类分镜画面、
  `DimensionChart.tsx` 七维度条形图、`demoProps.ts` studio 默认假数据）
- `scripts/pipeline.mjs` — 端到端入口（串起下面三步并逐段计时）
- `scripts/render.mjs` — 成片入口（拼音轨 + 生成 props + 调 remotion）
- `scripts/report_props.mjs` — 音频时长 → 帧数换算（纯函数，测试在仓库根 `tests/`）
- `scripts/script_gen.py` — 分镜解说文案生成（纯标准库，无额外依赖，不走 `py.sh`）
- `scripts/tts_engine.py` — 引擎抽象与 edge-tts 实现（含重试）
- `scripts/text_normalize.py` + `scripts/tts_lexicon.json` — 朗读改写规则与词表
- `scripts/tts.py` — 单段自检；`scripts/tts_batch.py` — 分镜批量合成
- `scripts/py.sh` — Python 入口（优先 uv 隔离环境）
- `samples/` — 随脚本提交的验证样本（哔哩哔哩分镜文案）
- `out/` — 渲染与合成产物，已 gitignore
