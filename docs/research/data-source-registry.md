# 数据源注册表

本文件规定数据获取策略和降级路径；`scripts/research/api-catalog.json` 是端点、表单类型和 API 清单的机器唯一事实源。研究时执行已登记接口，不重新搜索“用什么 API”。API 用于构建可重复的数据包；监管、交易所和公司原始文件仍是投资结论的最终证据。

## 目录

1. 固定运行方式
2. 凭证与安全
3. 美股数据面
4. 港股数据面
5. A 股数据面
6. Tushare 固定接口
7. 新鲜度与审计
8. 失败与变更处理

## 1. 固定运行方式

从仓库根目录执行：

```bash
# 美股：SEC 官方 submissions、最新文件列表和 companyfacts
python3 scripts/research/fetch_financial_data.py \
  sec --ticker CRCL

# A 股：Tushare 行情、估值、三表、财务指标、主营构成与分红
python3 scripts/research/fetch_financial_data.py \
  tushare --market a --symbol 600519.SH --start-date 20210101

# 港股：Tushare 行情、三表与财务指标
python3 scripts/research/fetch_financial_data.py \
  tushare --market hk --symbol 03690.HK --start-date 20210101

# 美股行情与标准化财务数据；SEC 数据仍应同时获取
python3 scripts/research/fetch_financial_data.py \
  tushare --market us --symbol CRCL --start-date 20210101
```

输出固定写入 `tmp/data/<market>-<symbol>/<UTC时间>/`，并生成 `manifest.json`。`tmp/` 已被忽略，不把原始缓存提交到 Git。只有研究记录中的来源日志、关键数据和推导需要长期保存。

## 2. 凭证与安全

- SEC 公共数据 API 不需要 key。请求必须带可识别 User-Agent；脚本优先读取 `SEC_USER_AGENT`，否则使用仓库 `git config user.email` 生成。两者均缺失时停止。
- Tushare 只从环境变量 `TUSHARE_TOKEN` 读取 token。不要把 token 写入参数、配置文件、研究记录、manifest 或 Git。
- 当前环境未配置 Tushare token 时，脚本明确失败；按对应市场的官方来源降级，不临时寻找匿名私有接口。
- 不在 skill 中保存付费供应商账号、cookies、浏览器会话或 API key。

## 3. 美股数据面

### 官方结构化数据：SEC EDGAR

脚本从 `api-catalog.json` 读取 ticker/CIK 映射、submissions、companyfacts 和原始 filing URL 模板；manifest 保存目录版本与 SHA-256，确保历史数据包可复现。

SEC APIs 实时更新且无需认证。`companyfacts` 只覆盖标准 taxonomy、整家公司层面的 XBRL facts；公司扩展标签、分部、附注和管理层解释必须回到 10-K、10-Q、20-F、40-F、6-K、8-K 或 proxy 原文。

固定优先级：SEC 原文与 XBRL → 公司 IR 镜像/演示 → Tushare 标准化数据交叉检查 → 其他数据商。

官方文档：

- https://www.sec.gov/search-filings/edgar-application-programming-interfaces
- https://www.sec.gov/about/developer-resources

## 4. 港股数据面

HKEX 面向机构提供 Issuer Information Feed Service 和市场数据产品，但不是免认证、稳定公开的零售 REST API。

**不要把网页内部未公开接口或反向工程参数固化进脚本。** 这条约束的对象是**脚本化的批量结构化取数**——固化下来会无声失效、可能违反服务条款，且是规模化调用。它**不适用于**下一节的单点参考价格取证：那是一次性、人工核对、带证据记录的动作，不写进任何脚本。

固定路径：

1. 用 Tushare 构建标准化三表与历史行情数据包；它是二级数据源，**港股属于独立权限模块，需在基础积分之上单独付费**（详见第 6 节）。当前仓库未购买该权限，所以港股三表以年报和业绩公告原文为准，Tushare 仅在已获授权时用作交叉核对。
2. 用 HKEXnews 标题搜索确认截至当前的全部定期报告和重大公告，并下载直接 PDF。
3. 用公司 IR 补充电话会、演示、经营 KPI、产品与组织信息。
4. 参考价格按下一节取证。

### 4.1 估值时点参考价格

每次研究只需要**一个带时间戳的参考价格**，用于 `summary.referencePrice`，并向下影响合理价值、安全边际与行动区间。它不是行情流，不需要数据订阅。

规则：

- 允许使用任何**可公开访问、可引用、带明确时间戳**的行情源。
- **必须双源交叉**：两个独立来源的价格与时点都要记录，偏离超过 1% 时说明原因（盘中时差属正常），无法解释就不要写入快照。
- 必须为价格建立 `evidence` 记录，`kind` 为 `fact`，包含 `publisher`、`url`、`retrievedAt` 和 `caveat`（至少注明「行情仅用于参考价格与估值时点」）。
- 不得把取价过程写进 `scripts/`。取不到可靠价格时，宁可中止本次研究，也不要估一个数——它会一路传导进估值结论。

已核实的源状况（2026-08-03 实测，后续失效请就地更新）：

| 源 | 状态 |
| --- | --- |
| `https://qt.gtimg.cn/q=hk<code>` | 可用、免费、无鉴权，返回价格与秒级时间戳；未公开接口，仅可人工取证引用，不得固化 |
| `https://stockanalysis.com/quote/hkg/<code>/` | 可用，带日期与时分；适合作为交叉源 |
| HKEX 官方报价页 | **不可机读**：返回空模板，无价格数据 |
| Yahoo Finance `9899.HK` | **不可信**：2026-08-03 返回无日期的陈旧价，与另两源偏离 6.5% 且方向相反 |
| 公司 IR `ir.music.163.com` | **TLS 证书不匹配**（证书签给 `web002.guruir.com`），机器抓取会失败，需人工访问 |

HKEX 官方入口：

- 公告搜索：`https://www1.hkexnews.hk/search/titlesearch.xhtml?lang=en`
- Issuer Information Feed Service：`https://www.hkex.com.hk/Services/Market-Data-Services/Infrastructure/Issuer-Information-feed-Service-%28IIS%29?sc_lang=en`
- HKEX Data Marketplace：`https://www.hkex.com.hk/Services/Market-Data-Services/Historical-Data-Services/HKEX-Data-Marketplace?sc_lang=en`

## 5. A 股数据面

固定路径：

1. 用 Tushare 构建行情、估值、三表、财务指标、主营构成和分红数据包。
2. 用上交所、深交所、北交所或巨潮资讯的原始公告核对报告期、发布日期、重列、会计口径和重大事项。
3. 公司特定经营 KPI、产品/价格、人员研发和治理数据回到年报附注、ESG、公告及公司 IR。

不固化交易所或巨潮网页的未公开内部 JSON 接口。若未来获得正式开放 API，再在本注册表登记版本、认证、限流和替代路径后接入脚本。

官方入口：

- 上交所：`https://www.sse.com.cn/`
- 深交所：`https://www.szse.cn/`
- 北交所：`https://www.bse.cn/`
- 巨潮资讯：`https://www.cninfo.com.cn/`

### 5.1 A 股参考价格与定期报告全文

参考价格规则与第 4.1 节完全一致：可公开访问、可引用、带时间戳，必须双源交叉，必须建 `evidence`，不得写进 `scripts/`。已核实的源状况（2026-08-04 实测，后续失效请就地更新）：

| 源 | 状态 |
| --- | --- |
| `https://qt.gtimg.cn/q=sh<code>` / `q=sz<code>` | 可用、免费、无鉴权；返回收盘价、前收、成交额、**总股本**与总市值，含秒级时间戳（如 `20260804161455`）。总股本字段可用于核对回购注销后的最新股数 |
| `https://push2.eastmoney.com/api/qt/stock/get?secid=1.<code>`（沪市 `1.`、深市 `0.`） | 可用，**独立于腾讯/新浪的上游**，适合作交叉源；`f43` 为最新价（分为单位）、`f84/f85` 为总股本/流通股、`f116` 为总市值 |
| `https://hq.sinajs.cn/list=sh<code>`（需 `Referer: https://finance.sina.com.cn`） | 可用，返回 GBK 编码与「日期 + 时分秒」，可作第三源印证；与腾讯疑似同上游，不单独算作交叉 |
| `https://stockanalysis.com/quote/shh/<code>/` | **不可用**：返回 404 |

接口给出的「市盈率（动）」是单季年化口径（茅台实测 15.24 倍 vs TTM 20.08 倍），不要当成 TTM 直接引用；倍数一律自己算。

**定期报告全文**：`static.sse.com.cn` 的年报 PDF 直链存在 JS 反爬（返回 HTML 挑战页而非 PDF），`curl` 拿不到。可行路径按优先级：

1. 公司 IR 站点的公告 PDF 直链（如 `https://www.moutaichina.com/mtgf/articleFileDir/<YYYY-MM>/<DD>/<hash>.pdf`），从 IR 公告列表页取 hash；
2. `curl -sL --compressed` 下载后用 `pdftotext -layout` 提取——`WebFetch` 对中文年报 PDF 会失败，必须先落盘再本地解析；
3. 财经门户托管的同一份 PDF 镜像；引用时 `url` 写实际读到的那一份，并在 `caveat` 里说明它是镜像及交叉核对了哪些数字。

用镜像或转写来源取数时，必须找一个独立锚点交叉核对（例如用最新年报披露的「上年同期数」验证上一年年报的分部数字）。核对不上的字段不要写进账本。

## 6. Tushare 固定接口

Tushare 使用 `POST https://api.tushare.pro`，请求体固定为 `api_name`、`token`、`params`、`fields`。它覆盖三地市场但不是监管原始来源；权限、积分、覆盖公司和字段可能不同。

实际接口名和是否传日期只在 `scripts/research/api-catalog.json` 维护：A 股 profile 覆盖日线、估值、三表、财务指标、主营构成与分红；港股 profile 覆盖复权日线、三表与财务指标；美股 profile 覆盖日线、三表与财务指标。修改目录后必须运行脚本 `self-test`，不要在本文件复制清单。

### 6.1 已实测的 A 股权限矩阵

当前仓库 token 实测（2026-08-04，`600519.SH`，`--start-date 20230101`）：

| 接口 | 官方门槛 | 本 token | 说明 |
| --- | --- | --- | --- |
| `daily` | 120 起 | ✅ 868 行 | 历史日线，可用于决策图表 |
| `daily_basic` | 2000 起 | ✅ 868 行 | 含 `pe`/`pe_ttm`/`pb`/`total_share`/`total_mv`/`dv_ttm`，交叉核对价值最高 |
| `dividend` | 2000 起 | ✅ 62 行 | 含 `div_proc`，能拿到按回购注销后股本**调整过**的每股分红 |
| `income` | 2000 起 | ❌ 40203 | 无权限 |
| `balancesheet` | 2000 起 | ❌ 40203 | 无权限 |
| `cashflow` | 2000 起 | ❌ 40203 | 无权限 |
| `fina_indicator` | 2000 起 | ❌ 40203 | 无权限 |
| `fina_mainbz` | 2000 起 | ❌ 40203 | 无权限，**分部/主营构成历史序列仍需回年报** |

**关键结论：门槛数字不能预测可用性。** `daily_basic` 与 `dividend` 的官方门槛同为「2000 起」却可用，而同门槛的五个财务接口全部 40203 —— 说明**财务数据接口是独立权限模块**，与港股、美股模块同理，不是靠积分自动解锁。判断能不能用的唯一办法是实跑一次并读 `manifest.json` 的 `errors`。

因此 A 股研究的降级路径**依然成立且必须保留**：三表、分产品/分渠道收入、产销量、产能、经销商、员工研发一律以定期报告原文为准（见 5.1 节的 PDF 提取路径）。Tushare 在当前权限下的实际用途是三项交叉核对：

1. **参考价格**：`daily` 的 `close`/`pre_close`/`amount` 作为第三、第四个独立源；
2. **股数与市值**：`daily_basic.total_share` 直接给出回购注销后的最新总股本，比媒体报道可靠；
3. **利润与净资产的反算校验**：用 `pe`（静态）、`pe_ttm`、`pb` 乘 `total_mv` 反解归母净利润与归母净资产，可在**没有三表权限**的情况下间接验证自己从年报抄来的数字。茅台实测四项全部吻合到小数点后两位。

`dv_ratio`/`dv_ttm` 与自己算的股息率对不上时，先怀疑每股分红是否已按回购注销调整，而不是怀疑股价。

### 6.2 AkShare —— 交叉核对与断争来源（不作主来源）

**定位（2026-08-04 按第 8 节「新增供应商」门槛登记）：** AkShare 是开源 Python 库，通过封装新浪财经、东方财富等站点的**未公开接口**提供 A 股数据。它是**三级来源**——爬聚合商，聚合商再聚合公告——因此它在本仓库的角色被限定为**交叉核对、断争与补缺，永不作为主来源**。三张报表、分部收入、产销量、产能、经销商、人员研发的主来源仍然是定期报告原文。

它填补的是 Tushare 财务数据模块无权限造成的空洞（见 6.1 节）：

| 用途 | 函数 | 上游 |
| --- | --- | --- |
| 三表 | `stock_financial_report_sina(stock="sh600519", symbol="利润表"/"资产负债表"/"现金流量表")` | 新浪 |
| 财务指标 | `stock_financial_analysis_indicator(symbol="600519", start_year=...)` | 新浪 |
| 主营构成（分部） | `stock_zygc_em(symbol="SH600519")` | 东财 |
| 三表第二上游 | `stock_profit_sheet_by_report_em` 等东财系 | 东财 |

**运行方式：不建常驻环境。** 仓库不新增 Python 依赖清单；按需用 `uv` 的免安装模式执行：

```bash
uv run --quiet --with akshare --python 3.13 python <script>
```

首次约 13 秒，之后走 uv 缓存。探针脚本写到 `tmp/` 或 `/tmp`，不提交。

**三条硬规则**（违反任一条就不要用它的数字）：

1. **加总必须闭合。** 分部收入之和（含「其他」补充项）必须回到利润表营业收入。茅台实测 FY2023 `1265.89 + 206.30 + 4.75 = 1476.94` 亿元，与营业收入分毫不差；对不上就说明口径或期间错位，弃用。
2. **先验证来源，再用它断争。** 用**至少两个已有一手确认的报告期**核对同一个字段，全部吻合后才允许用它判有争议的期间。只验 headline 不够——要验你打算填的**那个具体行项**。
3. **只转述，不采信计算。** 可以用它转述的披露值（分部收入与成本、报表行项），不可以把它或上游算好的 PE、ROE、毛利率、自由现金流当成自己的可复核计算。第 6 节对数据商的这条禁令同样适用于 AkShare。

规则 3 有一个重要区分：东财的「主营构成」是**转述年报披露的分部表**，不是数据商自己的衍生计算，所以它落在「可转述」一侧；而 `daily_basic` 的 `pe`、`pb` 属于衍生计算，只能用于反算校验，不能直接写进快照。

**已知风险与降级：** 未公开接口会无声失效，且无版本化与服务条款保障。任何一次调用报错或规则 1 不闭合时，直接回到定期报告原文，不要试图修参数绕过。

**实战记录（2026-08-04，贵州茅台）：** 用它解决了 FY2023 分部数据的三方冲突——新浪公告镜像转写给出茅台酒 1247.26 亿元，而按 FY2024 年报披露的 +15.28% 增速反推应为 1265.86 亿元。AkShare 给出 1265.89 亿元且毛利率 94.12% 与镜像一致（镜像毛利率对、收入错，属转写错位），加总又闭合到营业收入，据此判定镜像有误并把 FY2023 分部纳入账本。

官方文档：

- HTTP 协议：`https://tushare.pro/document/1?doc_id=130`
- 数据目录：`https://tushare.pro/document/2?doc_id=17`
- 权限与频次：`https://tushare.pro/document/1?doc_id=290`

标准化字段出现空值、异常符号、报告期错位或与原始文件冲突时，以原始文件为准并在来源日志记录差异。不要把数据商计算的 PE、ROE、自由现金流或市值直接当成自己的可复核计算。

## 7. 新鲜度与审计

每次研究创建新的数据包，不把上次缓存默认为最新。允许在同一任务内复用同一 manifest；跨任务复用时必须先核对 `fetched_at` 和最新公告时间。

数据包完成标准：

- `manifest.json` 的 `fetched_at`、证券代码、市场和请求端点正确。
- `api_catalog.sha256` 已记录，目录版本与本次调用一致。
- 每个预期数据集标记成功或出现在 `errors`。
- SEC 最新文件列表覆盖目标 forms；Tushare 数据覆盖目标时间区间。
- 价格带交易日、币种、收盘/盘中状态；财务数字带报告期、发布日期、币种、单位和累计/单季口径。
- 所有脚本错误都已通过官方来源补齐或写入研究限制。

API 数据进入报告前至少抽查：最新一期收入、归母利润、经营现金流、现金/债务、摊薄股数和参考价格。任何一项冲突都回到原始表格和附注。

## 8. 失败与变更处理

- 认证或权限错误：记录缺失，使用官方文件；不要绕过认证。
- `429` 或限流：遵守响应并退避；不要并发轰炸或轮换身份。
- schema/字段变化：保存原始响应，停止依赖缺失字段，在本注册表和脚本中一次性修复映射。
- 服务不可用：官方公告与财报路径仍需完成，数据包在 manifest 中标记降级。
- 新增供应商：只有在来源权威性、覆盖、时点、认证、限流、字段口径、成本和降级路径均明确后，才加入本注册表。
