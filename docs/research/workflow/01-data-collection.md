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

给 Agent 的指令必须包含以下五项，**缺一项就等于没传**——Agent 只看得到你写进 prompt 的内容，读不到本文件：

1. 第 1 节确定的数据截止时间；
2. 第 2 节的主副来源要求；
3. **已落盘的结构化数据**（避免它重复取数）；
4. 「每个数据点须返回数值、来源名称、URL 与所属报告期，无出处的数字不接受」；
5. **检索命令与纪律**——把下面这段原样写进 prompt，不要只写「用 web_search.py」：

   > 检索一律先用 `python3 docs/research/tools/web_search.py "<检索词>"`，需要回一手披露时加 `--official hk|cn|us|tw`，需要核对数字口径与时点时加 `--full`。该工具只返回来源原文片段，**不返回任何结论或摘要**——你写下的每个数字都必须是你从片段或正文里读到的原文数字。命令失败（退出码 3）时降级用 WebSearch 继续，不要因此中断。写 `unavailable` 之前，先用 `--domains <公司IR域名>` 或 `--official <市场>` 确认公司官网与交易所披露里确实没有，不要把「没搜到」写成「未披露」。

**启动后在同一回合内等它返回**（总纲第 0 节纪律 2），把结果合并进已落盘的文件，再进入第 4 节。后台 Agent 只负责检索与出处记录；交叉验证（第 4 节）与落盘（第 5 节）一律在主会话完成。

### 3.3 检索工具：`web_search.py`

```bash
# 默认检索（8 条来源原文片段 + URL）
python3 docs/research/tools/web_search.py "快手 2025Q3 收入 同比增速"

# 回一手披露：hk=披露易 / cn=巨潮+沪深交易所 / us=SEC EDGAR / tw=MOPS
python3 docs/research/tools/web_search.py "理想汽车 2025 车辆毛利率" --official hk

# 限定域名（公司 IR 站、指定数据源）
python3 docs/research/tools/web_search.py "…" --domains ir.kuaishou.com

# 附正文 markdown，供数字回原文核对口径与时点
python3 docs/research/tools/web_search.py "…" --full
```

**三条使用纪律**：

1. **`--official` 用在 Level 1 数据点与 >5% 差异复核上**。实测该参数能把结果直接收敛到 `hkexnews.hk` / `sec.gov` 的报表原文 PDF，比逐层翻页找年报快得多，也正是 `financial-data.md` 里 Official 层的取数方式；
2. **工具只给来源原文，不给结论**。它按设计不返回任何 LLM 摘要——2026-08-09 实测 Tavily 的 `include_answer` 有 21% 的概率编造或错记数字（把「扣非净利润1437.73亿」当成归母净利润、给出来源里根本不存在的行业 CAGR），而同一次返回的原文片段是对的。**带出处外观的假数字比诚实的 `unavailable` 有害得多**，故该开关在脚本里被硬编码关闭，不提供打开的方式；
3. **`--cutoff` 不是截止日闸门**。实测它只在 `--news` 模式下真正过滤（普通检索的结果不带发布日期），工具会在不生效时显式提示。截止日纪律仍由你读原文时点把关，不要因为传了参数就认为已经过滤过。

**取不到时**：换一次关键词重试，仍无结果按 `unavailable + reason` 收敛并写明已查范围，不恋战。**工具本身失败（退出码 3，如 key 缺失或配额耗尽）时降级到原生 WebSearch 继续，不因检索后端不可用中断研究。**

配额：advanced 检索 2 credits/次，免费额度 1000 credits/月，约合 8 家公司的研究量。key 存 `~/.config/tavily/token` 或环境变量 `TAVILY_API_KEY`，**严禁提交进仓库**（与 Tushare token 同规矩）。

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

- **双重上市与双币种（港股高发）**：H 股 + 美股 ADS/ADR 的公司有两个股价、两个市值，报告币种（常为 RMB）又不等于交易币种（HKD）。股价与市值仍是**一个字段**，按模板 `_spec.multiListing` 写成 `{ "primary": <校验对象>, "alt": [<校验对象>] }`，primary 取公司目录前缀对应的主上市地。**不要按上市地或币种拆成自定义键**（`{"hk": …, "us_ads": …}`、`{"hk_hkd": 101219774273}`）——页面认不出这种形状，页头会直接空掉，第 4/5 步的首屏闸门会拒绝放行；
- **亏损公司的 PE 不是缺失，是不适用**：TTM 净利润为负时写 `{ "status": "not-applicable", "reason": "为什么不适用 + 支撑数字" }`，`reason` 第一句先说结论再带括号注释（页头只显示前一小段）。港股新经济公司常年亏损，这条比在美股/A 股上更常撞见；
- 市值单位：港币亿 vs 人民币亿 vs 美元亿，容易漏写/多写一个零；
- **大额数字必须自己写成缩写字符串**：渲染层只加千分位，**不猜量级**（缩写依赖 unit/currency 语境，只有写数据的人知道），裸数字会整串拼进页面。市值、收入、净利润这类百万以上的数值一律写缩写；股价、倍数、百分比保持数字。**货币之外的计数类单位同样算数**——总股本（股）、销量（辆）、用户数（户 / MAU / DAU）、产能，只要标了 `unit` 且过百万就要缩写。第 4 步的写法闸门会按 100 万的阈值挡回来（`[大数字未缩写]`）：
  - ❌ `"reported": { "value": 23051044345, "currency": "HKD" }`（页头渲染成 `23,051,044,345 HKD`，网易云音乐 `hk-9899` 就是这样发出去的）
  - ✅ `"reported": { "value": "230.51亿", "currency": "HKD" }`（美股/英文口径写 `"23.05B"`）
  - ❌ `"sharesOutstanding": { "value": 204716202, "unit": "股" }`、`"tam": { "value": 19000000, "unit": "辆" }`
  - ✅ `"sharesOutstanding": { "value": "2.05亿", "unit": "股" }`、`"tam": { "value": "1900万", "unit": "辆" }`
  - ❌ 只加引号不缩写：`{ "value": "23051044345" }` / `{ "value": "23,051,044,345" }`——渲染层对字符串原样输出，页面上和裸数字一模一样，闸门同样拦
- **「取不到 / 不适用」只写完整占位对象，不写裸字符串**：裸 `"unavailable"` 会被渲染层原样输出（百分比列里拼成 `unavailable%`），校验也会把它当作「已填」——第 4 步的写法闸门专门挡这种（`[裸占位字符串]`）：
  - ❌ `"grossMarginPct": "unavailable"`，`"source2": { "name": "unavailable" }`
  - ✅ `"grossMarginPct": { "status": "unavailable", "reason": "年报未按分部披露毛利率，已查 2025 年报与 2026 中报" }`；确实只有单源时按上文 Level 2 规则在字段里注明「仅单源」，不要用 `unavailable` 占位 `source2`；
- FCF 口径：不同来源对资本支出的定义可能不同（是否含租赁、收购等）；
- 债务口径：是否包含经营租赁负债；
- 持股比例：AB 股公司的经济权益 ≠ 投票权。

## 5. 落盘

按 `docs/model/financials—model-template.json` 的结构生成公司数据文件，落盘为 `research/companies/<company-id>/financials-collection.json`（文件名固定，渲染层按名发现）。

**分两次写，不要攒到最后一次性落盘**：第 3.1 节取到结构化数据后先写一版（结构化维度填实、其余留 `__TODO__`），第 3.2 节 Agent 返回并完成第 4 节验算后再补齐同一个文件。目录由 Write 自动创建，**不要 `mkdir` 预创建**（总纲第 0 节纪律 1）。

- 关键数值一律用模板定义的校验对象（value + 双源 + 偏差 + flag）；
- 待填写 `__TODO__`；取不到的字段不删除，写 `status: "unavailable"` 与缺失原因、已查范围；取到了但算不出来的写 `status: "not-applicable"` 与不适用原因；
- **落盘后先自查首屏四个字段**（`marketCap.reported` / `sharePrice` / `pe` / `meta.dataCutoff`）：它们是页头摘要条与首页卡片直读的位置，形状不对页面就是破折号。跑一次 `data_validator.py check --collection …` 即可看到 `[首屏渲染不出]` 提示；
- 每条工具验证输出记入 `crossValidationLog`。

## 完成标准

10 个维度均为「已取得」或「缺失原因 + 已查范围 + 分析影响」；关键数值都有双源记录与误差标记；市值通过 `verify-market-cap` 验算；数据截止时间已声明；首屏四个字段经 `data_validator.py` 解析通过。
