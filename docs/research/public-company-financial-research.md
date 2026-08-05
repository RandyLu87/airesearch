# 上市公司价值调研流程

以长期股东视角回答三个问题：商业模式如何创造并获取价值，关键飞轮是否仍在运转，以及**当前价格是否提供安全边际**。每次运行遵循同一过程；研究结论可以变化，证据链和判断过程必须可复核。

本文件是研究流程的唯一正文。Codex 与 Claude Code 两端的 skill 都只是指向这里的薄壳，因此在这里做的改动两端同时生效。

> 本流程于 2026-08-05 重构为以下 6 步，旧快照流程（骨架继承、数据包、快照契约、承诺台账等）已整体移除：渲染引擎、CLI 与旧页面都已删除，站点只渲染新管线产出；公司目录里的旧快照与账本文件作为只读数据存档保留。**本流程不直接引用 `ai-berkshire/` 工程内的任何文件**——用到什么就先迁移进本仓库独立维护（规范类迁至 `docs/model/`，工具类迁至 `docs/research/tools/`）。步骤正文按序号存放在 `docs/research/workflow/`（如 `01-data-collection.md`），新拆出的步骤照此编号。

## 1. 数据采集

执行 `docs/research/workflow/01-data-collection.md`（本步骤唯一正文）。一步完成研究上下文、双源取数与程序化交叉验证：使用 Task 工具启动后台 Agent 从网络采集 `docs/model/financial-model.md` 定义的 10 个维度，数据源与误差规则以 `docs/model/financial-data.md` 为准，关键数据用 `docs/research/tools/financial_rigor.py` 程序化验算，产出按 `docs/model/financials—model-template.json` 落盘到 `research/companies/<company-id>/`。

**完成标准**：10 个维度均为「已取得」或「缺失原因 + 已查范围 + 分析影响」；关键数值都有双源记录与误差标记；市值通过 `verify-market-cap` 验算；数据截止时间已声明。

## 2. 多维度分析

执行 `docs/research/workflow/02-multi-dimension-analysis.md`（本步骤唯一正文）。在第 1 步采集产出的基础上，对六个维度——生意本质、护城河、逆向思考与风险、管理层、行业与长期趋势、估值——**每个维度用 Task 工具启动一个独立后台 Agent 继续网络搜索材料后汇总**。六个维度共用统一输出信封（结论 / 分析 / 追问及回答 / 缺口），所有分析必须有数据支撑并附来源，追问必须有回答；涉及计算的数字经 `docs/research/tools/financial_rigor.py` 验算（估值维度含 `three-scenario` 三情景计算），汇总后按 `docs/model/financials—analysis-template.json` 落盘到 `research/companies/<company-id>/`。

**完成标准**：六个维度全部返回且格式统一；每个结论都有数据与来源支撑；追问全部有回答；估值数字全部经工具验算；缺失项写明原因与已查范围。

## 3. 分析总结

执行 `docs/research/workflow/03-analysis-summary.md`（本步骤唯一正文）。**使用 Task 工具启动一个独立评估 Agent**，只基于第 1、2 步已落盘的数据与分析做评估、不重新采集：对六个维度——生意质量、护城河、管理层、最大风险、文明趋势、估值——逐一给出结论总结与信心度评分（总分 10 分，反映证据密度而非看多程度）；对四类主要策略——空仓者、持仓者、卖出信号、加仓信号——给出绑定可观察触发条件的专业建议。汇总按 `docs/model/financials—summary-template.json` 落盘到 `research/companies/<company-id>/`。

**完成标准**：六个维度的结论与评分齐全且打分依据可追溯到前两步具体字段；四类策略建议齐全且触发条件可观察、可执行；引用的价格与阈值均来自前两步经工具验算的数字；数据截止时间已声明。

## 4. 数据校验

执行 `docs/research/workflow/04-data-validation.md`（本步骤唯一正文）。运行 `docs/research/tools/data_validator.py` 对前三步的落盘 JSON 做模板驱动的完整性校验与打分（满分 10 分，规范的 `unavailable + reason` 计 0.5 权重）。三份文件全部 ≥ 7 分则通过；任一低于 7 分进入**关键信息补全流程**——用 `--gaps-out` 导出结构化缺口清单，使用 Task 工具启动补全 Agent 按对应步骤的规范优化补全（只补缺口、不改已过字段、取不到严禁编造），合并验算后重跑校验，最多 2 轮，达标后进入下一流程。

**完成标准**：三份文件校验全部 ≥ 7 分（脚本退出码 0）；补全的数字均有来源且经工具验算；`unavailable` 字段均带缺失原因与已查范围；缺口清单等中间产物只存在于 `tmp/`。

## 5. 渲染网站

执行 `docs/research/workflow/05-render-site.md`（本步骤唯一正文）。先用 `docs/research/tools/build_final.py` 把三份校验通过的文件合并为 `research/companies/<company-id>/financials-final.json`（脚本内部复用第 4 步校验器，任一低于阈值或公司不一致即拒绝，这份文件不手写）；再运行 `npm run publish`，站点生成器自动发现该文件并渲染 `research/site/companies/<company-id>.html`——维度总结与信心度、策略建议、六个分析维度、追问与缺口、来源与免责声明，样式复用既有 `research.css`，缺失字段显示原因而非空白。不要手改 `research/site/`。

**完成标准**：`financials-final.json` 由脚本生成且记录三份得分；公司分析页十个区块齐全；`npm run typecheck`、`npm test`、`python3 scripts/research/validate_research_paths.py` 全部通过。

## 6. 更新首页

执行 `docs/research/workflow/06-update-home.md`（本步骤唯一正文）。首页覆盖是派生的，不做人工维护：有 `financials-final.json` 的公司自动获得一张卡片（链接指向 `companies/<company-id>.html`），「数据截止」取该文件的 `meta.dataCutoff`，按日期倒序排列。第 5 步跑过 `npm run publish` 的话首页同批已更新，本步骤核对即可：本次研究的公司有且只有一张卡、时间正确、其他公司卡片不受影响。

**完成标准**：首页卡片与 `research/companies/` 下的数据文件一一对应；本次研究公司的卡片时间正确；`npm test` 通过。

全部完成后向用户汇报：六个维度的结论与信心度、四类策略建议、数据截止时间与页面链接，并保留不构成个性化投资建议的声明——内容以第 3 步总结文件为准，不在汇报里新增页面上没有的判断。

## 按需读取

- 数据采集步骤正文（第 1 步唯一正文）：`docs/research/workflow/01-data-collection.md`
- 多维度分析步骤正文（第 2 步唯一正文）：`docs/research/workflow/02-multi-dimension-analysis.md`
- 分析总结步骤正文（第 3 步唯一正文）：`docs/research/workflow/03-analysis-summary.md`
- 数据校验步骤正文（第 4 步唯一正文）：`docs/research/workflow/04-data-validation.md`，校验脚本：`docs/research/tools/data_validator.py`
- 渲染网站步骤正文（第 5 步唯一正文）：`docs/research/workflow/05-render-site.md`，合并脚本：`docs/research/tools/build_final.py`
- 更新首页步骤正文（第 6 步唯一正文）：`docs/research/workflow/06-update-home.md`
- 数据源与交叉验证规范：`docs/model/financial-data.md`
- 数据采集清单：`docs/model/financial-model.md`
- 数据采集产出模板：`docs/model/financials—model-template.json`
- 多维度分析产出模板：`docs/model/financials—analysis-template.json`
- 分析总结产出模板：`docs/model/financials—summary-template.json`
- 最终渲染输入契约：`docs/model/financials—final-template.json`

