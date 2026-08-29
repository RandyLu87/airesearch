---
name: report-video
description: 把已完成的公司研究渲染成带语音解说的 4–5 分钟讲解视频（Remotion + edge-tts）。Use when 用户要为某家公司出视频、把研究报告做成视频/短片/解说，或要重渲、改画面、换音色、批量出片。
---

# 研究报告视频

渲染管线、分镜契约、控时规则、视觉口径与已知限制的**唯一正文是 `tools/video/README.md`**，动手前先读它。本文件只是薄壳，不重复正文内容，改管线一律改 `tools/video/` 与那份 README，不改这里。

## 前置：视频是研究的下游，不是替代品

视频只转述 `research/companies/<id>/` 里已经落盘的 JSON，**不调用 LLM、不新增判断、不重算数字**。所以出片前必须确认这家公司的研究已经跑完：

| 文件 | 作用 | 缺了会怎样 |
| --- | --- | --- |
| `financials-summary.json` | 解说词主干（七维度 + 策略） | **硬前置**，没有就出不了片，先跑 `public-company-financial-research` skill |
| `financials-analysis.json` | 详解版素材（商业模式与护城河五屏深讲） | 自动降级成 `summary-only`（2–3 分钟），stderr 提示一行并记进 `run.json` 的 `mode` |
| `financials-final.json` 或 `financials-collection.json` | 画面里的图表与主数字 | 降级成纯文字卡，同样不中断 |

研究数据变了就要重出片：**成片是派生产物，不手改**，和 `research/site/` 同一个道理。

## 画面只放重点，展开交给语音

这是这套片子的呈现原则，落在两层，**守法不一样**：

| 层 | 做什么 | 怎么保证不编 |
| --- | --- | --- |
| **制作过程的自述**（确定性，自动） | 一律不上屏：「原报告共 N 条，本片按控时只播报前 M 条」这类说明已删除；研究流程用语（「第 2 步」「已落盘」「原报告」）由 `strip_process_talk` 摘掉 | 只删不改，摘掉的数量记进 `omissions`。仍守住「不把裁剪讲成缺失」：被裁光时画面不作断言，只有原报告本来就没有才写「暂无」 |
| **画面**（确定性，自动） | 所有画面文本收成前导句：一句一屏的位置 58 字、并排要点 42 字，超出补省略号 | 只在标点处切，切出来一定是原文前缀，不改写一个字 |
| **解说**（LLM 改写，可选） | 把研究结论改写成口语稿，短句、少从句、`①②③` 改成「第一第二」 | `scripts/brief.py` 的确定性闸门：数字白名单 + 时长预算 + 引用检查 |

第一层永远生效，不用管。第二层要一份**讲稿加工件** `out/brief/<id>.json`：

```json
{"companyId": "...", "scenes": {"dimension-valuation": {"headline": "估值6分：中性价只高5.1%", "spoken": "第六个维度，估值…"}}}
```

它由 LLM 产出（这是判断，不是字符串处理），但**放行归校验器**。要写一份新的，把这几条原样交给改写的 Agent：

- **每个数字都必须能在研究 JSON 里原样找到**——把 `56.68亿` 说成 `57亿` 也算越界，四舍五入是改口径不是改文风
- **不许砍判断与口径**：「待验证」不能说成「不行」，「单季转正」「TTM 仍亏」这类限定词一个都不能丢
- **只许减法和换说法，不许加法**：不引入研究结论里没有的判断、类比、行业观点
- `headline` ≤ 24 字；整片解说不得超过目标片长（**口语化几乎一定比原文长，这一条最容易破**）

没有加工件时管线自动退回纯拼接，只在 stderr 提示一行——不是错误。

## 主链路：一条命令

```bash
cd tools/video && npm install          # 首次；Chromium 由 Remotion 首渲时自动下载
npm run pipeline -- --company <company-id> -- --concurrency=10
```

`--company` 认 `research/companies/` 下的目录名，也认任意路径。它只是把各步按顺序跑一遍并逐段计时，**不重新实现任何一步**；任一步非零退出就地中断，不会拿半成品往下走。

有讲稿加工件时它会多跑两步：**控时基准稿**（不带 `--brief` 的产出，给校验器算每条分镜的秒数预算）→ **讲稿校验**（不过就中断）。

```bash
npm run script    -- --summary ../../research/companies/<id>/financials-summary.json \
                     --analysis ../../research/companies/<id>/financials-analysis.json \
                     --collection ../../research/companies/<id>/financials-final.json \
                     --out out/script/<id>.json
npm run tts:batch -- --storyboard out/script/<id>.json --out-dir out/tts/<id>
npm run render:report -- --storyboard out/script/<id>.json \
                         --manifest out/tts/<id>/manifest.json
```

常用参数：`--voice` / `--rate` 换音色语速，`--out` 换成片路径，`--skip-tts` 复用已有音频（改模板时别反复联网重合成），`--` 之后原样透传给 remotion。

产物都在 `tools/video/out/`（已 gitignore）：

| 路径 | 内容 |
| --- | --- |
| `out/script/<id>.json` | 分镜解说文案，**出片后第一个该看的东西** |
| `out/tts/<id>/manifest.json` | 逐条音频与真实时长 |
| `out/render/<id>/props.json` | 画面数据 + 每条分镜首帧/帧数 |
| `out/render/<id>/<id>.mp4` | 成片，1920x1080 / 30fps |
| `out/brief/<id>.json` | 讲稿加工件（口语稿 + 画面重点），有才走 LLM 稿 |
| `out/script/<id>.base.json` | 控时基准稿，只用来算讲稿的秒数预算 |
| `out/pipeline/<id>/run.json` | 各阶段耗时、退出码、`mode`、`narration`（`brief` / `verbatim`）|

## 出片后必须人工核对的四件事

**这条管线最危险的失败不是报错，是安静地少画一张图、或者把图画反。** 退出码 0 不代表片子对，跑完必须逐条看下面四项——2026-08-29 用美团实测时，四项里有三项各抓出一个真缺陷（详见「实测记录」）。

1. **`script.json` 的 `omissions`** —— 被摘掉没进解说的内容（认不出量级的金额、URL 与字段路径、缺失数据）。**先看有没有整块内容消失**（`不画营收趋势图，该屏退回文字卡` 这类），再看 reason 说得对不对：诊断写错会把人送到错的地方去改数据。关键数字被摘掉说明研究 JSON 的写法要修，回去改数据源，不要在视频层打补丁。
2. **`manifest.json` 的 `unknownTokens`** —— 中文音色会按字母朗读的英文残留。财经缩写补进 `scripts/tts_lexicon.json`（不用改代码，加完重跑即可）；产品与机构专名（`YouTube` / `NVIDIA` 等）目前接受字母读法，属已知限制。
3. **`totals.withinTarget` 与 `adjustments`** —— 控时阶梯走完仍不达标会 `withinTarget: false` 并以退出码 1 结束。看 `adjustments` 里每一步裁了什么、为什么。
4. **抽帧看排版，一定要看图表那几帧** —— `npm run render:report -- --storyboard … --manifest … --still <frame> --out out/still.png` 出单帧 png（帧号查 `props.json` 里每条分镜的 `from`），比看完整片快得多。**图表帧是重灾区**，三件事挨个确认：
   - **趋势图的 X 轴是不是从旧到新**。画反了曲线方向就反了，看上去完全合理，只有对着数据才认得出来。
   - **首尾点标签有没有和 X 轴刻度叠在一起**。贴近底部的那条线（净利润转亏最常见）尤其容易糊。
   - **空态没有被画成 0**。`unavailable` / 缺分数只留灰色轨道，看到 0 分的条就是 bug——0 分和没有数据是两回事。

## 三条不能破的规矩

改任何一层之前先记住这三条，它们是这套管线和「AI 生成解说视频」的区别所在：

- **不编、不重算**。解说词只转述原文字段，`confidence` 与占比原样播；`scoreBasis`、`triggers[].basis`、`evidence[].source` 整块不进解说词——它们是给人核对的引用，念出来只是噪音。换算只做量级（`11928.29百万元CNY` → `119.28亿元`，走 `Decimal` 精确运算），**不碰汇率、不合并口径、不重算占比**；认不出单位的原样保留并记进 `omissions`——猜出来的单位比难看的单位危险得多。
- **缺失如实说**。`unavailable` / `__TODO__` / 空值一律播「暂无数据」「暂无评分」。被控时裁掉的和原报告就没有的是两回事，画面上分别说「原报告共 N 条，本片按控时未播报」和「暂无触发条件」——把裁剪讲成缺失同样是编事实。
- **画面时长跟着音频走，绝不反过来截音频**。帧数向上取整，画面时长永远 ≥ 音频时长。没带 `--manifest` 的无声预览只用来改排版，成片必须带。

## 容易踩的坑

- **`--analysis` 路径给错会直接退 2，不会静默降级成短片**；文件本来就不存在则由 `pipeline.mjs` 判断走 `summary-only`。这两种情况要分清。
- **`--skip-tts` 会逐条比对文案**，只要解说词变过（改了研究 JSON 或 `script_gen.py`）就报错中断，不会拿旧音频配新画面。此时 `--voice` / `--rate` 不生效。
- **`out/tts/<id>/` 不会在跑之前清空**，分镜 id 变了以后旧 mp3 会留在原地。一律按 `manifest.json` 的 `audio` 字段取文件，不要 glob 目录。
- **edge-tts 需要联网**，无官方 SLA，可能限流。离线备选是 Piper（见正文「备选方案」）。
- **中文音色只有句级边界事件**，所以字幕与逐条点亮是句级颗粒度，不是词级。

## 实测记录（2026-08-29，美团 hk-3690-meituan）

这个 skill 是拿美团这一支片子测出来的，四项核对里抓到三个真缺陷，都已修复并带上回归用例。留在这里是因为**它们是这条管线特有的失败形状**，换一家公司还会以别的面目出现：

| 症状 | 根因 | 为什么难发现 |
| --- | --- | --- |
| 整片没有一张趋势图 | `unit` 写作 `人民币百万元`，`read_amount` 只认 `百万元` | 退出码 0，只在 `omissions` 里留一行；全仓 16 家有 7 家中招 |
| 营收曲线一路下滑（实际逐年增长） | 采集文件按新→旧排，下游按升序假定 | 图画得很正常，KPI 还显示五年前那一年的毛利率 |
| 解说把 `Meituan`、`Core Local Commerce` 逐字母拼读 | 只摘了括注版中英对照，没摘不带括号的 | 只有听音频或看 `unknownTokens` 才发现 |

一条经验：**先修数据归一，再看排版**。图没画出来的时候，排版问题一个都暴露不了——上面第二、第三个缺陷都是修好第一个之后才浮出来的。

同一支片子上做「画面只放重点」时，又抓到两个：

| 症状 | 根因 |
| --- | --- |
| 护城河那屏五列文字撑出卡片、盖住字幕条 | 契约里 `verdict` 是三选一，研究侧写成了整段；且解说把五段判定串成一句 250 字的字幕，占六行从底部往上长 |
| 讲稿数字全对、却把片长从 292s 撑到 634s | 口语化必然比原文长，而控时阶梯是按原稿跑的；校验器当时又用 `字数 ÷ 语速` 估时，比 `script_gen` 的估时器低估 6 秒——**两个估时器打架比没有闸门更难查** |

第二条的教训是通用的：**新增闸门时，估时/计量一律复用既有实现，不要另写一套。**

成片实测：17 个分镜、4 分 36 秒、26 MB，端到端约 150–175s（14 核 macOS，`--concurrency=10`，其中渲染约 120–155s）。

## 验证

改动脚本或模板后：

```bash
cd tools/video && npm test && npm run typecheck   # 朗读改写与金额换算的回归用例（不联网）
npm test                                          # 仓库根：分镜生成与帧数换算的用例
```

不联网也能验排版：`npm run script` + `npm run render:report -- --props-only`，或 `npm run studio`（走 `demoProps.ts` 的含空态假数据）。
