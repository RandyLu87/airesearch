# 财务数据获取与交叉验证规范

> 本文件于 2026-08-05 自 `ai-berkshire/skills/financial-data.md` 迁移而来，此后以本文件为唯一正文独立维护，不再回读 `ai-berkshire/`。配套工具同步迁移至 `docs/research/tools/`。
>
> **2026-08-08 修订（v2）**：按 `docs/model/data/financial-data_v2.md` 的评估结论重写数据源优先级与验证策略。三项实测驱动的实质变化：① **Tushare token 升级后 A 股三大报表接口全部开放**，A 股主路径从"东方财富网页解析"改为"Tushare 结构化取数"；② 美股主来源改为 FMP；③ 交叉验证由"所有关键数据双源"改为**按 Level 1/2/3 分级**。评估过程与实测原始结果保留在 `docs/model/data/financial-data_v2.md`。

本规范适用于所有涉及企业财务数据的研究。**Level 1 关键数据必须来自两个独立来源，误差 >1% 须标记**（分级定义见「分级交叉验证」一节）。

---

## 获取策略（总原则）

```
Cache → Primary → Reference → Official
```

- **默认只访问 Primary**；
- **Reference** 仅在两种情况触发：① 做分级交叉验证；② Primary 缺失或访问失败需降级；
- **Official**（原始财报 / 交易所披露）只在交叉验证出现 >5% 重大差异，或 Level 1 数据点需最终核实时访问；
- **不默认访问全部来源**。

### 单次采集原则

> 同一家公司、同一报告期、同一来源的同一份报表，在第 1 步采集过程中**只请求一次**；`docs/model/financial-model.md` 的 10 个维度里凡依赖同一份利润表/资产负债表/现金流量表的字段，全部复用同一次取数结果。

例：维度 1（收入结构）与维度 2（财务指标）都需要利润表——A 股先调一次 `income`（带 `start_date`/`end_date` 一次取回近 5 年全部报告期），维度 1 取收入与增速、维度 2 取收入/净利润/利润率，**不为两个维度分别请求两次**。维度 9（估值）需要的市值/股本，与市值验算用的股本、维度 6（管理层）持股比例用的总股本，是同一个数字、取一次。

分析阶段（研究流程第 2 步）默认禁止联网，只读第 1 步落盘的 `financials-collection.json`；缺失事实通过 `evidenceRequest` 机制统一补，规则见 `docs/research/workflow/02-multi-dimension-analysis.md`，不在本文件重复。

### 按报表整表获取（Statement-First）

**错误模式**：为 Revenue 调一次接口，为 Gross Margin 再调一次，为 Net Income 再调一次——同一张表被访问 3 次。

**正确模式**：一次取回整份报表（含整段时间序列），再从结果里拆字段。频次限制放宽后这条依然有效——它是为减少冗余请求，不只是为了绕开限流。

---

## 数据源优先级

### 美股（PDD、腾讯ADR、网易ADR等）

| 优先级 | 来源 | 获取方式 | 覆盖 |
| -------- | ------ | --------- | ------ |
| 1（主） | **FMP**（`mcp__fmp__statements` / `quote` / `company`） | MCP 工具，结构化 JSON，无需解析网页 | 三大报表、实时报价、市值、高管、分析师预期、DCF |
| 2（副，交叉验证用） | **stockanalysis** | stockanalysis.com/stocks/{ticker}/financials | 与 FMP 独立的第二来源 |
| 3（副） | **macrotrends** | macrotrends.net/stocks/charts/{ticker} | 前两者都取不到时补充 |
| 原始一手 | SEC EDGAR | sec.gov，或 `mcp__fmp__secFilings` | 10-K / 10-Q 原文 |

三次调用即可覆盖财务指标类大部分字段：

```
statements(endpoint="income-statement",        symbol, period="annual", limit=5)
    → revenue / grossProfit / operatingIncome / netIncome / eps
statements(endpoint="cashflow-statement",      symbol, period="annual", limit=5)
    → operatingCashFlow / capitalExpenditure / freeCashFlow
statements(endpoint="balance-sheet-statement", symbol, period="annual", limit=5)
    → cash / totalDebt / totalAssets / totalStockholdersEquity
```

某字段在 FMP 侧 ACCESS DENIED 或缺失时，直接降级 stockanalysis，**不重试同一端点**。FMP 当前订阅层级的实测可用范围：美股 `quote` / `statements` 全部可用；**港股 `quote` / `statements` / `company.market-cap` 全部 ACCESS DENIED**，只有 `company.profile-symbol` 可用。

### A股（贵州茅台、三七互娱、吉比特等）

| 优先级 | 来源 | 获取方式 | 覆盖 |
| -------- | ------ | --------- | ------ |
| 1（主） | **Tushare Pro** | HTTP POST，token 读 `TUSHARE_TOKEN`（调用形态见下） | **三大报表 + 财务指标 + 分部收入 + 行情估值 + 股东/高管/分红/复权** |
| 2（副，交叉验证用） | **东方财富** | eastmoney.com | Level 1 数据点的第二来源；Tushare 未覆盖的字段 |
| 原始一手 | **巨潮资讯** | cninfo.com.cn | 原始年报/季报 PDF；口径存疑或 >5% 差异时回查 |

**Tushare 定位已变更**：旧版本规范写的「Tushare 不是报表来源、报表接口无权限」基于旧 token 的 40203 限制，**已随积分升级失效**（2026-08-08 实测）。现在 A 股主路径是 Tushare 结构化取数，东方财富从主来源降为交叉验证副来源。

覆盖 `docs/model/financial-model.md` 采集维度的接口对照：

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
| 补充（行情） | **Tushare `hk_daily`** | **频次 1 次/分钟**（硬限，实测撞到） | 港股日线行情；一次取回整段区间，不要逐日循环 |
| 补充（概况） | **FMP `company.profile-symbol`** | MCP 工具，实测港股可用 | 公司概况、市值快照、行业分类——不能替代报表双源 |
| 原始一手 | HKEX 披露易 | hkexnews.hk | 年报 PDF |

**港股是四个市场里结构化程度最低的**：FMP 报表端点被订阅层级挡住，Tushare 的 `hk_income` / `hk_daily_adj` 无权限（实测），港股财务报表**只能**继续走 aastocks/macrotrends 网页源 + HKEX 年报，能省的只有行情与公司概况两块。走网页源时同样适用整表读取——一次页面访问把当期三张表全部截取下来，不为不同字段重复访问同一页面。

### 台股（台积电2330、联发科2454、大立光3008等）

| 优先级 | 来源 | URL | 获取方式 |
| -------- | ------ | ----- | --------- |
| 1（主） | **FinMind API** | api.finmindtrade.com | `docs/research/tools/twstock_data.py`（零依赖脚本） |
| 2（副） | **Goodinfo台湾股市资讯网** | goodinfo.tw/tw/StockDetail.asp?STOCK_ID={代码} | 直接访问 |
| 原始一手 | 公开资讯观测站（MOPS） | mops.twse.com.tw | 财报原文/月营收公告 |

```bash
python3 docs/research/tools/twstock_data.py quote 2330        # 最新行情 + PER/PBR/殖利率 + 市值验算
python3 docs/research/tools/twstock_data.py valuation 2330    # 估值指标 + PER一年区间 + 52周高低
python3 docs/research/tools/twstock_data.py financials 2330   # 近5年年度核心财务（营收/毛利率/归母净利/EPS/ROE）
python3 docs/research/tools/twstock_data.py revenue 2330      # 近13个月月营收及同比
python3 docs/research/tools/twstock_data.py dividend 2330     # 近年股利政策（现金/股票股利、除息日）
python3 docs/research/tools/twstock_data.py search 台積        # 搜索股票代码（注意台股名称为繁体）
```

台股特别注意：

1. **货币单位是新台币（TWD）**，与港币/人民币/美元混排时必须显式标注，跨市场对比先统一换算；
2. **月营收是台股独有优势**：上市柜公司每月10日前强制披露上月营收，是跟踪基本面拐点最快的公开信号（`revenue` 子命令）；
3. FinMind 损益表为**单季值**，工具已自动加总为年度值；不足4季的年份会标注"仅前N季累计"；
4. FinMind 未注册可直接用（有小时级限额）。注册后的 API token **只存本机、严禁提交到 git**，工具按优先级读取：①环境变量 `FINMIND_TOKEN`；②本地文件 `docs/research/local/finmind_token.txt`（该目录已被 `.gitignore` 永久排除）。token 不得出现在报告、skill、commit 中；
5. 交叉验证：FinMind 数值与 Goodinfo（或 macrotrends 上的 ADR，如 TSM）对照；台积电等有 ADR 的公司注意汇率/存托比率差异（1 TSM ADR = 5 股 2330）。

---

## 网络检索规范（定性维度与取证）

结构化数据走上面各市场的取数工具；**维度 3/4/5/7/8/10 与 Evidence Agent 取证需要的网络检索，统一走 `docs/research/tools/web_search.py`**（Tavily Search API），失败时降级原生 WebSearch。用法与完整纪律见 `docs/research/workflow/01-data-collection.md` 3.3 节，此处只记规范要点：

1. **回一手披露用 `--official`**：`hk`→披露易、`cn`→巨潮+沪深交易所、`us`→SEC EDGAR、`tw`→MOPS。实测能把结果直接收敛到报表原文 PDF，是本文件「Official 层」在 >5% 重大差异复核与 Level 1 数据点最终核实时的取数方式；
2. **只取来源原文，不取检索服务的 LLM 摘要**。工具按设计不返回摘要，且该开关被硬编码关闭、不提供打开方式。2026-08-09 用 14 条真实研究查询实测：Tavily 的 `include_answer` 有 3 条（21%）编造或错记数字——把「扣非净利润 1437.73 亿」当成归母净利润并把「亿」错译为 billion、给出 8 条来源里根本不存在的行业 CAGR、凭空添加市场份额百分比——而同一次返回的原文片段全部正确。**带出处外观的假数字比诚实的 `unavailable` 有害得多**，与本文件「无出处的数字不接受」「禁止 LLM 心算」同源；
3. **`--cutoff` 不构成截止日保证**：实测只在 `--news` 模式下真正过滤（普通检索结果不带发布日期），工具在不生效时会显式提示。数据截止纪律仍靠读原文时点把关；
4. **key 只存本机**：环境变量 `TAVILY_API_KEY` 或 `~/.config/tavily/token`，与 Tushare / FinMind token 同规矩，不得出现在报告、skill 或 commit 中。配额 advanced 2 credits/次、免费 1000 credits/月（约 8 家公司）。

**检索召回不足会伪装成数据缺失**：`research/evals/defects.jsonl` 已记录一例——快手 2025Q3 收入同比被记为 `unavailable`、理由写「已查两份最新公告未见」，而该数字一直挂在公司 IR 官网的季度新闻稿上。写 `unavailable + reason` 前，先确认已经查过公司 IR 站与对应市场的一手披露源（`--domains <公司IR域名>` 或 `--official <市场>`），不要把「没搜到」直接写成「未披露」。

---

## Tushare 使用规范

### 权限与频次（2026-08-08 用本机 token 实测，非官方文档抄录）

| 接口 | 状态 | 用途 |
| ------ | ------ | ------ |
| `income` / `balancesheet` / `cashflow` | ✅ 可用（85 / 152 / 97 字段） | 三大报表 |
| `fina_indicator` | ✅ 可用（108 字段） | 财务指标：gross_margin、ROE、ROIC、ebitda、fcff/fcfe、周转率等 |
| `fina_mainbz` | ✅ 可用 | 分部主营（`type=P` 产品 / `type=D` 地区）——注意合计行陷阱 |
| `top10_holders` / `stk_rewards` / `pledge_stat` / `share_float` | ✅ 可用 | 十大股东、高管薪酬与持股、股权质押、限售解禁 |
| `forecast` / `express` | ✅ 可用 | 业绩预告 / 快报（部分标的无数据属正常） |
| `stk_holdernumber` / `disclosure_date` / `repurchase` / `moneyflow` | ✅ 可用 | 股东户数、披露日历、回购、资金流向 |
| `daily` / `daily_basic` / `adj_factor` / `dividend` / `stock_basic` | ✅ 可用，**频次已放宽** | 行情、估值与股本、复权因子、分红、标的列表 |
| `index_dailybasic` / `index_member_all` / `cn_gdp` | ✅ 可用 | 指数估值、申万行业分类、宏观 |
| `hk_daily` | ✅ 可用，**1 次/分钟** | 港股日线行情 |
| `hk_basic` / `us_basic` | ✅ 可用 | 港股/美股标的列表（仅基础信息） |
| `hk_income` / `hk_daily_adj` / `hk_mins` | ❌ 无权限 | 港股财报走网页源 |
| `us_daily` | ❌ 无权限 | 美股行情走 FMP |
| `bak_basic` / `*_vip` | ❌ 无权限 | VIP 专用接口 |

旧版规范记录的「`daily_basic` 1 次/分钟」「`adj_factor` / `dividend` / `stock_basic` 1 次/小时」**已失效**（实测连续 5 次快速调用均成功）。仍需注意：

1. **一次取回时间序列，不要逐日/逐年循环**——`daily` / `daily_basic` / `adj_factor` / `income` 等都支持 `start_date` + `end_date`，一次请求取回整段；
2. `hk_daily` 仍是 1 次/分钟，同行对比或多标的取数要摊开节奏或缓存到 `tmp/`；
3. 撞到 40203 时先看 `msg`：**「没有接口访问权限」是权限问题（换来源），「频率超限」是节流问题（等待或用缓存）**，两者共用同一错误码，不要误判成来源不可用。

### 取数工具（优先使用，已内置陷阱处理）

```bash
python3 docs/research/tools/cnstock_data.py quote 600519       # 行情 + 估值 + 市值验算
python3 docs/research/tools/cnstock_data.py valuation 600519   # PE/PB/PS/股息率 + 一年区间分位
python3 docs/research/tools/cnstock_data.py financials 600519  # 近5年核心财务（已去重、合并报表口径）
python3 docs/research/tools/cnstock_data.py segments 600519    # 分部收入（已剔除合计行并与总收入对账）
python3 docs/research/tools/cnstock_data.py holders 600519     # 十大股东 + 股东户数 + 高管薪酬持股
python3 docs/research/tools/cnstock_data.py price 600519 --adjust qfq --years 5   # 前复权价格序列
python3 docs/research/tools/cnstock_data.py search 茅台         # 搜索股票代码
```

### 调用形态（stdlib，无需装 `tushare` 包）

```python
import json, os, urllib.request
def tushare(api, params, fields=""):
    body = json.dumps({"api_name": api, "token": os.environ["TUSHARE_TOKEN"],
                       "params": params, "fields": fields}).encode()
    req = urllib.request.Request("http://api.tushare.pro", data=body,
                                 headers={"Content-Type": "application/json"})
    r = json.loads(urllib.request.urlopen(req, timeout=30).read())
    if r.get("code") != 0:                      # 40203 = 无权限 或 频率超限，看 msg 区分
        raise SystemExit(f"tushare {api}: {r.get('msg')}")
    d = r["data"]
    return [dict(zip(d["fields"], row)) for row in d["items"]]

# 一次取回整段区间，而不是按年/按日循环
income = tushare("income", {"ts_code": "600519.SH", "start_date": "20200101",
                            "end_date": "20251231", "report_type": "1"})
```

**token 规则**（与 FinMind 同）：脚本只读环境变量 `TUSHARE_TOKEN`（本机 `~/.zshrc` 从 `~/.config/tushare/token` 注入）。会话里若 `$TUSHARE_TOKEN` 为空，在命令前加 `export TUSHARE_TOKEN="$(cat ~/.config/tushare/token)"` 即可。**token 不得 echo、不得贴进对话或报告、不得写入仓库任何文件**（包括 `.env`、`.claude/settings.local.json`——两者都不在 `.gitignore` 里）。

### 数据陷阱（实测发现，采集 A 股时必须处理）

**取数一律优先用 `docs/research/tools/cnstock_data.py`**——该脚本已内置下列四条处理逻辑。手工直调 API 时必须自行处理：

#### 1. 同一报告期返回重复行 → 必须去重

`income` / `balancesheet` / `cashflow` 即使已指定 `report_type=1`，同一 `end_date` 仍可能返回 2 行，区别在 `update_flag`（`0` = 原始披露，`1` = 更新/调整后）。实测 600519 的 2018–2020 年报每期各返回 2 行。

**去重规则**：按 `end_date` 分组，同组内**优先取 `update_flag='1'`，没有才取 `'0'`**；若两行数值不同说明发生过追溯调整，取调整后并在 `note` 注明。不去重会导致"近 5 年"序列出现重复年份，把增速、CAGR 全部算错。

#### 2. `report_type` 混杂多种报表口径 → 必须显式过滤

不传 `report_type` 时返回值混合合并报表、母公司报表、调整后报表等多种口径（实测 600519 近 5 年返回 33 行）。**采集一律显式传 `report_type="1"`（合并报表）**，与年报口径一致；需要母公司口径时单独取并标注。

#### 3. 报表接口的日期参数过滤的是「公告日期」，不是报告期

`income` / `balancesheet` / `cashflow` 的 `start_date` / `end_date` 过滤的是 **`ann_date`（公告日期）**，不是 `end_date`（报告期）。实测 600519：传 `start_date=20200101, end_date=20260808` 返回的是 `ann_date` 20200422~20260425、对应 `end_date` 20191231~20260331；传 `start_date=end_date=20241231` 返回 **0 行**（那天没有公告）。

**处理规则**：① 要覆盖近 N 个财年，公告起点须再往前推 1 年；② **按报告期精确取单期，改用 `period` 参数**（`{"ts_code": ts, "period": "20241231", "report_type": "1"}`），不要用 `start_date`/`end_date`。

#### 4. `fina_mainbz` 混入合计行 → 不能直接求和

分部数据里混有合计与调整行：`type=P` 返回中 `bz_item='产品'` 是全部产品合计、`'合计特别调整'` 是调整项；`type=D` 返回中 `bz_item='地区'` 是合计。实测 600519 的 `type=P` 五行里，`'产品'`（1741.4 亿）= 全公司总收入，而 `'茅台酒'`（1459.3 亿）+ `'其他系列酒'`（246.8 亿）才是真实分部。

**处理规则**：剔除合计行后再计算分部占比；用剔除后各分部之和与 `income.total_revenue` 交叉核对，对不上说明漏了分部或口径不一致，**不要强行凑百分比**。

### 单位与空值坑（错了会直接把市值算错一个量级）

1. `daily_basic` 的 `total_share` / `float_share` 单位是**万股**，`total_mv` / `circ_mv` 单位是**万元**；
2. `ts_code` 必须带后缀（沪市 `.SH`、深市 `.SZ`、北交所 `.BJ`），只给 6 位数字取不到数据；
3. 亏损公司的 `pe` / `pe_ttm` 返回空值，不是 0——不要当成 0 参与计算或排序；
4. `daily` 是**不复权**价，历史序列必须自己用 `adj_factor` 换算成前复权（见「股价与复权」）；
5. `income` 的 `n_income`（净利润，含少数股东损益）与 `n_income_attr_p`（归母净利润）是不同口径，`total_revenue`（营业总收入）与 `revenue`（营业收入）亦然——东方财富默认展示归母净利润，对比时口径必须对齐。

---

## 执行规范

### 第一步：Metadata 校验闸门（比较数值前先核对口径）

计算误差率之前，先核对两个来源的：**报告期、货币单位、金额单位（元/万元/亿元）、会计准则（GAAP/Non-GAAP）、合并口径（是否含少数股东权益）、原始值/追溯调整值**。

- 六项任一不一致 → 直接标记 `"口径不可比"`（`Data Not Comparable`），写明不一致项，**不计算误差率**、不套用 1%/5% 阈值——不同口径算出的"误差"没有意义，反而误导判断；
- 六项一致 → 才进入误差计算。

### 第二步：分级交叉验证

**不是所有字段都要双源**，按数据对结论的杠杆分三级：

| 级别 | 字段 | 要求 |
| ------ | ------ | ------ |
| **Level 1** | Revenue、Net Income、Free Cash Flow、Shares Outstanding、Market Cap、Cash、Debt | **必须双源**，误差超阈值必须回原始财报核实 |
| **Level 2** | Gross Margin、Operating Margin、ROE、ROIC、PEG | **建议双源**；预算紧张时允许单源，但须在该字段旁注明「仅单源」 |
| **Level 3** | CEO Background、Company History、Technology Stack、Business Model 描述、企业文化 | **单源即可**，不做交叉验证 |

Level 1 与 `docs/research/workflow/01-data-collection.md`「程序化交叉验证」的必验清单（总股本、股价与市值、最近财年收入与净利润、现金储备/净现金、管理层持股比例）对应。Level 3 对应采集维度 4/5/6 的定性叙述——找到一个可靠来源即可，不为「再验证一次」重复检索。

### 第三步：误差计算与标记

程序化验算一律用 `docs/research/tools/financial_rigor.py cross-validate`，**禁止心算**。工具以**多来源中位数**为参照计算偏差（不以来源1为基准，任一来源偏离都会被标记）：

```
偏差率 = |某来源数值 - 各来源中位数| / 中位数 × 100%
```

| 误差 | 处理方式 |
| ------ | --------- |
| ≤ 1% | ✅ 一致，取中位数/主来源数值，标注两个来源 |
| 1% ~ 5% | ⚠️ 标记"数据存在差异"，注明两个数值，说明可能原因（汇率/会计口径） |
| > 5% | ❌ 标记"数据存在重大差异"，必须查原始财报核实，不得直接使用 |

### 第四步：数据呈现格式

```
收入：1,239亿元 ✅
  - Tushare（income, report_type=1）: 1,241亿元
  - 东方财富: 1,237亿元
  - 误差: 0.3%
```

差异示例：

```
净利润：245亿元 ⚠️ 数据存在差异
  - macrotrends: 245亿元（GAAP）
  - stockanalysis: 278亿元（Non-GAAP）
  - 误差: 13.5% — 原因：会计口径不同（GAAP vs Non-GAAP）
```

---

## 常见差异原因（不一定是数据错误）

| 原因 | 说明 |
| ------ | ------ |
| GAAP vs Non-GAAP | 最常见，尤其是利润类数据 |
| 归母 vs 含少数股东 | A 股 `n_income_attr_p` vs `n_income`；东方财富默认归母 |
| 营业总收入 vs 营业收入 | A 股 `total_revenue` vs `revenue`，银行保险类差异显著 |
| 汇率换算 | 港币/人民币/美元换算时间点不同 |
| 财年定义 | 自然年 vs 财年（如苹果财年10月结束） |
| 合并口径 | 是否含少数股东权益 |
| 追溯调整 | Tushare `update_flag=1` 为调整后数据 |
| 数据更新滞后 | 某平台尚未更新最新一期财报 |

---

## 特别规则

1. **未上市公司**（米哈游、莉莉丝等）：只有一手数据来源时，数据前标记 `[估计]`，不执行交叉验证；
2. **季度数据 vs 年度数据**：优先使用年度数据做交叉验证，季度数据部分来源可能有滞后；
3. **原始财报优先**：若两个来源均与原始财报（10-K/年报PDF）不符，以原始财报为准，标记来源错误。

---

## 股价与复权（历史序列必读）

价格有三种口径，混用会让历史股价位置、长期涨幅、历史估值分位全部失真：

| 口径 | 含义 | 用途 |
| ------ | ------ | ------ |
| 不复权 | 实际成交价，除权除息日跳空 | 仅用于"当前时点"快照 |
| 前复权 | 以最新价为基准回调历史价 | 历史股价对比、N年涨幅、历史PE band 一律用它 |
| 后复权 | 以上市首日为基准前推 | 计算历史总回报/年化收益 |

规则：

1. 涉及历史价格的分析统一用**前复权**，且同一分析内**不得混用**复权与不复权来源；
2. 当前市值/当前PE 用**当前实际股价 × 当前总股本**即可，与复权无关——复权只影响历史序列；
3. 跨越拆股/大比例送转的每股指标（历史EPS、历史股价），必须复权还原后再同比；
4. 总回报/年化收益需计入分红（后复权已含），只看价格涨幅会低估；
5. 增发/回购后市值验算以最新总股本为准（`financial_rigor.py verify-market-cap` 偏差>5% 会提示核对）。

**A股前复权的算法**（Tushare 只给不复权价和复权因子，前复权要自己算）：

```
前复权价 = 不复权收盘价 × 该日 adj_factor ÷ 最新交易日 adj_factor
```

`daily` 与 `adj_factor` 按 `trade_date` 对齐后逐日相乘即可（`cnstock_data.py price --adjust qfq` 已内置）。历史 PE band、N 年涨幅、历史股价分位一律用换算后的序列；当前市值/当前 PE 仍用当前实际股价。

---

## 快速索引

| 场景 | 主来源（Primary） | 副来源（Reference） |
| ------ | ------------------ | -------------------- |
| 美股任意标的 | FMP（`mcp__fmp__statements` / `quote`） | stockanalysis → macrotrends |
| PDD / 拼多多 | FMP（PDD） | stockanalysis.com/stocks/pdd |
| Nintendo / Capcom | FMP（NTDOY / CCOEY） | stockanalysis |
| A股任意标的（报表/指标/分部/股东） | `cnstock_data.py`（Tushare） | eastmoney.com 同一标的页 |
| A股行情/估值/复权/分红 | `cnstock_data.py quote / valuation / price` | eastmoney.com |
| 三七互娱 / 吉比特 / 贵州茅台 | `cnstock_data.py`（002555 / 603444 / 600519） | eastmoney.com → cninfo.com.cn |
| 腾讯 | aastocks（0700.HK） | macrotrends（TCEHY）；行情可用 Tushare `hk_daily` |
| 网易 | aastocks（9999.HK） | macrotrends（NTES） |
| 台积电 | `twstock_data.py`（2330） | goodinfo.tw / macrotrends（TSM，1 ADR=5股） |
| 联发科 | `twstock_data.py`（2454） | goodinfo.tw |
| 定性维度检索（竞争/护城河/技术/TAM/风险/多空） | `web_search.py`（Tavily） | 原生 WebSearch（工具退出码 3 时降级） |
| 回一手披露核实 Level 1 / >5% 差异 | `web_search.py --official hk\|cn\|us\|tw` | 交易所披露站直接访问 |
