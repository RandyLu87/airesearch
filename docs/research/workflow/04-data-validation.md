# 数据校验（研究流程第 4 步）

本文件是 `docs/research/public-company-financial-research.md` 第 4 步的唯一正文。对前三步落盘的 JSON 结果文件做完整性校验与打分；低于阈值时进入关键信息补全流程，补全后重新校验，直到达标再放行进入下一流程。

- **输入**：第 1 步采集文件、第 2 步分析文件、第 3 步总结文件（均在 `research/companies/<company-id>/` 下）。
- **工具**：`docs/research/tools/data_validator.py`（模板驱动，零外部依赖）。
- **产出**：校验通过的三份文件（可能经补全更新）；补全过程中的缺口清单为中间产物，放 `tmp/`，不提交。

## 1. 运行校验

```bash
python3 docs/research/tools/data_validator.py check \
  --collection research/companies/<company-id>/<采集文件>.json \
  --analysis   research/companies/<company-id>/<分析文件>.json \
  --summary    research/companies/<company-id>/<总结文件>.json \
  --gaps-out   tmp/<company-id>-gaps.json
```

**打分规则（满分 10 分，脚本自动执行）**：以 `docs/model/` 三份模板为基准，逐字段对照——模板中含 `__TODO__` 或枚举提示（`A | B | C`）的叶子字段为计分槽位；已填实值计 1 分权重；规范的 `{ "status": "unavailable", "reason": "缺失原因 + 已查范围" }` 计 0.5 分权重（「取不到并写明已查范围」是合法结果，但完整性弱于取到）；缺键、残留 `__TODO__`、空值、枚举未选、unavailable 未写 reason 计 0 分并记入缺口清单。

**首屏可渲染性闸门（独立于分数，脚本自动执行）**：页头摘要条与首页卡片直读四个字段——`currentValuation.marketCap.reported`、`currentValuation.sharePrice`、`currentValuation.pe`、`meta.dataCutoff`。脚本逐个按渲染层的规则解析（标量 / 校验对象 / `{ primary, alt[] }` 多市场对象 / 带 `reason` 的 `unavailable` 或 `not-applicable`），**解析不出来一律不放行**，报告里标为 `[首屏渲染不出]`。

这道闸门是补分数的盲区：分数只看槽位填没填，看不出「填了但页面显示不出来」。理想汽车（`hk-2015`，H 股 + 美股 ADS 双重上市）把 `sharePrice` 写成 `{hk: …, us_ads: …}`、`marketCap.reported` 写成 `{hk_hkd: …, us_usd: …}`，槽位全满拿到 9.7 分，页头的市值与股价却是两个破折号（`research/evals/defects.jsonl` 2026-08-09 那条）。**这类问题的数据通常已经采到了，要改的是写法，不是回去重新取数。**

**判定**：三份文件得分**全部 ≥ 7 分且首屏字段全部可解析**（脚本退出码 0）→ 校验通过，进入下一流程；任一文件 **< 7 分或存在首屏渲染不出的字段**（退出码 1）→ 进入关键信息补全流程。

## 2. 关键信息补全流程（任一文件未放行时）

1. **导出缺口清单**：`--gaps-out` 已把低于阈值文件的缺口结构化写出——每条含 `path`（字段定位）、`type`（缺口类型：todo / missing / empty / unfilled-enum / unavailable-without-reason）、`expected`（模板对该字段的填写要求）；首屏字段的形状问题另列在 `headlineProblems` 里，含 `label`（哪一格）、`path`、`found`（当前写法）。

2. **使用 Task 工具启动补全 Agent**，把缺口清单与对应文件现状发给它进行优化补全。给 Agent 的指令必须包含：
   - 缺口清单全文与数据截止时间；
   - 按缺口所属步骤执行对应规范：采集类缺口按第 1 步双源取数规则（`docs/research/workflow/01-data-collection.md`），分析类缺口按第 2 步统一信封与来源要求（`02-multi-dimension-analysis.md`），总结类缺口按第 3 步评分与策略规则（`03-analysis-summary.md`）；
   - 只补缺口，不改动已通过的字段；
   - **确实取不到的信息写 `{ "status": "unavailable", "reason": "缺失原因 + 已查范围" }`，取到了但算不出来的（分母为负、口径不成立）写 `{ "status": "not-applicable", "reason": "为什么不适用 + 支撑数字" }`，严禁为凑分编造数字**；
   - `headlineProblems` 里的字段改写成模板 `_spec.multiListing` 规定的形状，**不要重新取数**。

3. **合并与验算**：主会话把补全结果合并回对应 JSON；补全内容中涉及计算的数字仍须经 `docs/research/tools/financial_rigor.py` 验算并记入 `crossValidationLog`。

4. **重新校验**：回到第 1 节重跑 `data_validator.py`，直到三份文件全部 ≥ 7 分且首屏字段全部可解析。

**循环上限**：补全最多执行 2 轮。2 轮后仍低于阈值，说明缺口属于客观不可得——把剩余缺口逐条改写为规范的 `unavailable + reason`（这会按 0.5 权重计分），再跑一次校验并如实向用户报告哪些信息缺失、已查过哪些范围；不允许为过线而放宽来源要求或编造数据。

## 3. 完成标准

三份文件经 `data_validator.py` 校验全部 ≥ 7 分且首屏四个字段全部可解析（退出码 0）；补全轮次与最终得分已记录；补全的每个数字都有来源且经工具验算；所有 `unavailable` / `not-applicable` 字段都带原因与已查范围；缺口清单等中间产物只存在于 `tmp/`。
