# 财务数据获取与交叉验证规范 v2（优化提案）

> **状态：已于 2026-08-08 采纳并合并，本文件转为评估记录，不再是规范正文。**
>
> 正文已合并进唯一正文 **`docs/model/financial-data.md`**；`AGENTS.md`、`docs/research/workflow/01-data-collection.md` 已同步；A 股取数工具 `docs/research/tools/cnstock_data.py` 已落地并把数据陷阱固化进代码。**要查现行规范请读 `docs/model/financial-data.md`，不要读本文件**——本文件保留的价值在于实测原始结果与评估推理过程（§8 的接口可用性实测表、为什么否掉 improve_advice 的港股 FMP 建议）。
>
> 合并后正文新增了一条本文件没有的陷阱：**报表接口的 `start_date`/`end_date` 过滤的是公告日期而非报告期**（写 `cnstock_data.py` 时实测发现，按报告期精确取数须改用 `period` 参数）。
>
> 文中多处引用的 `improve_advice.md` 是本次评估的**输入提案**，已于采纳后从仓库移除，不再存在——引用保留是为了说明"哪些建议被采纳、哪些被实测否掉"的推理链，不必去找该文件。
>
> 以下为采纳前的评估原文，除本状态说明外未改动。

本文件解决的问题：第 1 步数据采集阶段存在的重复检索——同一份财报被按字段反复取数、每个数据点无差别要求双源、来源优先级偏向网页解析而非结构化 API。评估方法：通读现有 `01-data-collection.md`/`financial-data.md`/`financial_rigor.py`，并**实测**已配置的 FMP MCP 工具与 Tushare token 的真实可用范围（结果见 §8，与 `improve_advice.md` 的假设不完全一致）。

---

## 0. 评估结论摘要

1. **采集阶段确有冗余，问题成立**：10 个采集维度里，「收入结构」「财务指标」都需要利润表数据，「当前估值」需要资产负债表/现金流数据算 PE/PS/FCF Yield——如果按字段逐个取数（而不是整表取一次复用），同一张利润表会被访问多次；且现行规则「每个关键数据两个独立来源」对 CEO 履历、企业文化这类定性事实同样成立，成本过高、也没必要。
2. **`improve_advice.md` 的 FMP 建议只对美股成立，港股不成立**（实测，非假设）：当前 FMP 订阅层级下 `statements`、`quote`、`company.market-cap` 端点对港股（`0700.HK`）**全部 ACCESS DENIED**，只有 `company.profile-symbol` 可用；同样端点对美股（`AAPL`）全部可用。照抄建议把 FMP 定为港股 Primary 会直接报错。
3. **A 股发生质变（2026-08-08 实测）**：Tushare 2120+ 积分下 `income` / `balancesheet` / `cashflow` / `fina_indicator` / `fina_mainbz` / `top10_holders` / `forecast` 等**全部开放**，A 股从"网页解析为主"变成"结构化 API 为主"，是本轮冗余优化里收益最大的一块——分部收入（`fina_mainbz`）、财务指标（`fina_indicator`，含 gross_margin/ROE/ROIC/fcff）、股东与高管薪酬（`top10_holders`/`stk_rewards`）过去都要靠翻年报 PDF 或解析东方财富页面，现在一次 API 调用即可。**但新增了三个会致错的数据陷阱，见 §6。**
4. **P0 级建议（分级交叉验证 + 整表获取 + 结构化 API 优先）价值明确、可以采纳**；P1 里的「Data Ownership / 分析阶段禁止重新采集」已在上一轮优化落进 `02-multi-dimension-analysis.md`（`evidenceRequest`/`evidenceAppendix` 机制）与 `03-analysis-summary.md`，本文件不重复定义；「缓存策略」按"同一次采集任务内不重复请求"的轻量原则处理，不新建持久化缓存系统（`tmp/` 按 `AGENTS.md` 是一次性中间产物，不适合做跨次运行的缓存层）；误差公式（`improve_advice.md` 第 9 条）**已经是中位数法**（见 `financial_rigor.py` `cross_validate()`），无需改动。

---

## 1. 数据源优先级

### 美股（PDD、腾讯ADR、网易ADR等）

| 优先级 | 来源 | 获取方式 | 覆盖 |
| -------- | ------ | --------- | ------ |
| 1（主） | **FMP**（`mcp__fmp__statements` / `quote` / `company`） | MCP 工具，结构化 JSON，无需解析网页 | 三大报表、实时报价、市值、高管、分析师预期、DCF |
| 2（副，交叉验证用） | **stockanalysis** | stockanalysis.com/stocks/{ticker}/financials | 与 FMP 独立的第二来源 |
| 3（副） | **macrotrends** | macrotrends.net/stocks/charts/{ticker} | 前两者都取不到时补充 |
| 原始一手 | SEC EDGAR | sec.gov，或 `mcp__fmp__secFilings` | 10-K / 10-Q 原文 |

某字段在 FMP 侧 ACCESS DENIED 或缺失时，直接降级 stockanalysis，不重试同一端点。

### A股（贵州茅台、三七互娱、吉比特等）—— **本次重写**

| 优先级 | 来源 | 获取方式 | 覆盖 |
| -------- | ------ | --------- | ------ |
| 1（主） | **Tushare Pro** | HTTP POST，token 读 `TUSHARE_TOKEN`（调用形态见 v1，不变） | **三大报表 + 财务指标 + 分部收入 + 行情估值 + 股东/高管/分红/复权**——见 §8 实测清单 |
| 2（副，交叉验证用） | **东方财富** | eastmoney.com | Level 1 数据点的第二来源；Tushare 未覆盖的字段 |
| 原始一手 | **巨潮资讯** | cninfo.com.cn | 原始年报/季报 PDF；口径存疑或 >5% 差异时回查 |

**与 v1 的根本差异**：v1 写「Tushare 的定位：行情与估值的程序化双源，**不是报表来源**」——该结论基于旧 token 的 40203 无权限，**已随积分升级失效**。现在 A 股主路径是 Tushare 结构化取数，东方财富从"主来源"降为"交叉验证副来源"，网页解析次数大幅下降。

对应到 `financial-model.md` 的 10 个维度，Tushare 现在可直接覆盖：

| 采集维度 | Tushare 接口 |
| --------- | ------------- |
| 1 收入结构（分部） | `fina_mainbz`（`type=P` 按产品 / `type=D` 按地区）+ `income` |
| 2 财务指标（近5年） | `income` / `balancesheet` / `cashflow` / `fina_indicator` |
| 6 管理层（持股、薪酬） | `top10_holders`、`stk_rewards`、`pledge_stat`、`share_float` |
| 9 当前估值 | `daily_basic`（pe/pe_ttm/pb/ps_ttm/dv_ttm/total_mv/total_share）、`daily`、`adj_factor` |
| 补充 | `forecast`/`express`（业绩预告快报）、`stk_holdernumber`（股东户数）、`disclosure_date`（披露日历）、`repurchase`（回购）、`cn_gdp`（宏观） |

维度 3（竞争格局）、4（商业模式）、5（技术能力）、7（行业前景 TAM）、8（风险）、10（多空论点）仍需网络检索，Tushare 不覆盖。

### 港股（腾讯0700、网易9999、美团3690等）

| 优先级 | 来源 | 获取方式 | 覆盖 |
| -------- | ------ | --------- | ------ |
| 1（主） | **aastocks** | aastocks.com/tc/stocks/analysis/company-fundamental | 财务报表、估值 |
| 2（副） | **macrotrends**（ADR 代码，腾讯 TCEHY、网易 NTES） | 直接访问 | 交叉验证 |
| 补充（行情） | **Tushare `hk_daily`** | 实测可用，**频次 1 次/分钟**（硬限，实测撞到） | 港股日线行情；一次取回整段区间，不要逐日循环 |
| 补充（概况） | **FMP `company.profile-symbol`** | MCP 工具，实测港股可用 | 公司概况、市值快照、行业分类——不能替代报表双源 |
| 原始一手 | HKEX 披露易 | hkexnews.hk | 年报 PDF |

**港股仍是四个市场里结构化程度最低的**：FMP 的报表端点被订阅层级挡住，Tushare 的 `hk_income`/`hk_daily_adj` 无权限（实测），所以港股财务报表**只能**继续走 aastocks/macrotrends 网页源 + HKEX 年报。能省下的只有行情与公司概况两块。

### 台股（台积电2330、联发科2454等）—— 与 v1 一致，不改动

| 优先级 | 来源 | 获取方式 |
| -------- | ------ | --------- |
| 1（主） | **FinMind API** | `docs/research/tools/twstock_data.py` |
| 2（副） | **Goodinfo** | goodinfo.tw |
| 原始一手 | 公开资讯观测站（MOPS） | mops.twse.com.tw |

台股月营收、复权、ADR 换算（1 TSM ADR = 5 股 2330）等规则完整沿用 v1。

---

## 2. 获取策略：Cache → Primary → Reference → Official

默认只访问 **Primary**；**Reference** 仅在两种情况触发：① 做 §5 要求的分级交叉验证；② Primary 缺失或访问失败需降级。**Official**（原始财报/交易所披露）只在交叉验证出现 >5% 重大差异，或 Level 1 数据点需最终核实时访问——不默认访问全部来源。

v1 隐含的执行方式是「对每个关键数据都同时访问主副来源」，v2 改成「先访问主来源，副来源按需触发」，配合 §5 分级验证，双源访问只发生在真正需要双源的数据点上。

---

## 3. 单次采集原则（限定在第 1 步内）

> 同一家公司、同一报告期、同一来源的同一份报表，在第 1 步采集过程中只请求一次；10 个采集维度里凡依赖同一份利润表/资产负债表/现金流量表的字段，全部复用同一次取数结果。

例：维度 1（收入结构）与维度 2（财务指标）都需要利润表——A 股先调一次 `income`（一次带 `start_date`/`end_date` 取回近 5 年全部报告期），维度 1 从中取收入与增速、维度 2 取收入/净利润/利润率，**不为两个维度分别请求两次**。维度 9 需要的市值/股本，与验证市值用的股本、维度 6 持股比例用的总股本，是同一个数字、取一次。

分析阶段（第 2 步）的数据所有权已由 `02-multi-dimension-analysis.md`（默认禁网、只读 `financials-collection.json`、`evidenceRequest`/`evidenceAppendix`）落地，本文件不重复定义。

---

## 4. 按报表整表获取（Statement-First），不按字段获取

**错误模式**：为 Revenue 调一次接口，为 Gross Margin 再调一次，为 Net Income 再调一次——同一张表被访问 3 次。

**正确模式**：一次取回整份报表（含整段时间序列），再从结果里拆字段。

美股（FMP，三次调用覆盖财务指标类大部分字段）：

```
statements(endpoint="income-statement",  symbol, period, limit=5)  → revenue/grossProfit/operatingIncome/netIncome/eps
statements(endpoint="cashflow-statement", symbol, period, limit=5) → operatingCashFlow/capitalExpenditure/freeCashFlow
statements(endpoint="balance-sheet-statement", symbol, period, limit=5) → cash/totalDebt/totalAssets/totalStockholdersEquity
```

A 股（Tushare，同样是「一次调用取回整段区间」，**不要按年循环**）：

```python
income      = tushare("income",       {"ts_code": ts, "start_date": "20200101", "end_date": "20251231", "report_type": "1"})
balance     = tushare("balancesheet", {"ts_code": ts, "start_date": "20200101", "end_date": "20251231", "report_type": "1"})
cash        = tushare("cashflow",     {"ts_code": ts, "start_date": "20200101", "end_date": "20251231", "report_type": "1"})
indicator   = tushare("fina_indicator", {"ts_code": ts, "start_date": "20200101", "end_date": "20251231"})
segments    = tushare("fina_mainbz",  {"ts_code": ts, "period": "20241231", "type": "P"})
valuation   = tushare("daily_basic",  {"ts_code": ts, "start_date": "20260101", "end_date": "20260808"})
```

港股/A股走网页源时同理："一次页面访问把当期三张表全部截取下来"，不为不同字段重复访问同一页面。

---

## 5. Metadata 校验闸门与分级交叉验证

### 5.1 Metadata 闸门（比较数值前先核对口径）

计算误差率之前，先核对两来源的：**报告期、货币单位、金额单位（元/万元/亿元）、会计准则（GAAP/Non-GAAP）、合并口径（是否含少数股东权益）、原始值/追溯调整值**。

- 六项任一不一致 → 直接标 `"口径不可比"`（`Data Not Comparable`），写明不一致项，**不计算误差率**、不套 1%/5% 阈值——不同口径算出的"误差"没有意义，反而误导；
- 六项一致 → 才进入误差计算。

v1 只把 GAAP/Non-GAAP、汇率、财年定义列为"误差的可能原因"做事后解释；v2 改成事前闸门：先判可比性，可比才算误差。

**A 股特别注意**：`income` 的 `n_income`（净利润，含少数股东损益）与 `n_income_attr_p`（归母净利润）是两个不同口径——与东方财富对比时，东方财富默认展示的是**归母净利润**，用 `n_income` 去对会产生虚假偏差。同理 `total_revenue`（营业总收入）≠ `revenue`（营业收入），银行保险类公司两者差异显著。

### 5.2 分级交叉验证

**不是所有字段都要双源**，按数据对结论的杠杆分三级：

**Level 1（必须双源，误差超阈值必须回原始财报核实）**：Revenue、Net Income、Free Cash Flow、Shares Outstanding、Market Cap、Cash、Debt

与 `01-data-collection.md`「程序化交叉验证」现有必验清单（总股本、股价与市值、最近财年收入与净利润、现金储备/净现金、管理层持股比例）基本对应，是已有共识的强化。

**Level 2（建议双源；预算紧张时允许单源，但须在该字段旁注明"仅单源"）**：Gross Margin、Operating Margin、ROE、ROIC、PEG

**Level 3（单源即可，不做交叉验证）**：CEO Background、Company History、Technology Stack、Business Model 描述、企业文化

对应维度 4/5/6 里的定性叙述——找到一个可靠来源即可，不为"再验证一次"重复检索。

> 这条使「每个关键数据必须两个独立来源」不再对 Level 3 成立。**采纳本文件需同步放宽 `AGENTS.md` 对应表述**（见 §10），否则两份文档字面冲突。

---

## 6. Tushare 数据陷阱（实测发现，会直接导致数字错误）

这三条是本次实测新发现的，v1 没有记录，**采集 A 股时必须处理**：

### 6.1 同一报告期返回重复行 → 必须去重

`income`/`balancesheet`/`cashflow` 即使已指定 `report_type=1`，同一个 `end_date` 仍可能返回 2 行，区别在 `update_flag`（`0` = 原始披露，`1` = 更新/调整后）。实测 600519 的 2018–2020 年报每期各返回 2 行。

**去重规则**：按 `end_date` 分组，**同组内优先取 `update_flag='1'`，没有才取 `'0'`**；若两行数值不同，说明发生过追溯调整，取调整后（`update_flag='1'`）并在 `note` 里注明。不去重会导致"近 5 年"序列出现重复年份，进而把增速、CAGR 全部算错。

### 6.2 `report_type` 混杂多种报表口径 → 必须显式过滤

不传 `report_type` 时，返回值混合了合并报表、母公司报表、调整后报表等多种口径（实测 600519 近 5 年返回 33 行）。**采集一律显式传 `report_type="1"`（合并报表）**，与年报口径一致；需要母公司口径时单独取并标注。

### 6.3 `fina_mainbz` 混入合计行 → 不能直接求和

分部数据里混有合计与调整行：`type=P` 返回中 `bz_item='产品'` 是全部产品合计、`'合计特别调整'` 是调整项；`type=D` 返回中 `bz_item='地区'` 是合计。实测 600519 的 `type=P` 五行里，`'产品'`(1741.4亿) = 全公司总收入，而 `'茅台酒'`(1459.3亿) + `'其他系列酒'`(246.8亿) 才是真实分部。

**处理规则**：剔除 `bz_item` 为 `'产品'`/`'地区'`/`'合计特别调整'`/`'其他业务'` 之外的实际分部项参与占比计算；用剔除后各分部之和与 `income.total_revenue` 交叉核对，对不上说明漏了分部或口径不一致，不要强行凑百分比。

---

## 7. 误差计算：沿用现状，无需改动

`improve_advice.md` 第 9 条建议误差公式改成对称式 `|A-B| / ((A+B)/2)`，理由是"避免默认认为来源1一定正确"。**本仓库已满足**：`financial_rigor.py` 的 `cross_validate()` 用**多来源中位数**作参照（`dev = abs(val - median) / median`），本来就不以来源1为基准。v1 文档里 `|来源1-来源2|/来源1` 只是双源场景的简化表述，工具实际行为已是对称的——**不改工具，只把文档表述与工具行为对齐**。

---

## 8. 数据源实测结果（2026-08-08）

以下为本次评估的真实调用结果，**权威于 `improve_advice.md` 与 v1 中未经复测的表述**。

### 8.1 Tushare（token 2120+ 积分）

| 接口 | 状态 | 用途 |
| ------ | ------ | ------ |
| `income` / `balancesheet` / `cashflow` | ✅ **已开放**（85/152/97 字段） | 三大报表——v1 记录的 40203 无权限已失效 |
| `fina_indicator` | ✅ 已开放（108 字段） | 财务指标：gross_margin、ROE、ROIC、ebitda、fcff/fcfe、周转率等 |
| `fina_mainbz` | ✅ 已开放 | 分部主营（`type=P` 产品 / `type=D` 地区）——注意 §6.3 合计行 |
| `top10_holders` / `stk_rewards` / `pledge_stat` / `share_float` | ✅ 已开放 | 十大股东、高管薪酬与持股、股权质押、限售解禁 |
| `forecast` / `express` | ✅ 已开放 | 业绩预告 / 快报（`express` 部分标的无数据属正常） |
| `stk_holdernumber` / `disclosure_date` / `repurchase` / `moneyflow` | ✅ 已开放 | 股东户数、披露日历、回购、资金流向 |
| `daily` / `daily_basic` / `adj_factor` / `dividend` / `stock_basic` | ✅ 已开放，**频次限制已放宽** | 实测连续 5 次快速调用 `daily_basic`、`adj_factor` 均成功——v1 记录的「1 次/分钟」「1 次/小时」已失效 |
| `index_dailybasic` / `index_member_all` / `cn_gdp` | ✅ 已开放 | 指数估值、申万行业分类、宏观 |
| `hk_daily` | ✅ 可用，**1 次/分钟**（实测撞限） | 港股日线行情 |
| `hk_basic` / `us_basic` | ✅ 可用 | 港股/美股标的列表（仅基础信息） |
| `hk_income` / `hk_daily_adj` / `hk_mins` | ❌ 无权限 | 港股财报仍走网页源 |
| `us_daily` | ❌ 无权限 | 美股行情走 FMP |
| `bak_basic` / `balancesheet_vip` | ❌ 无权限 | VIP 专用接口 |

> 频次虽已放宽，**§4 的「一次取回整段时间序列、不按年/按日循环」仍然有效**——那是为减少冗余请求，不只是为了绕开限流。

### 8.2 FMP（当前订阅层级）

| 端点 | 美股（AAPL） | 港股（0700.HK） |
| ------ | -------------- | ------------------ |
| `quote.quote` | ✅ 可用 | ❌ ACCESS DENIED |
| `statements.income-statement` | ✅ 整表返回 revenue/grossProfit/operatingIncome/netIncome/eps 等 | ❌ ACCESS DENIED |
| `statements.balance-sheet-statement` | ✅ 整表返回 cash/totalDebt/totalAssets/totalStockholdersEquity 等 | 未测（大概率同受限） |
| `company.profile-symbol` | 未专测 | ✅ 可用（价格/市值/行业/高管/员工数） |
| `company.market-cap` | 未测 | ❌ ACCESS DENIED |

**结论**：美股 FMP 作 Primary 可靠；港股只能用 FMP 概况作补充，核心财务仍依赖网页源。若后续升级 FMP 订阅，重跑此表再决定是否把港股切到 FMP。

---

## 9. 预期收益（按市场）

| 市场 | v1 主路径 | v2 主路径 | 冗余下降 |
| ------ | ---------- | ---------- | --------- |
| A股 | 东方财富网页解析（多页）+ 巨潮 PDF + Tushare 仅行情 | Tushare 结构化 API 6 次左右取全（报表/指标/分部/估值/股东） | **最大**——分部、财务指标、高管薪酬从"翻 PDF"变成一次调用 |
| 美股 | macrotrends + stockanalysis 双网页解析 | FMP 三次 statements 调用 + stockanalysis 仅验 Level 1 | 大 |
| 港股 | aastocks + macrotrends 双网页 | 同 v1，仅行情/概况改走 API | 小 |
| 台股 | FinMind 工具 | 同 v1，不变 | 无变化（本来就是 API） |

叠加 §5.2 分级验证（Level 3 定性字段不再要求双源）后，一次完整采集的网络请求数应有明显下降——但**具体数字需要下一次真实研究跑完才能确认，本文件不预设百分比**。

---

## 10. 与现有文档的关系 / 采纳所需的后续改动

本文件目前**不生效**，只是评估产出与草案。若决定采纳，需按顺序做：

1. **`docs/model/financial-data.md`（v1）的 Tushare 一节必须改**——这是最紧急的一项：v1 明确写着「Tushare 的定位：行情与估值的程序化双源，不是报表来源」以及「`income`/`balancesheet`/`cashflow` ❌ 40203 无权限」「`daily_basic` 1 次/分钟」「`adj_factor` 1 次/小时」，这些**在升级后全部是错的**。即使不采纳 v2 的其余部分，这一节也应该按 §8.1 更新，否则 Agent 会继续绕开可用的接口去解析网页；
2. `docs/research/workflow/01-data-collection.md` 第 2 节的数据源表格改为指向本文件（或把本文件合并回 `financial-data.md` 并保留 v1 历史版本）；
3. `AGENTS.md` 「每个关键数据两个独立来源，误差 >1% 标记，>5% 必须回原始财报」改为对 Level 1/2 的限定表述，否则与 §5.2 字面冲突；
4. **§6 的三个 Tushare 陷阱建议同时固化进取数代码**——若后续把 A 股取数写成 `docs/research/tools/` 下的脚本（类似台股的 `twstock_data.py`），去重、`report_type` 过滤、分部合计行剔除应由脚本处理，不依赖 Agent 每次记得手工做；
5. 不需要改 `02-multi-dimension-analysis.md`/`03-analysis-summary.md`——"分析阶段禁止重新采集"已通过 `evidenceRequest`/`evidenceAppendix` 落地，本文件只在第 1 步源头做对应优化，职责边界不重叠；
6. `docs/research/tools/financial_rigor.py` 不需要改动（见 §7）；
7. 建议先在下一次 A 股研究里试跑（A 股是本轮变化最大的市场），确认 Tushare 取数与 §6 陷阱处理无误后，再正式替换 v1 成为唯一正文。
