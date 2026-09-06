---
name: public-company-financial-research
description: 上市公司长期价值调研，以商业模式、核心驱动和最新变化为主线。Use when 首次研究或更新港股、美股、A股公司，解读财报与公告，追踪公司特定 KPI，判断投资逻辑变化，或形成长期投资建议。
---

# 上市公司价值调研

研究流程、数据源规范、采集清单与产出模板全部保存在仓库内，两端共用一份：

**执行 `docs/research/public-company-financial-research.md`，按 1–7 步完成：数据采集 → 多维度分析 → 分析总结 → 数据校验 → 渲染网站 → 更新首页 → 评估与反馈。** 每一步的唯一正文在 `docs/research/workflow/<NN>-*.md`。第 7 步默认用 Task 工具启动一个**阅读评分 Agent**（只读第 5 步渲染的成品页与上一轮评估基线，按五维打分、返回 JSON），主会话补操作者两问后落账并发布；不要逐题问操作者打分。

主链路命令：

```bash
# 第 4 步：完整性打分（满分 10，任一低于 7 分走关键信息补全流程）
python3 docs/research/tools/data_validator.py check \
  --collection research/companies/<id>/financials-collection.json \
  --analysis   research/companies/<id>/financials-analysis.json \
  --summary    research/companies/<id>/financials-summary.json \
  --gaps-out   tmp/<id>-gaps.json

# 第 5 步：合并为渲染输入（内置校验闸门，任一低于阈值拒绝生成）
python3 docs/research/tools/build_final.py \
  --collection research/companies/<id>/financials-collection.json \
  --analysis   research/companies/<id>/financials-analysis.json \
  --summary    research/companies/<id>/financials-summary.json \
  --out        research/companies/<id>/financials-final.json

# 第 5/6 步：渲染公司分析页并更新首页卡片
npm run publish

# 第 7 步：落账评分 Agent 产出的评分 JSON（重跑发布让研究评估页包含这次评分）
python3 docs/research/tools/research_feedback.py \
  --company <id> --rating-json tmp/<id>-rating.json
```

规范产出是 `research/companies/<company-id>/` 下四份固定文件名的 JSON（`financials-collection.json`、`financials-analysis.json`、`financials-summary.json`、`financials-final.json`），页面一律由 `npm run publish` 生成，不手写 HTML，不手改 `research/site/`。仓库的命名与目录规范见 `AGENTS.md`。
