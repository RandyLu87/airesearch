# 上市公司价值调研流程

以长期股东视角回答三个问题：商业模式如何创造并获取价值，关键飞轮是否仍在运转，以及当前价格是否提供安全边际。每次运行遵循同一过程；研究结论可以变化，证据链和判断过程必须可复核。

本文件是研究流程的唯一正文。Codex 与 Claude Code 两端的 skill 都只是指向这里的薄壳，因此在这里做的改动两端同时生效。

## 0. 生成研究快照骨架

```bash
npm run snapshot:new -- <company-id>            # 落盘到规范路径
npm run snapshot:new -- <company-id> --stdout   # 只预览，不落盘
```

新公司先建财报期间账本 `research/companies/<company-id>/financials.json`，再生成骨架——骨架会从账本物化 `financialHistory`，已收官的报告期不必重新取数。账本最低覆盖最近两个完整年度（上市不足两年则自上市起全部）。详见 ADR-0014。

骨架从该公司最近一份研究快照继承**口径**：公司标识、驱动指标的 ID/定义/定义版本/单位/币种/scale/精度/期间类型/会计基础、标准指标的同类字段、最紧约束的 ID 与标签。所有数值、期间、趋势、结论与证据引用一律写成待办哨兵 `__TODO__`，必须重新取证后替换。

继承口径是为了让跨快照可比成为默认结果；不继承数值是为了让「假更新」无法成为省力路径。

## 1. 建立研究上下文

1. 明确公司、代码、交易所、报告币种、会计准则、持有周期和 Asia/Shanghai 数据截止时间。
2. 搜索 `research/companies/`；已有记录时先读 `snapshots/` 中当日 JSON 和最近一次 JSON 快照。若只有公司目录根部的历史 Markdown，则把它作为迁移输入，不再把 Markdown 作为规范输出。
3. 按仓库 `AGENTS.md` 确定公司目录和规范快照名；同一公司同一天更新已有 JSON，不新建第二份。

完成标准：公司身份和证券映射明确；已有观点已形成可比较基线；目标路径为 `research/companies/<company>/snapshots/YYYY-MM-DD-HHMM-analysis.json` 并通过校验器。

## 2. 构建数据包

每次先读 `docs/research/data-source-registry.md`，按市场运行 `scripts/research/fetch_financial_data.py`。API 负责发现与结构化，不替代原始财报、公告和附注。

数据包至少覆盖：最新定期报告、上次截止日后的重大公告、三张财务报表与至少三年年度数据、公司特定经营 KPI、股本与资本配置、带时间戳的参考价格。读取脚本生成的 `manifest.json`，逐项处理 `errors`；缺失项按 `docs/research/sources-and-priority.md` 回到官方来源补齐。

**参考价格单独按 `docs/research/data-source-registry.md` 第 4.1 节取证**：允许任何可公开访问、可引用、带时间戳的源，但必须双源交叉、必须建 `evidence` 记录、且不得把取价过程写进 `scripts/`。取不到可靠价格就中止本次研究，不要估——它会一路传导进估值结论。当前仓库没有 Tushare 港股权限，港股三表以年报和业绩公告原文为准。

完成标准：上述六类数据均有「已取得」或「缺失原因 + 已查范围 + 分析影响」；来源日志记录报告期、发布日期、抓取时间、币种、单位、URL 和口径限制。

## 3. 建立商业模式与核心驱动

读 `docs/research/business-model-playbook.md`。用一句可证伪的话说明用户、付费者、价值、收费方式、交付依赖、利润和现金来源；存在多种实质模式时分别建模。

把结论写进 `businessModel`：分部名录（ID、名称、战略角色、付费者、收费方式）、因果链、交付依赖、现金引擎。**这一块不存任何百分比**——收入占比由 `financialHistory[].segments` 的分部数据算出，避免两处打架。

同时填 `marketPosition`，强制给出**商业化份额与规模份额两个口径**，每个口径写明市场定义、分母包含谁、排除谁及原因。取不到就写 `status: "unavailable"` 与 reason，不允许整个口径缺席。两个口径信号相反时必须解释背离。

建立因果链：`关键投入/供给 → 获客/分发 → 使用/交易/销量 → 定价/变现 → 单位贡献 → 现金回收 → 再投资`。选择 5–8 个核心维度，每个维度保留 1–3 个能解释因果关系的公司特定指标，并建立定义、基线、最新值、趋势、阈值、证据和置信度。

**驱动指标延续优先。** 上一份研究快照已确立的驱动指标默认继续沿用，不要每次研究重新挑选一套。增加、移除或改变某个驱动的定义与口径时，必须在 `thesisChange.driverChanges` 中记录 `driverId`、变更类型和理由；改变口径还要求 `summary.businessModelChange` 升级为「机制变化」或「结构性变化」。校验器会强制这一点。

完成标准：每个收入/利润引擎都有驱动恒等式；1–3 个最紧约束已识别；每个核心指标能回接收入、利润、现金或资本回报。

## 4. 判断最新变化

将数据截止时间前的新财报、公告、产品/定价/渠道、管理层、资本配置、竞争、行业和监管证据映射到驱动链与指标卡。先比较上次基线，再判断：

- **未变**：机制仍成立，波动未突破阈值。
- **参数变化**：量、价、费率、成本、留存或利用率变化，赚钱方式未变。
- **机制变化**：获客、供给、收费、交付或再投资方式改变，需要重设指标。
- **结构性变化**：监管、技术、控制权、重大交易或资本约束改变长期价值归属。

完成标准：每条重大新证据都有驱动映射；商业模式与投资逻辑分别给出变化等级；结论变化明确指出触发证据和被替换的旧假设。

## 5. 检验财务、组织与治理

读 `docs/research/metric-playbook.md` 和 `docs/research/red-flags.md`。以现金流和资产负债表交叉验证利润，计算适用的增长、利润率、现金转换、近似 FCF、净现金、摊薄、ROIC 与增量 ROIC，并回接业务驱动。

人员与研发是必选项：整理员工、员工成本、人效、严格研发费用、资本化投入、研发相关资源和产出；缺少职能人数时只按 playbook 做区间估算。治理中分别评价执行能力、控制权、少数股东保护、股权激励和资本配置。

完成标准：至少三年年度基准与最新期间可对账；法定/调整后、基本/摊薄、原始/重列口径已桥接；每个黄色或红色风险都有良性解释、下一期阈值和估值影响。

## 6. 从商业模式推导估值

先判断长期价值来自高回报再投资、稳定现金收割、周期均值回归、事件兑现，还是未验证可选项。把核心驱动直接绑定收入增速、稳态利润率、再投资率、资本回报和风险折价；基准价值只纳入已验证业务。

**先读 `docs/research/valuation-playbook.md` 选方法。** 在 `methodSelection` 中同时记录理想方法与实际采用的主方法；两者不同时，`blockedBy` 必须列出缺哪些数据、为什么需要、去哪里取——这份清单会直接印在页面上。

情景由 `components` 声明（倍数项或面值项），价值区间、操作区间与隐含预期全部由引擎计算，**不要手写**：

```bash
npm run snapshot:sync -- research/companies/<company>/snapshots/<snapshot-id>.json
```

汇率与股数必填，汇率按 ADR-0013 的双源交叉规则取证并建立至少两条 evidence。体检规则触发后必须逐条回应；DCF 只能作为交叉验证，不作主方法。

完成标准：每个估值情景都能追溯到核心指标与商业模式假设；净现金只计一次；异常利润不机械年化；价格区间附带可验证触发条件。

## 7. 填写研究快照并发布

按 `docs/research/analysis-template.md` 和 `packages/research-schema/src/index.ts` 填写第 0 步生成的骨架。模型只负责研究事实、计算、推断和结构化判断，不直接手写 HTML。已有记录时保留上一快照作为历史基线，在新快照的 `thesisChange` 中明确本次新增证据、被替换假设和四类判断变化。

填写过程中随时校验，不要等到最后：

```bash
npm run snapshot:check -- research/companies/<company>/snapshots/<snapshot-id>.json
```

校验分三层：残留待办哨兵、schema、与上一份研究快照的可比性。哨兵与 schema 同时报告——已经填好的字段照样能得到 schema 反馈，只有由哨兵本身引发的连带报错会被抑制，所以「写一段校一段」真的可行。可比性层要等哨兵清空后才运行，因为它需要一份完整合法的快照。单次运行约 0.1 秒，可以放心高频使用。

哨兵提示到某个字段时注意：若该字段本就可选（例如百分比指标没有 `currency`），正确做法是删除整个键，而不是硬填一个值。

全部通过后运行 `npm run publish`。生成器必须从同一份 JSON 产生：

- `research/site/companies/<company>.html` 公司研究主页；
- `research/site/companies/<company>/reports/<snapshot-id>.html` 日期报告；
- 本地 CSS、JavaScript 与字体资源。

不要手改 `research/site/`。报告页面必须保留 snapshot SHA-256、相对资源路径、事实/计算/推断标签、商业模式核心驱动、估值情景和证据链接；缺失值显示原因，不用 0 或空字符串代替。

完成前逐项确认：

- 数据包 manifest、官方来源和报告引用可追溯；事实、计算与推断边界清楚。
- 商业模式、核心指标、最新变化、财务、人研、治理、估值、风险和后续阈值全部闭环。
- 最新价格的时间晚于关键公告，或已明确说明尚未反映。
- 运行 `npm run snapshot:check -- --all`，结果通过。
- 运行 `python3 scripts/research/validate_research_paths.py`，结果通过。
- 运行 `npm run verify`，确认 schema、两快照比较、离线资源和最终 HTML 全部通过。

面向用户先给立场、确信度和最关键证据，再给风险、估值与行动。末尾注明数据与消息截止时间，并声明不构成个性化投资建议。

## 按需读取

- 数据 API、认证、缓存与市场降级：`docs/research/data-source-registry.md`
- 估值方法选择、体检规则与组件模型：`docs/research/valuation-playbook.md`
- 来源优先级与最新信息核验：`docs/research/sources-and-priority.md`
- 商业模式、驱动树与分行业 KPI：`docs/research/business-model-playbook.md`
- 指标计算与人员研发估算：`docs/research/metric-playbook.md`
- 风险诊断：`docs/research/red-flags.md`
- 研究快照契约与发布规则：`docs/research/analysis-template.md`
