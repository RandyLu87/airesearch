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

**写法闸门（全量叶子扫描，独立于分数，脚本自动执行）**：首屏闸门只看四个字段，但被读到的字段远不止四格。脚本扫描三份文件的每个叶子节点，挡三类「页面认得出、读者看到的却是错的」写法，命中即计 0 分权重并记入缺口清单，**不放行**：

| 缺口类型 | 命中条件 | 页面上的样子 | 怎么改 |
| ------ | ------ | ------ | ------ |
| `bare-absent-string` | 值本身就是字符串 `"unavailable"` / `"not-applicable"`（而不是 `{ status, reason }` 对象；规范对象里的 `status` 键不算） | 原样输出 → 读者看到的是英文占位 `unavailable`，既不给数也不给缺失原因 | 改写成 `{ "status": "unavailable", "reason": "缺失原因 + 已查范围" }` |
| `unabbreviated-number` | 标了 `currency` / `unit` 的校验对象，`value` 是裸数字、或只 stringify 过的纯数字串（`"23051044345"` / `"23,051,044,345"`），且绝对值 ≥ 100 万。`unit` 不限货币，股 / 辆 / 户 这类计数单位同样算 | 只加千分位 → `23,051,044,345 HKD`；字符串则原样输出 | `value` 写成缩写字符串（`"230.51亿"` / `"23.05B"` / `"2.05亿"`） |
| `unit-overridden-by-currency` | `unit` 与 `currency` 各自声明了**不同**的量级（如 unit `"RMB million"` 对 currency `"RMB billion"`），`value` 又是裸数字 | 渲染层无从判断 value 是哪个量级，只能二选一 → 数字与单位错配 | 量级只留一处：unit 写全、currency 只写币种，或把量级折进 `value` 的缩写字符串 |

三类都不是「取不到数」，**数据已经采到，要改的是写法**——所以命中的字段按「没填」计 0 分权重：它在打分里本来算「已填」的那 1 分会被收回，而不是额外给分母加一格，分数会跟着掉。裸占位字符串尤其隐蔽：`resolve_field()` 会把它 `str()` 成一句非空文本，不单独拦就按「已填」计满权重，分数上完全看不出来——网易云音乐（`hk-9899`）的 5 年盈利能力趋势表毛利率显示成 `unavailable%`、页头市值显示成 11 位裸数字，就是在 9 分以上的得分下发出去的。渲染层不猜量级（缩写依赖 unit/currency 语境，只有写数据的人知道），所以缩写必须由采集/分析文件自己写；规则的正文在第 1 步「常见错误防范」与第 2 步「统一信封」的写法约束里。唯一的例外是**量级已经写在 `unit` 里**（`{ "value": 751766, "unit": "RMB million", "currency": "RMB" }`）：这不是猜，渲染层与 `resolve_field()` 都保留 unit 的量级渲染成 `751,766 RMB million`，而不是让纯币种 currency 把 million 压掉（压掉就是腾讯 FY2024 收入显示成 `751,766 RMB`、比真实值小 6 个量级，全仓库同类写法 238 处）。`value` 自带缩写仍是首选写法——一处写清楚比三元组拼装少一次误读机会。

**判定**：三份文件得分**全部 ≥ 7 分、首屏字段全部可解析、且无写法问题**（脚本退出码 0）→ 校验通过，进入下一流程；任一文件 **< 7 分，或存在首屏渲染不出的字段，或存在写法问题**（退出码 1）→ 进入关键信息补全流程。

## 2. 关键信息补全流程（任一文件未放行时）

1. **导出缺口清单**：`--gaps-out` 已把低于阈值文件的缺口结构化写出——每条含 `path`（字段定位）、`type`（缺口类型：todo / missing / empty / unfilled-enum / unavailable-without-reason）、`expected`（模板对该字段的填写要求）；首屏字段的形状问题另列在 `headlineProblems` 里，含 `label`（哪一格）、`path`、`found`（当前写法）；写法问题另列在 `shapeProblems` 里，含 `type`（`bare-absent-string` / `unabbreviated-number` / `unit-overridden-by-currency`）、`path`、`found`，对应的改写要求在 `shapeHints`。

2. **使用 Task 工具启动补全 Agent**，把缺口清单与对应文件现状发给它进行优化补全。给 Agent 的指令必须包含：
   - 缺口清单全文与数据截止时间；
   - 按缺口所属步骤执行对应规范：采集类缺口按第 1 步双源取数规则（`docs/research/workflow/01-data-collection.md`），分析类缺口按第 2 步统一信封与来源要求（`02-multi-dimension-analysis.md`），总结类缺口按第 3 步评分与策略规则（`03-analysis-summary.md`）；
   - 只补缺口，不改动已通过的字段；
   - **确实取不到的信息写 `{ "status": "unavailable", "reason": "缺失原因 + 已查范围" }`，取到了但算不出来的（分母为负、口径不成立）写 `{ "status": "not-applicable", "reason": "为什么不适用 + 支撑数字" }`，严禁为凑分编造数字**；
   - `headlineProblems` 里的字段改写成模板 `_spec.multiListing` 规定的形状，`shapeProblems` 里的字段按 `shapeHints` 改写（补 `{status, reason}` 对象 / 把大数字写成缩写字符串），两类都**不要重新取数**。

3. **合并与验算**：主会话把补全结果合并回对应 JSON；补全内容中涉及计算的数字仍须经 `docs/research/tools/financial_rigor.py` 验算并记入 `crossValidationLog`。

4. **重新校验**：回到第 1 节重跑 `data_validator.py`，直到三份文件全部 ≥ 7 分、首屏字段全部可解析、且无写法问题。

**循环上限**：补全最多执行 2 轮（写法问题不占轮次配额——它是改写，不是取数，必须清零）。2 轮后仍低于阈值，说明缺口属于客观不可得——把剩余缺口逐条改写为规范的 `unavailable + reason`（这会按 0.5 权重计分），再跑一次校验并如实向用户报告哪些信息缺失、已查过哪些范围；不允许为过线而放宽来源要求或编造数据。

## 3. 完成标准

三份文件经 `data_validator.py` 校验全部 ≥ 7 分、首屏四个字段全部可解析、写法闸门无命中（退出码 0）；补全轮次与最终得分已记录；补全的每个数字都有来源且经工具验算；所有 `unavailable` / `not-applicable` 字段都带原因与已查范围；缺口清单等中间产物只存在于 `tmp/`。
