# Repository guidance

## 目的

以长期股东视角维护上市公司研究。每次研究以商业模式与核心驱动为主线，产出结构化数据与静态分析页面：双源交叉验证的采集数据、六个维度的分析（每个维度带追问与回答）、结论与信心度评分（满分 10，价值投资视角下的看多程度）、四类策略建议（空仓者 / 持仓者 / 卖出信号 / 加仓信号，逐条绑定可观察触发条件）。

所有数字必须可追溯到带时点的来源；涉及计算一律经工具验算，禁止 LLM 心算；取不到的数据如实写 `unavailable + 缺失原因 + 已查范围`，严禁为凑完整性编造。

## 仓库布局

- 研究流程总纲：`docs/research/public-company-financial-research.md`；每一步的唯一正文按序号存放在 `docs/research/workflow/<NN>-*.md`。
- 数据源规范、采集清单与四份产出模板在 `docs/model/`；研究工具（校验、合并、验算、取数）在 `docs/research/tools/`。
- 每家公司的研究产出存放在 `research/companies/<company-dir>/`，固定四份文件名（见下文）。
- 发布产物在 `research/site/`，只由 `npm run publish` 生成并整体提交，不手改。
- 精加工的专题报告与最终导出物在 `research/reports/<topic>/`。
- 一次性中间产物（缺口清单、渲染核对、缓存等）放 `tmp/`，不提交。
- **旧快照流程已整体移除**（2026-08-05）：渲染引擎、快照 CLI、方法论文档与旧页面都已删除，站点只渲染新管线产出。`research/companies/*/snapshots/`、`financials.json`、`commitments.json` 与历史 Markdown 作为**只读数据存档**保留在仓库中，不再渲染、不再新增、不回填。

## 研究流程

- 新公司研究与更新一律使用 `$public-company-financial-research` skill，执行 `docs/research/public-company-financial-research.md` 的 1–6 步：**数据采集 → 多维度分析 → 分析总结 → 数据校验 → 渲染网站 → 更新首页**。
- 数据源与交叉验证规范的唯一正文是 `docs/model/financial-data.md`：**分级交叉验证**——Level 1（收入、净利润、自由现金流、总股本、市值、现金、负债）必须两个独立来源，Level 2（毛利率、经营利润率、ROE、ROIC、PEG）建议双源、单源须注明，Level 3（CEO 履历、公司沿革、技术栈、商业模式描述、企业文化）单源即可；误差 >1% 标记，>5% 必须回原始财报。比较数值前先过 Metadata 闸门（报告期/币种/单位/准则/合并口径/是否追溯调整），口径不一致直接记「不可比」而非算误差率。
- 采集清单的唯一正文是 `docs/model/financial-model.md` 的 10 个维度，不多不少。
- 网络采集、维度分析与缺口补全通过 Task 工具启动后台 Agent 执行；每个数据点必须带来源名称、URL 与所属报告期，无出处的数字不接受。
- 涉及计算的数字用 `docs/research/tools/financial_rigor.py` 验算（市值、交叉验证、估值倍数、三情景），工具输出记入 `crossValidationLog`。
- 完整性闸门有两道：第 4 步 `data_validator.py` 打分（满分 10，任一文件低于 7 分走关键信息补全流程，最多 2 轮）；第 5 步 `build_final.py` 合并时复用同一校验，低于阈值拒绝生成。
- **本仓库不直接引用 `ai-berkshire/` 工程内的任何文件**：用到什么先迁移进本仓库独立维护（规范类迁至 `docs/model/`，工具类迁至 `docs/research/tools/`），迁移件顶部注明来源与日期，此后不回读原件。

## 文件规范

- 公司目录命名不变：港股 `hk-<4至5位代码>-<slug>`，美股 `us-<小写代码>-<slug>`（代码去标点），A 股 `sh|sz|bj-<6位代码>-<slug>`；`<slug>` 一律小写 ASCII kebab-case，不用空格、中文、下划线或 `new`/`final`/`v2` 之类后缀。
- 每家公司的研究产出固定四份文件名，渲染层按名发现，不接受变体：
  - `financials-collection.json` —— 第 1 步采集（`docs/model/financials—model-template.json` 结构）；
  - `financials-analysis.json` —— 第 2 步分析（`financials—analysis-template.json` 结构）；
  - `financials-summary.json` —— 第 3 步总结（`financials—summary-template.json` 结构）；
  - `financials-final.json` —— 第 5 步合并产物（`financials—final-template.json` 契约），**只由 `docs/research/tools/build_final.py` 生成，不手写**。
- 新研究不产出 Markdown 报告作为规范输出，不手写 HTML，不新建 `snapshots/` 快照；公司目录里的旧快照、历史 Markdown、`financials.json`、`commitments.json` 视为只读存档。
- HTML 只由 `npm run publish` 生成：公司分析页 `research/site/companies/<company-dir>.html`，首页卡片由数据文件自动派生（有产出即有卡，勿手工维护）。
- 不要发明别的文件名。完成任何研究任务前运行 `python3 scripts/research/validate_research_paths.py` 并修正所有报告的违规项，不要询问用户。
- 不提交 `.DS_Store`、缓存、冒烟测试文件、渲染核对截图等一次性产物。

## 校验

- 研究方法改动只发生在 `docs/research/` 与 `docs/model/`，不改 skill 薄壳；两端 agent 读同一份正文。
- 第 4 步：`python3 docs/research/tools/data_validator.py check --collection … --analysis … --summary … --gaps-out tmp/<id>-gaps.json`，三份全部 ≥ 7 分才放行。
- 第 5 步：`python3 docs/research/tools/build_final.py …` 合并（内置同一阈值闸门），然后 `npm run publish`。
- 新建、改名或移动公司研究后运行 `python3 scripts/research/validate_research_paths.py`。
- 改动模板、渲染组件、样式或发布逻辑后运行 `npm run verify`（typecheck + 测试 + 路径校验）。
- 交接结构性改动前运行 `git diff --check`，并确认 README 链接可达。

## Agent skills

### Issue tracker

Issues 与 PRD 在本仓库的 GitHub Issues 维护，见 `docs/agents/issue-tracker.md`。

### Triage labels

使用映射到仓库 GitHub labels 的五个规范分诊角色，见 `docs/agents/triage-labels.md`。

### Domain docs

本仓库使用单一领域上下文 `CONTEXT.md`，决策记录在 `docs/adr/`，见 `docs/agents/domain.md`。
