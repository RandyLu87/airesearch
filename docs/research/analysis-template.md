# Research Snapshot 契约

新研究的规范产出是 JSON `Research Snapshot`，不是 Markdown 或手写 HTML。最终可执行定义以仓库 `packages/research-schema/src/index.ts` 的 Zod schema 为准；修改字段时先改 schema 和测试，再改本文件。

`schemaVersion` 目前有两个合法取值。**新研究一律写 `1.1.0`。** `1.0.0` 是结构化商业模式、行业地位与计算式估值出现之前的契约，仅供已发布的历史快照原样保留（见 ADR-0017）；回填历史快照等于给几个月前的判断编造当时并未记录的汇率与份额分母，不允许。

## 路径与生命周期

```text
research/companies/<company-id>/snapshots/YYYY-MM-DD-HHMM-analysis.json
```

- 时间采用 Asia/Shanghai，`snapshot.id` 必须等于文件名去掉 `.json`。
- `company.id` 必须等于公司目录名。
- 同一公司同一天只有一份 snapshot；日内补充直接更新它。
- 公司目录根部已有的 `.md` 仅作历史迁移输入，保留但不继续追加。
- JSON 是事实来源；`npm run publish` 负责生成 HTML，禁止反向从 HTML 修补 JSON。

## 顶层结构

```json
{
  "schemaVersion": "1.1.0",
  "company": {},
  "snapshot": {},
  "investmentHorizon": "3-5 年",
  "summary": {},
  "businessModel": {},
  "marketPosition": {},
  "standardMetrics": [],
  "driverMetrics": [],
  "constraints": [],
  "thesisChange": {},
  "financialHistory": [],
  "sections": [],
  "valuation": {},
  "risks": [],
  "viewChanges": {},
  "checkpoints": [],
  "evidence": [],
  "disclaimer": "本报告仅作研究与教育用途，不构成个性化投资建议。"
}
```

## 必填语义

### `company` 与 `snapshot`

- `company`：规范 ID、公司名、法定名、ticker、市场、报告币种、会计准则、`industryTags`（驱动行业相关的估值体检规则，例如 `银行`、`保险`、`资源`、`周期`）。
- `snapshot.createdAt`：研究快照创建时间；`dataCutoff`：本次消息与数据截止时间。均使用带时区 ISO 8601。
- `snapshot.sourceNote`：从历史 Markdown 迁移时指向公司目录内的原文件；没有历史迁移输入时省略。

### `summary`

必须一眼回答：当前立场与确信度、一句话商业模式、商业模式变化等级、带时点的参考价格、合理价值区间、安全边际、最强证据、最大风险和下一验证条件。

`businessModelChange` 只能是：`未变`、`参数变化`、`机制变化`、`结构性变化`。

### `businessModel`

商业模式画像，**不含任何百分比**。收入占比一律由 `financialHistory[].segments` 算出，因此两处不可能互相矛盾。

- `segments`：分部名录，每项包含稳定 ID、名称、战略角色（`经济核心` / `增长引擎` / `辅助` / `收缩中` / `孵化`）、付费者、收费方式与 evidence IDs。ID 必须与 `financialHistory[].segments[].segmentId` 对应。
- `causalChain`：从投入到再投资的一条因果链。
- `deliveryDependency`：获客、供给、履约依赖的渠道、资产、牌照或合作方。
- `cashEngine`：利润与现金究竟来自哪一段。
- `moat`：1–3 条**真正起作用的**护城河，不是逐类打勾（见 ADR-0018）。每条含稳定 ID、`type`（品牌定价权 / 转换成本 / 网络效应 / 规模成本 / 技术与牌照 / 其他，取「其他」必须写 `typeNote`）、`mechanism`（它作用在 `causalChain` 哪一环——写位置，不写形容词）、`driverIds`、`trend`（变宽 / 稳定 / 变窄 / 待验证）、`breaker`（什么能摧毁它，含可观察的前置信号）和 evidence IDs。
  - **`driverIds` 必须命中已声明的 `driverMetrics[].id`**，校验器强制。这是整块的意义所在：护城河因此继承驱动指标的定义、口径、阈值、证据与跨快照延续；找不到指标支撑的护城河，先怀疑它并不存在。
  - `trend` 用「变宽/变窄」而不复用 `constraints` 的「改善/恶化」——护城河宽度变化本身没有好坏方向。
  - 增删与趋势变动只产生**警告**，与最紧约束一致：护城河被证伪或新护城河成型是研究进展的正常结果，且它没有口径字段可供 `driverChanges` 那套机制比较。说明义务由 `WORKFLOW.md` 承担。
  - 字段可选只为向后兼容。`snapshot:new` 生成的骨架把它写成哨兵，因此新研究实际必填；已发布快照不回填，页面显示「本次研究未声明护城河」。

声明了两个及以上分部时，最新期间必须给出分部数据；取不到就逐个写 `status: "unavailable"` 与 reason。

### `marketPosition`

行业地位，**强制商业化与规模两个口径并列**。缺任何一个口径都不合法——取不到数据时仍要给出该口径并写 `status: "unavailable"` 与 reason。

每个 measure 必须写清 `marketDefinition`、`denominatorIncludes` 与 `denominatorExcludes`（排除谁、为什么）。没有分母定义的百分比不是事实。

两个口径给出方向相反的信号时（一个改善或稳定、一个恶化），必须填 `divergence` 解释背离含义。这类背离通常是竞争格局变化最早的可观察证据。

### `standardMetrics`

用于跨公司或跨快照的严格比较。每个 observation 必须记录：

- `metricId` 必须是 `packages/research-schema/src/metric-dictionary.ts` 中已登记的键；定义、算式与陷阱由词典提供，快照只能通过可选的 `definitionNote` **追加**公司特定说明，不能覆盖（见 ADR-0015）；
- `definitionVersion`、期间、期间类型、会计基础；
- `reported`、`calculated` 或 `unavailable` 状态；
- 数值使用十进制字符串，禁止二进制浮点写回；
- 币种、单位、scale、precision 与 evidence IDs；
- 缺失时省略 `value` 并填写 `reason`，禁止用 0 伪装缺失。

只有定义版本、币种、单位、scale、期间类型和会计基础全部兼容时，生成器才可计算 delta；否则显示“不可比较”及原因。

### `driverMetrics`

选择 5–8 个真正促使商业模式运转的公司特定指标，而不是通用 KPI 清单。每项必须包含：

- 稳定 ID、定义、`definitionVersion` 和因果作用；
- 维度：增长、盈利、现金、护城河或治理；信号属性：领先、同步或滞后；
- 最新期间、`periodType`、`accountingBasis`、独立数值与展示值、单位、币种、scale、precision、历史基线、趋势、置信度和证据；
- 下一报告期的可证伪阈值。

跨快照驱动只有在定义、定义版本、单位、币种、scale、期间类型和会计基础全部兼容时才可连接或判断变化；否则必须标为“不可比较”，不能把年度值与季度值直接相减。

`periodType` 允许 `month`，**且只有驱动指标允许**。最有价值的领先指标常常是月度的——销量、产量、保费、月营收——压成季度就丢掉了值得跟踪的那个拐点。月度期间必须写成零填充的 `YYYY-MM`（如 `2026-01`），校验器强制；写成 `2026 M1` 会让字典序静默错排（`M1 < M10 < M2`）。月度经营数据未经审计、通常也不在会计准则口径内，因此不得进入 `financialHistory` 与 `standardMetrics`。

**驱动指标延续优先。** 驱动指标集不是每次研究自由重选的。新快照默认继承上一份快照的驱动 ID、定义与全部口径字段，只更新数值、期间、趋势、阈值和证据。`npm run snapshot:new` 生成的骨架已经替你继承好这些字段。增删改必须按下一节在 `thesisChange.driverChanges` 中交代，校验器会强制。

### `constraints`

保存当前阻断商业模式飞轮的 1–3 个最紧约束。每项包含稳定 ID、标签、改善/稳定/恶化/待验证状态、解释和 evidence IDs，供公司主页跨快照比较。

### `thesisChange`

分别说明投资逻辑、财务质量、治理和估值相对上一快照如何变化，并列出本次新增证据和已被替换的旧假设。没有变化也必须明确写“未变”及理由。

可选字段 `driverChanges` 记录驱动指标集相对上一快照的变动，每项包含 `driverId`、`change`（`added` / `removed` / `redefined`）和 `reason`：

```json
"driverChanges": [
  { "driverId": "content-cost-ratio", "change": "removed", "reason": "已并入毛利率驱动，单独跟踪产生重复计数。" }
]
```

强制规则（由 `npm run snapshot:check` 执行）：

- 上一快照有、本次没有的驱动，必须有 `removed` 记录；
- 本次新增的驱动，必须有 `added` 记录；
- 两边都有但七个口径字段任一不同的驱动，必须有 `redefined` 记录，**并且** `summary.businessModelChange` 必须是「机制变化」或「结构性变化」——口径漂移不能伪装成参数波动；
- `reason` 不得为空。

字段可选是为了向后兼容：契约启用前的快照不含该字段，仍然合法。契约落地时已存在的快照由校验器中一份显式豁免清单跳过可比性层（目前只有网易云音乐 2026-07-31 一条），历史断裂如实保留、不回补。回填 `--at` 不能换来豁免。

最紧约束的增删只产生警告，不阻断——约束被解除是研究进展的正常结果，且它没有口径字段可比。

### `financialHistory`、`sections` 与 `valuation`

- **`period` 字符串必须能按字典序排出时间顺序。** `sortPeriods` 先按期间类型再按 `period.localeCompare` 排序，`financialHistory` 的最后一项就是「最新期间」——健康体检的分部走势、最新期对比表和 `at(-1)` 全部依赖它。写成 `Q1 2026` 的公司一旦攒够跨年的季度就会静默错序（`Q1 2026` < `Q1 2027` < `Q2 2026`，最新期变成 Q2 2026）。季度一律写成 `2026 Q1`、半年度写成 `2026 H1`，年度写成 `FY2026`；月度只出现在驱动指标里，写成 `2026-01`。
- `financialHistory` **由 `research/companies/<company-id>/financials.json` 物化，不手写**。运行 `npm run snapshot:sync` 生成，校验器逐字段比对；一致性只约束该公司的当前快照，历史快照按发布时的数字冻结（见 ADR-0014）。每个期间记录 `periodType`、`accountingBasis` 与 `status`（`reported` 或由其他披露值 `calculated`）；每个财务值使用对象保存十进制字符串 `value`、`unit`、`currency`（货币值必填）、`scale` 和 `precision`，缺失字段直接省略，禁止由渲染层假设“亿元”或默认币种。分部数据放在期间的 `segments` 里。
- `sections` 负责完整的商业模式、竞争、财务质量、组织研发、治理等论证。每节包含结论性摘要、证据要点和 evidence IDs。
- `valuation` 先读 `docs/research/valuation-playbook.md`。必填 `currency`、`valueScale`、`tradingCurrency`、`shares`（scale 必须等于 `valueScale`）与 `fx`（至少两条 evidence，按 ADR-0013 双源交叉）。
- `valuation.scenarios` 恰好三个（熊市/基准/牛市），各自写明假设、触发条件与 `components`。组件是倍数项（指标区间 × 倍数区间）或面值项（金额，可带 `discountPct` 与 `discountReason`）。
- **`computed`、`actionZones` 的边界、`impliedExpectation` 与 `summary.fairValue` 全部由引擎计算，作者不得手写。** 运行 `npm run snapshot:sync`；校验器会重算并在不符时阻断。`actionZones` 只有 `action` 文案可以手写。
- `valuation.healthCheck` 必须回应每一条被触发的体检规则；`methodSelection` 必须同时给出理想方法与实际采用的主方法，两者不同时 `blockedBy` 不能为空。
- `valuation.disagreement` 记录分歧点：`driverId`（**必须命中已声明的驱动**，校验器强制）、`marketAssumption`、`ourAssumption`、`ifMarketIsRight`、`converged`。隐含倍数是市场的数字，不是市场的理由；把分歧锚在一个可观测量上，下一份财报才能判定谁对。「竞争加剧」「监管风险」对任何公司在任何价格都成立，因此解释不了任何具体价差。`converged` 为真时 `ifMarketIsRight` 改写为「当前价格不提供安全边际」的含义，而不是硬编一个错误。

### `evidence`

每条证据必须标记：

- `fact`：原始披露或直接可观察数据；
- `calculation`：使用已披露输入可复算的结果；
- `inference`：分析判断或区间估算。

同时保存标题、发布者、报告期/事件日、发布日期、抓取时间、直接 URL 和必要的口径限制。驱动指标和章节必须通过 `evidenceIds` 引用这些记录。

### `commitmentSummary`

治理的纵向证据，从 `research/companies/<company-id>/commitments.json` 物化（见 ADR-0019），**不手写**。

- 台账每条记录含稳定 ID、`kind`（`承诺` / `并购` / `回购` / `分红` / `新业务投入`）、`statedAt`、`venue`、`quote`（原文摘录，不转述）、`commitment`（可判定的内容）、`dueBy`（日期或 `未给时限`）、`status`（`兑现` / `部分兑现` / `未兑现` / `待到期` / `已撤回`）、`resolvedAt`、`outcome` 与至少一条 evidence。
- 已结算的条目必须写 `resolvedAt` 与 `outcome`：`status` 的判定本身是判断，只写一个状态字不合格。
- `并购` 与 `回购` 额外必填 `amount` 与 `valuationAtTime`——留下当时的估值坐标，才能把「回购发生在明显高估区」从印象变成可复算的记录。
- 快照里的摘要含覆盖起始时点、五种状态的计数、未结清清单、最近一次结算与资本配置逐笔。`npm run snapshot:sync` 物化，`npm run snapshot:check` 逐字段比对；一致性只约束该公司的当前快照，历史快照按发布时冻结（同 ADR-0014）。
- **只呈现计数与清单，不给兑现率档位，也不做加权综合评分。** 计数是事实，档位是判断，而这个判断的分母取决于录入了哪些承诺——写成档位会让一个可靠「少录几条软承诺」改善的数字看起来像评级。
- 台账缺失只产生警告（刚上市的公司可能确实没有可录条目），但**空台账也必须显式存在并写明 `coverageFrom`**：「没有承诺」和「没查」必须能区分。快照有摘要而目录没有台账则是错误——那份摘要来自无处。

### `evidenceDensity`

本次结论有多少建立在缺失值与推断之上，由引擎从快照自身统计（见 ADR-0020）。

- `computed` 含 `unavailableShare`（标准指标 + 驱动 + 份额口径中 `unavailable` 的占比）、`inferenceShare`（evidence 中 `inference` 占比）、`lowConfidenceDriverShare`、`unsupportedDriverShare`（所引用证据全为 `inference` 的驱动占比）与 `idealMethodBlocked`。**作者不得手写**，运行 `npm run snapshot:sync`；校验器会重算并在不符时阻断。
- `responses` 必须逐条回应被触发的规则，也不得回应未触发的规则。四值语义：`adopted` 已按建议下调结论强度或补齐数据、`blocked` 认可但取不到、`rejected` 本公司不适用并说明理由、`acknowledged` 已在风险或约束中反映。
- **`blocked` 必须附 `blockedBy`**，每项写 `dataItem` / `whyNeeded` / `whereToGet`。回应不能是免责声明——写声明比补数据便宜，所以便宜那条路要被堵住。
- **规则触发本身不阻断发布**，只有「触发了却没回应」才阻断。证据稀薄有时是被研究对象的事实；用阻断去逼诚实，只会让作者把 `unavailable` 改写成 `inference`。
- `unsupportedDriverShare` 是这组里最硬的一条：它不看比例，只看有没有。一个驱动引用的证据全是推断，等于在用推断解释推断。
- 字段可选仅为向后兼容；`snapshot:new` 把 `computed` 写成哨兵、`responses` 留空，因此新研究实际必填。已发布快照不回填。

## 发布与验收

完成 JSON 后依次运行：

```bash
npm run snapshot:sync  -- <snapshot-path>
npm run snapshot:check -- <snapshot-path>
python3 scripts/research/validate_research_paths.py
npm run publish
npm run verify
```

验收结果必须包括公司主页、所有日期报告、本地字体/样式/脚本、内联 SVG 决策图表、两快照可比性说明，以及与源 JSON 匹配的 SHA-256。HTML 必须能通过文件系统直接打开，不依赖 CDN、NestJS、数据库或 Next.js 客户端运行时。
