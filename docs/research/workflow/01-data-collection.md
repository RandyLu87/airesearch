# 数据采集（研究流程第 1 步）

本文件是 `docs/research/public-company-financial-research.md` 第 1 步的唯一正文：一步完成研究上下文、双源取数与程序化交叉验证。两份文件是本步骤的唯一依据：

- **数据源规范**：`docs/model/financial-data.md` —— 每个关键数据必须来自两个独立来源，误差 >1% 须标记。
- **采集清单**：`docs/model/financial-model.md` —— 只采集其中 10 个维度，不多不少。

## 1. 建立研究上下文

1. 先运行 `date` 确认今天日期，以 Asia/Shanghai 定数据截止时间，不凭训练数据假设「最新」。
2. 明确公司、代码、交易所、报告币种、会计准则。
3. 搜索 `research/companies/`；已有记录时先读最近一次研究产出作为可比基线。按仓库 `AGENTS.md` 确定公司目录命名；同一公司同一天只维护一份产出，不新建第二份。

## 2. 按市场选定来源

按 `docs/model/financial-data.md` 的优先级取数，策略是 **Cache → Primary → Reference → Official**：默认只访问 Primary，Reference 仅用于分级交叉验证或 Primary 失败时降级，Official 只在 >5% 重大差异或 Level 1 数据点需最终核实时访问——**不默认访问全部来源**。

| 市场 | Primary（主） | Reference（副，交叉验证用） | Official（原始一手） |
|------|--------------|---------------------------|---------------------|
| 美股 | **FMP**（`mcp__fmp__statements` / `quote` / `company`） | stockanalysis → macrotrends | SEC EDGAR（10-K / 10-Q） |
| A股 | **Tushare**（用 `docs/research/tools/cnstock_data.py`，报表/指标/分部/估值/股东全覆盖） | 东方财富 | 巨潮资讯年报 / 季报 PDF |
| 港股 | aastocks | macrotrends（ADR 代码）；行情可用 Tushare `hk_daily`（1 次/分钟），概况可用 FMP profile | HKEX 披露易年报 PDF |
| 台股 | FinMind（`docs/research/tools/twstock_data.py`） | Goodinfo | 公开资讯观测站 MOPS |

**两条减少冗余请求的硬要求**：

1. **单次采集**——同一公司、同一报告期、同一来源的同一份报表只请求一次，10 个维度共用同一次取数结果（如维度 1 收入结构与维度 2 财务指标共用一次利润表），不为不同维度重复调用；
2. **整表获取**——一次取回整份报表与整段时间序列，再从结果里拆字段，不为 Revenue / Gross Margin / Net Income 分别调三次接口。

误差处理规则、分级交叉验证（Level 1/2/3）、Metadata 校验闸门、Tushare 的四个数据陷阱（重复行去重、`report_type` 过滤、日期参数是公告日期、分部合计行剔除）、未上市公司 `[估计]` 标记、历史序列前复权要求，全部以该规范正文为准，不在此复述。

## 3. 采集十个维度：结构化的自己取，定性的交给 Agent

`docs/model/financial-model.md` 的十个维度分成两类，**不要打包给同一个 Agent**：一类由确定性命令直接返回（几秒钟、无需判断、答案唯一），另一类需要检索与取舍。混在一起的代价是 Agent 要在自己的上下文里重新摸索取数命令，跑得慢、易被打断，且中途失败时磁盘上什么都没有。

### 3.1 结构化维度：主会话直接取数，立即落盘

维度 **1（收入结构）、2（财务指标）、9（当前估值）**，以及 **6（管理层）的持股与薪酬部分**，由主会话自己调工具取得：

| 市场 | 命令 / 工具 |
| ------ | ------------ |
| A股 | `python3 docs/research/tools/cnstock_data.py {quote,valuation,financials,segments,holders} <6位代码>` |
| 台股 | `python3 docs/research/tools/twstock_data.py {quote,valuation,financials,revenue,dividend} <代码>` |
| 美股 | `mcp__fmp__statements`（income / cashflow / balance-sheet，`period=annual, limit=5`）+ `mcp__fmp__quote` |
| 港股 | aastocks 公司基本面页（一次访问截取三张表）+ Tushare `hk_daily` 行情 |

取到后**立刻**按第 5 节把 `financials-collection.json` 写出来：`meta` 与这几个维度填实值，其余维度先留 `__TODO__`。这份半成品是流程的存档点——后面任何一步被打断都从它继续，不用重跑取数。

### 3.2 定性维度：启动后台 Agent 检索

维度 **3（竞争格局）、4（商业模式与护城河）、5（技术能力）、6 的履历与关键决策、7（行业前景 TAM）、8（风险因素）、10（多空论点）** 需要网络检索与判断，**使用 Task 工具启动后台 Agent** 完成（Codex 端用可用的子代理能力等价执行）。

给 Agent 的指令必须包含：第 1 节确定的数据截止时间、第 2 节的主副来源要求、**已落盘的结构化数据**（避免它重复取数），以及「每个数据点须返回数值、来源名称、URL 与所属报告期，无出处的数字不接受」。

**启动后在同一回合内等它返回**（总纲第 0 节纪律 2），把结果合并进已落盘的文件，再进入第 4 节。后台 Agent 只负责检索与出处记录；交叉验证（第 4 节）与落盘（第 5 节）一律在主会话完成。

## 4. 程序化交叉验证

采集完成后**必须调用 `docs/research/tools/financial_rigor.py` 对关键数据做程序化验证，禁止 LLM 心算**。必验数据点：总股本、当前股价与市值、最近财年收入与净利润、现金储备/净现金、管理层持股比例（区分经济权益与投票权）。

```bash
# 市值验算（精确十进制）：股价 × 总股本 与报告市值对比，防单位/币种错误
python3 docs/research/tools/financial_rigor.py verify-market-cap \
  --price {股价} --shares {总股本} --reported {报告市值} --currency {币种}

# 关键数据多源交叉验证（收入、净利润、现金储备分别执行）
python3 docs/research/tools/financial_rigor.py cross-validate \
  --field {字段名} --values '{"来源1": 数值, "来源2": 数值}' --unit {单位}

# 估值指标精确验算（PE / PB / ROE / FCF Yield 等）
python3 docs/research/tools/financial_rigor.py verify-valuation \
  --price {股价} --eps {EPS} --bvps {每股净资产} --fcf-per-share {每股FCF} --dividend {每股股息}
```

**验证规则**：

1. **按等级定双源要求**（完整定义见 `docs/model/financial-data.md`「分级交叉验证」）：Level 1（收入、净利润、自由现金流、总股本、市值、现金、负债）必须 2 个独立来源；Level 2（毛利率、经营利润率、ROE、ROIC、PEG）建议双源，仅单源时在该字段注明「仅单源」；Level 3（CEO 履历、公司沿革、技术栈、商业模式描述、企业文化）单源即可，不做交叉验证；
2. **比较数值前先过 Metadata 闸门**：核对报告期、币种、金额单位、会计准则、合并口径、是否追溯调整；任一不一致直接记「口径不可比」并写明差异项，**不计算误差率**；
3. 发现来源间有差异时，优先采用公司年报/交易所数据，并注明差异原因；
4. 所有涉及计算的数据必须通过工具验算，禁止 LLM 心算；
5. 工具输出结果直接嵌入采集产出的 `crossValidationLog`（即报告附录「关键数据交叉验证记录」）；
6. 如果工具报告 ❌ 偏差过大，必须排查原因后才能继续分析。

**常见错误防范**：

- 市值单位：港币亿 vs 人民币亿 vs 美元亿，容易漏写/多写一个零；
- FCF 口径：不同来源对资本支出的定义可能不同（是否含租赁、收购等）；
- 债务口径：是否包含经营租赁负债；
- 持股比例：AB 股公司的经济权益 ≠ 投票权。

## 5. 落盘

按 `docs/model/financials—model-template.json` 的结构生成公司数据文件，落盘为 `research/companies/<company-id>/financials-collection.json`（文件名固定，渲染层按名发现）。

**分两次写，不要攒到最后一次性落盘**：第 3.1 节取到结构化数据后先写一版（结构化维度填实、其余留 `__TODO__`），第 3.2 节 Agent 返回并完成第 4 节验算后再补齐同一个文件。目录由 Write 自动创建，**不要 `mkdir` 预创建**（总纲第 0 节纪律 1）。

- 关键数值一律用模板定义的校验对象（value + 双源 + 偏差 + flag）；
- 待填写 `__TODO__`；取不到的字段不删除，写 `status: "unavailable"` 与缺失原因、已查范围；
- 每条工具验证输出记入 `crossValidationLog`。

## 完成标准

10 个维度均为「已取得」或「缺失原因 + 已查范围 + 分析影响」；关键数值都有双源记录与误差标记；市值通过 `verify-market-cap` 验算；数据截止时间已声明。
