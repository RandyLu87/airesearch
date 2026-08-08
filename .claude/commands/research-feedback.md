---
description: 研究流程第 7 步：评估与反馈。在对话里打分，脚本与发布由我代跑。
argument-hint: "[company-id] [--transcript <会话日志>...]"
allowed-tools: Bash, Read, Write, Glob
---

执行研究流程第 7 步（唯一正文：`docs/research/workflow/07-evaluation-and-feedback.md`）。用户在对话里回答，**不让用户碰终端**：写评分文件、跑脚本、重跑发布都由你完成。

参数：`$ARGUMENTS`

## 1. 确定公司

参数里给了 company-id 就用它。没给就列出 `research/companies/*/financials-final.json`，按 `meta.dataCutoff` 取最新的一家，并在提问时说明你选了哪家、让用户可以纠正。

确认该目录存在，否则直接报错停下。

## 2. 一次性问完，不要挤牙膏

**用一条消息问全部问题**，让用户一次答完。不要一问一答来回八轮——那正是这个命令要消灭的麻烦。

先给一句提醒：这一步评的是**研究方法本身**，不是公司的好坏；报告写得好不好，与这家公司值不值得买无关。

然后列出：

**五项评分，各 1–5 分**（可以简写成 `4 3 4 2 3` 这样一串）
1. 可信 —— 读完敢不敢照它做决定？有没有哪个数字让你起疑
2. 洞察 —— 有没有告诉你一件自己不知道、或没想到的事
3. 好读 —— 5 分钟能不能抓住要点
4. 可执行 —— 触发条件真的能照着盯盘吗，还是听着像正确的废话
5. 密度 —— 套话、重复、凑字数占多少

**三个必填项**
6. 比上一份同类报告：更好 / 差不多 / 更差
7. **这份报告最差的一处是什么**（一句话即可，但必须具体到能照着改）
8. 这次研究有没有改变你的仓位或关注列表：有 / 没有

**两个可选项**（用户不答就留空）
9. 这家公司属于你熟悉的行业吗
10. 这次研究里，你有几次是在纠正它跑偏（不含追加新需求）

告诉用户第 7 项最重要：五个分数会随习惯往上漂直到失去区分度，「最差的一处」不会，而且它会直接进缺陷日志，成为下次改研究方法的依据。

## 3. 落盘并执行

把答案写成 `tmp/<company-id>-rating.json`：

```json
{
  "trust": 4, "insight": 3, "readability": 4, "actionable": 2, "density": 3,
  "vsLast": "better|same|worse",
  "worstPart": "用户原话，不要替他润色",
  "defectStep": "collection|analysis|summary|render|process|unspecified",
  "changedMyPosition": false,
  "familiarIndustry": true,
  "correctionMessages": 4,
  "model": "本次研究所用模型"
}
```

`defectStep` 由你从「最差的一处」判断归属哪一步，判断不了就填 `unspecified`。`correctionMessages` 用户没答就省略该字段（不要填 0——那是「一次都没纠正」的意思）。

然后执行：

```bash
python3 docs/research/tools/research_feedback.py --company <id> --rating-json tmp/<id>-rating.json
```

**一次研究跨了多个会话文件时**（上下文压缩、中途换会话），自动识别只会认出其中一个，成本会少算。这时给每个会话加一个 `--transcript <路径>`，会话日志在 `~/.claude-work/projects/-Users-user-Documents-airesearch/`。补录历史研究同理——那时没有运行事件，只能靠显式指定。

脚本会自己重跑 `npm run publish`。

## 4. 汇报

告诉用户：均分、比上次如何、校验是一次过还是几轮、本次成本（输出 token 与投入时长）、缺陷已登记的原话，以及评估页链接 `research/site/evals.html`。

成本字段为空时**如实说明取不到及其原因**，不要略过不提，更不要用 0 代替。

最后删掉 `tmp/` 下的评分文件。

## 边界

- 用户的评分与「最差的一处」照原样记录，不替他修饰、不替他打分、不劝他改分。
- 脚本以退出码 2 拒绝时，把它报的问题原样转达并让用户补答，不要自己编一个值绕过去。
- 评估记录是追加式的：不要去改 `research/evals/` 下已有的行。
