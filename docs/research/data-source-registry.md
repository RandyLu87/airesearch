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

## 6. Tushare 固定接口

Tushare 使用 `POST https://api.tushare.pro`，请求体固定为 `api_name`、`token`、`params`、`fields`。它覆盖三地市场但不是监管原始来源；权限、积分、覆盖公司和字段可能不同。

实际接口名和是否传日期只在 `scripts/research/api-catalog.json` 维护：A 股 profile 覆盖日线、估值、三表、财务指标、主营构成与分红；港股 profile 覆盖复权日线、三表与财务指标；美股 profile 覆盖日线、三表与财务指标。修改目录后必须运行脚本 `self-test`，不要在本文件复制清单。

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
