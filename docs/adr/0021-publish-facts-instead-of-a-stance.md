# 只发布可被财报判定的事实与机制，不发布价格类判断

## 状态

已接受，2026-08-05。取代 ADR-0016 对页头内容的规定；`schemaVersion` 升到 1.2.0。

## 背景

契约把结论层做成了硬约束。`summary.stance`、`summary.confidence`、`summary.marginOfSafety` 全是必填字符串，`valuation.actionZones` 至少三档且每档的 `action` 由作者手写。校验器强制它们存在，`snapshot:new` 把它们写成哨兵，页头第一格就是立场。

于是实际产出长这样。AMD 2026-08-05 快照：

```
stance          生意确认升级，价格不给安全边际：不追价，等回撤或等
                MI450 机架级利润率落到财报里
marginOfSafety  没有安全边际。参考价 518.58 美元较基准中枢 222.6 美元高
                133%……本框架下没有任何一档假设组合能支撑当前价格
actionZones     USD 71.0–103.7  「分批建立基础仓位」
                USD 269.3 以上  「持有观察而非买入……否则按纪律减仓」
```

三个问题，按严重程度排：

**第一，这些字段永远无法被判定。** 仓库的整个机制建立在「下一份财报能说谁对」之上：驱动指标必须带可证伪阈值，护城河必须绑驱动，分歧点必须锚在可观测量上，`driverChanges` 强制交代口径漂移。而「不追价」没有任何一期财报能证伪。ADR-0011 到 ADR-0020 每一条都在加强可判定性，`stance` 却始终免检。

**第二，「没有安全边际」在语义上是「市场错了 133%」。** 但反向估值这一步恰恰承认市场价格编码了信息。同一份快照里既说「市场隐含 dc-segment-margin 站上 35%」（把价格当信息），又说「没有任何假设组合能支撑当前价格」（把价格当错误）。两种立场不能同时成立。

**第三，`fairValue` 与 `actionZones` 的输入本身就是主观的。** `scenarios` 的 name 是写死的 enum `["熊市","基准","牛市"]`，而「基准」= 作者认为最可能。引擎把这组假设算得一丝不差，精度掩盖了输入的来源：算术是可复核的，`metricLow: 900000000` 从哪来的不是。

`summary.strongestEvidence` 与 `summary.largestRisk` 是同一类问题的弱化版：「最强」取决于想论证什么，「最大」取决于持有期。而 `largestRisk` 还是单侧的——第一屏有最大风险，没有对称的上行项。

## 决策

**禁止价格类判断，保留可被财报判定的机制陈述。**

删除：`summary.stance`、`summary.confidence`、`summary.headline`、`summary.fairValue`、`summary.marginOfSafety`、`summary.strongestEvidence`、`summary.largestRisk`、`valuation.actionZones`、`valuation.currentExpectation`。同时禁止「贵 / 便宜 / 合理 / 高估 / 低估 / 提供安全边际 / 该买该卖」这类措辞。

新增：`summary.marketCap`（引擎计算）、`summary.multiplePercentile`（当前倍数的历史分位，强制前复权）。

保留：`driverMetrics[].threshold`、`driverMetrics[].confidence`、`businessModel.moat[].trend`、`constraints[].status`、`summary.businessModelChange`、`risks`、`viewChanges`、`checkpoints`。

线画在**能否被下一份财报判定**上，不画在「主不主观」上。护城河变宽变窄是判断，但它绑着驱动、带着 breaker 的前置信号，下一期可以看；驱动阈值是预测，但财报直接给出答案。价格类判断永远拿不到答案，所以它才是唯一必须走的那一类。

`driverMetrics[].confidence` 保留而 `summary.confidence` 删除，这不是不一致：前者说的是某个观测值的证据强度，后者说的是对一个结论的信心，而那个结论已经不存在了。

## 版本与历史快照

**升到 1.2.0，1.1.0 与 1.0.0 都冻结、不回填、继续渲染、继续被引擎校验。**

六份 1.1.0 快照确实写过「不追价，等回撤」。删掉这些字段是改写已经发布的记录，不是改变接下来发布什么——ADR-0002 把带日期的研究报告定义为不可变记录，ADR-0017 已经为 1.0.0 立过同样的先例。`verifyPriorValuation` 因此保留，`deriveActionZones` 也保留：它们不再服务任何写入路径，但committed 文件与产生它的引擎之间的那道校验必须继续跑，否则几年后一次手改无人发现。

代价是渲染分支从两代变三代。这是刻意的：一个自称冻结却停止校验的代际，等于没有冻结。

## 备选方案

**只改措辞，不动 schema。** 改 `WORKFLOW.md` 要求把 `stance` 写成中性表述。否决原因：字段名本身在索取判断，`marginOfSafety` 的字面意思就是「有还是没有」。而且下一个会话不读 ADR 只读 schema，必填字段会立刻把旧行为召回。

**保留字段但标为可选。** 改动最小。否决原因：可选字段在实践中等于「有时写有时不写」，跨快照对比会时有时无，而 `snapshot:new` 若继续把它们写成哨兵就仍然是事实必填。

**删掉所有评价性字段，只留数值与来源。** 最彻底。否决原因：`confidence`、`moat.trend`、`constraints.status`、`businessModelChange` 全部消失后，快照退化成数据表，跨快照的变化等级、证据密度体检和驱动延续三套机制一起失效——而它们统计的正是判断的质量。用无判断换来的中立会让「这次研究做得多薄」重新变得不可见。

## 后果

- 页头三格变成市值 / 参考价格（带时点）/ 当前倍数历史分位。`.hero-facts` 与 `.company-summary` 改成 auto-fit，因为格数现在随契约变化，固定轨会在裁决消失的地方留一个洞。
- **三格的可复核程度不同，这一点值得说清。** 市值由引擎从快照内的三个数重算并由校验器阻断不符；倍数分位不行——它的输入是一条几千个交易日的价格序列，不在快照里，也不该被塞进快照。它的可复核性来自引用的 evidence 加上 `scripts/research/multiple_percentile.py` 的确定性：schema 强制 `adjustmentBasis === "前复权"`、强制引用价格序列与分母的 evidence，读者据此可以自己重跑同一段算术。声称它「由引擎校验」会是一句假话。
- 反向估值从配角变成估值块唯一的存在理由，并按 ADR-0022 逐组计算。
- 倍数分位引入一个新的取数依赖：它必须建立在前复权序列上，而 A 股与美股行情接口都是不复权。`scripts/research/multiple_percentile.py` 负责统一，schema 强制 `adjustmentBasis === "前复权"`。
- 四家已覆盖公司（网易云音乐、Circle、AMD、贵州茅台）需要各出一份 1.2.0 新快照，才能让新结构有真实样本；在那之前渲染层的 1.2.0 分支只有 fixture 覆盖。
- `docs/research/WORKFLOW.md` 的研究三问改了第三问：从「当前价格是否提供安全边际」改成「当前价格隐含了哪些可判定的假设」。「是否」在索取裁决。
