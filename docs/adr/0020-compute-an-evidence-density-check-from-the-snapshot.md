# 证据密度体检从快照自身计算，作者必须逐条回应

## 状态

已接受，2026-08-05。实现排期见 GitHub Issue。

## 背景

契约要求完整性。`analysis-template.md:55` 强制 `summary` 一眼回答当前立场、确信度、合理价值区间与安全边际；`valuation.scenarios` 强制恰好三个情景。这些要求是对的——它们防的是研究做一半就交差。

字段层面对缺失的处理已经很干净：

- `status: "unavailable"` + `reason`，禁止用 0 伪装缺失（`analysis-template.md:87`）；
- `marketPosition` 取不到数据仍要给出该口径并写 reason（`index.ts:290-311`）；
- `methodSelection.blockedBy` 把估值缺口变成一条有行动项的记录（`valuation-playbook.md:85`）。

**但整份研究层面没有任何机制回答：这次的证据密度是否支撑得起一个立场。** 一份 60% 驱动指标 `unavailable`、evidence 里多数是 `inference` 的快照，与一份全部 `reported` 的快照，在报告页上的呈现方式完全相同——都给出一个立场、一个确信度、一个价值区间。

而契约施加的压力是单向的：schema 要求填满，`inference` 是唯一总能填满的东西。

原料其实是齐备的。`evidenceSchema.kind` 已经提供 `fact` / `calculation` / `inference` 三分（`index.ts:117`），`driverMetricSchema.confidence` 已经提供高/中/低三档（`index.ts:93`），各处 `status` 已经提供 `unavailable`。只是没有人统计——读者要自己在几十个字段里数。

对照参考实现（`ai-berkshire/skills/investment-research.md:13-33`、`:207-209`）：人工给公司打 A/B/C 信息丰富度评级，报告开头加「AI 研究局限性声明」，结尾区分「AI 分析置信度」与「投资确定性」。它指出的问题是真的，手段有两个毛病——字母等级不可校验；而写一段免责声明的成本远低于补一个数据的成本，所以它会稳定地被用来替代补数据。

## 决策

新增一组从快照自身计算的证据密度规则，与 `valuation/rules.ts` 的 `HEALTH_RULES` 同构：纯谓词、输入是一份一次性派生的扁平事实、`null` 表示「无法判断」而非「通过」（`rules.ts:4-13` 已经把这个约定写清楚了）。

派生事实至少包括：

| 事实 | 含义 |
| --- | --- |
| `unavailableShare` | `standardMetrics` + `driverMetrics` + `marketPosition.measures` 中 `status: "unavailable"` 的占比 |
| `inferenceShare` | `evidence` 中 `kind: "inference"` 的占比 |
| `lowConfidenceDriverShare` | `driverMetrics` 中 `confidence: "低"` 的占比 |
| `unsupportedDriverShare` | 所引用 evidence 全部为 `inference` 的驱动占比 |
| `idealMethodBlocked` | `methodSelection.ideal !== adoptedPrimary` |

`unsupportedDriverShare` 是这组里最硬的一条：一个没有任何 `fact` 或 `calculation` 支撑的驱动指标，是在用推断解释推断。

触发的规则作者必须逐条回应，回应形式复用 `healthCheckResponseSchema` 的四值（`adopted` / `blocked` / `rejected` / `acknowledged`），并在报告页与公司研究主页标出。统计结果由引擎写回、作者不得手写——与 `impliedExpectation`、`computed` 同一原则，`index.ts:791` 的重算比对是现成的实现先例。

**关键约束：回应不能是免责声明。** `blocked` 必须像 `methodSelection.blockedBy` 那样列出——缺的是哪一个数、它为什么能提高密度、去哪份文件的哪一部分取。这是本 ADR 全部的价值：让「证据不足」成为一条有行动项的记录，而不是一句挡在结论前面的话。

**明确不做的三件事。**

不引入人工 A/B/C 评级字段。体感等级不可校验，而它想表达的东西可以算。

**不因密度不足阻断发布。** 有些公司（新上市、冷门市场、披露稀薄的行业）的证据密度就是低的，那是事实不是错误。阻断只会诱导作者把 `unavailable` 改成一条 `inference` 来通过校验——把一个诚实的缺失换成一个不诚实的填充，正好是这条规则要防的行为。规则的作用是标出来，不是拦住。

不采用「AI 研究置信度」这类命名。快照不区分作者是人还是模型；要区分的是证据类型，而 `evidence.kind` 已经在区分。

## 备选方案

**手填 A/B/C 评级加一段免责声明。** 与参考实现一致，成本最低。否决原因：不可校验，且成本倒置——写声明比补数据便宜，于是声明会替代数据。

**只在 `summary` 加一个手写字段，说明哪些结论建立在有限信息上。** 不动引擎。否决原因：它依赖作者自觉，而自觉恰恰是证据稀缺时最先失效的东西。没有阈值就没有触发，这个字段会长期写着「无」。

**密度不足直接阻断发布。** 约束最强。否决原因见上：它把作者推向把缺失伪装成推断。校验器能检查的是形式，而这里要保护的是诚实——用阻断去逼诚实会得到反面结果。

**不做，靠现有的 per-driver `confidence` 与 `blockedBy`。** 零成本。否决原因：两者都是字段级的，读者要自己在几十个字段里统计。统计是机器该做的事，而所有原料都已经在快照里。

## 后果

- 报告页新增一处证据密度呈现，与估值方法体检并列。证据稀薄不再是只有翻遍全部字段才能发现的事。
- 每份快照多一段回应，长度与触发规则数成正比。密度高的研究几乎不触发，不增加负担；密度低的研究负担变重——这个方向是对的。
- 阈值第一版必然是拍的。规则集与 `HEALTH_RULES` 一样保存在代码里，阈值迭代不需要改这份 ADR。
- 已发布的 1.1.0 快照：统计可以对它们计算（原料都在），但**回应字段可选**——不为几个月前的判断补写当时并未做过的自省，与 ADR-0017 的兼容思路一致。
- 这组规则第一次让「这次研究该不该给出立场」成为一个可以被机器提出、必须被作者回答的问题。它不改变任何结论，只是不允许结论悄悄建立在推断上。
