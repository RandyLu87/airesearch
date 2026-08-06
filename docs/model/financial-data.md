# 财务数据获取与交叉验证规范

> 本文件于 2026-08-05 自 `ai-berkshire/skills/financial-data.md` 迁移而来，此后以本文件为唯一正文独立维护，不再回读 `ai-berkshire/`。配套工具同步迁移至 `docs/research/tools/`。

本规范适用于所有涉及企业财务数据的研究。**每个关键数据必须来自两个独立来源，误差>1%须标记。**

---

## 数据源优先级

### 美股（PDD、腾讯ADR、网易ADR等）

| 优先级 | 来源 | URL | 获取方式 |
| -------- | ------ | ----- | --------- |
| 1（主） | **macrotrends** | macrotrends.net/stocks/charts/{ticker} | 直接访问，无需注册 |
| 2（副） | **stockanalysis** | stockanalysis.com/stocks/{ticker}/financials | 直接访问，无需注册 |
| 原始一手 | SEC EDGAR | sec.gov/cgi-bin/browse-edgar | 10-K / 10-Q 原文 |

### 港股（腾讯0700、网易9999、美团3690等）

| 优先级 | 来源 | URL | 获取方式 |
| -------- | ------ | ----- | --------- |
| 1（主） | **aastocks** | aastocks.com/tc/stocks/analysis/company-fundamental | 直接访问 |
| 2（副） | **macrotrends**（ADR代码） | 腾讯用TCEHY，网易用NTES | 直接访问 |
| 原始一手 | HKEX披露易 | hkexnews.hk | 年报PDF |

### A股（三七互娱、吉比特等）

| 优先级 | 来源 | URL | 获取方式 | 覆盖 |
| -------- | ------ | ----- | --------- | ------ |
| 1（主） | **东方财富** | eastmoney.com → 搜股票代码 → 财务报表 | 直接访问 | 财务报表、估值、行情 |
| 1（主，程序化） | **Tushare Pro** | api.tushare.pro | HTTP POST，token 读环境变量 `TUSHARE_TOKEN`（见下） | **只有**行情、估值倍数、复权因子、分红 |
| 2（副） | **巨潮资讯** | cninfo.com.cn | 原始年报/季报PDF | 原始一手报表 |

**Tushare 的定位：行情与估值的程序化双源，不是报表来源。** 当前 token 的财务报表接口全部无权限（实测见下表），所以收入、利润、现金流、分部数据仍然走「东方财富 + 巨潮资讯」双源，Tushare 只负责股价、市值、PE/PB/股息率、复权因子、分红这类可程序化取回并精确验算的数据——它与东方财富互为这些字段的两个独立来源。

**权限与频次（2026-08-06 用本机 token 实测，非官方文档抄录）**：

| 接口 | 状态 | 频次上限 | 用途 |
| ------ | ------ | --------- | ------ |
| `daily` | ✅ 可用 | 宽松 | 日线行情（不复权）：开高低收、涨跌幅、成交额 |
| `daily_basic` | ✅ 可用 | **1 次/分钟** | 估值与股本：`pe`、`pe_ttm`、`pb`、`ps_ttm`、`dv_ttm`、`total_share`、`total_mv` |
| `adj_factor` | ✅ 可用 | **1 次/小时** | 复权因子，用于把历史价换成前复权 |
| `dividend` | ✅ 可用 | **1 次/小时** | 分红送转：每股现金分红、除权除息日 |
| `stock_basic` | ✅ 可用 | **1 次/小时** | 代码、简称、所属行业、上市日期 |
| `income` / `balancesheet` / `cashflow` | ❌ 40203 无权限 | — | 三大报表——改走东方财富 + 巨潮 |
| `fina_indicator` / `fina_mainbz` | ❌ 40203 无权限 | — | 财务指标 / 分部主营——改走年报原文 |
| `top10_holders` / `express` / `forecast` | ❌ 40203 无权限 | — | 十大股东 / 业绩快报 / 业绩预告 |

频次是硬约束，直接决定取数方式：

1. **一次取回时间序列，不要逐日循环**——`daily` / `daily_basic` / `adj_factor` 都支持 `start_date` + `end_date`，一次请求就能拿回整段历史；按日循环会在第二次调用就撞上限；
2. **不要为同行对比逐个标的调 `daily_basic`**（1 次/分钟）——同行估值优先用东方财富页面，或把请求摊开并把结果缓存到 `tmp/`；
3. 撞到 40203 时先看 `msg`：**「没有接口访问权限」是权限问题（换来源），「频率超限」是节流问题（等待或用缓存）**，两者共用同一个错误码，不要误判成来源不可用。

**token 规则**（与 FinMind 同）：脚本只读环境变量 `TUSHARE_TOKEN`（本机 `~/.zshrc` 从 `~/.config/tushare/token` 注入）。会话里若 `$TUSHARE_TOKEN` 为空，在命令前加 `export TUSHARE_TOKEN="$(cat ~/.config/tushare/token)"` 即可。**token 不得 echo、不得贴进对话或报告、不得写入仓库任何文件**（包括 `.env`、`.claude/settings.local.json`——两者都不在 `.gitignore` 里）。

调用形态（stdlib，无需装 `tushare` 包）：

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

# 一次拿回整段行情，而不是按日循环
rows = tushare("daily", {"ts_code": "600519.SH", "start_date": "20250101", "end_date": "20260805"})
```

单位与空值坑（错了会直接把市值算错一个量级）：

1. `daily_basic` 的 `total_share` / `float_share` 单位是**万股**，`total_mv` / `circ_mv` 单位是**万元**；
2. `ts_code` 必须带后缀（沪市 `.SH`、深市 `.SZ`、北交所 `.BJ`），只给 6 位数字取不到数据；
3. 亏损公司的 `pe` / `pe_ttm` 返回空值，不是 0——不要当成 0 参与计算或排序；
4. `daily` 是**不复权**价，历史序列必须自己用 `adj_factor` 换算成前复权（见下方「股价与复权」）。

### 台股（台积电2330、联发科2454、大立光3008等）

| 优先级 | 来源 | URL | 获取方式 |
| -------- | ------ | ----- | --------- |
| 1（主） | **FinMind API** | api.finmindtrade.com | `docs/research/tools/twstock_data.py`（零依赖脚本，见下） |
| 2（副） | **Goodinfo台湾股市资讯网** | goodinfo.tw/tw/StockDetail.asp?STOCK_ID={代码} | 直接访问 |
| 原始一手 | 公开资讯观测站（MOPS） | mops.twse.com.tw | 财报原文/月营收公告 |

**FinMind 取数工具**（分析台股时优先调用，输出自带市值验算）：

```bash
python3 docs/research/tools/twstock_data.py quote 2330        # 最新行情 + PER/PBR/殖利率 + 市值验算
python3 docs/research/tools/twstock_data.py valuation 2330    # 估值指标 + PER一年区间 + 52周高低
python3 docs/research/tools/twstock_data.py financials 2330   # 近5年年度核心财务（营收/毛利率/归母净利/EPS/ROE）
python3 docs/research/tools/twstock_data.py revenue 2330      # 近13个月月营收及同比
python3 docs/research/tools/twstock_data.py dividend 2330     # 近年股利政策（现金/股票股利、除息日）
python3 docs/research/tools/twstock_data.py search 台積        # 搜索股票代码（注意台股名称为繁体）
```

台股特别注意：

1. **货币单位是新台币（TWD）**，与港币/人民币/美元混排时必须显式标注，跨市场对比先统一换算
2. **月营收是台股独有优势**：上市柜公司每月10日前强制披露上月营收，是跟踪基本面拐点最快的公开信号，earnings-review/thesis-tracker 类分析应优先利用（`revenue` 子命令）
3. FinMind 损益表为**单季值**，工具已自动加总为年度值；不足4季的年份会标注"仅前N季累计"
4. FinMind 未注册可直接用（有小时级限额）。注册后的 API token **只存本机、严禁提交到 git**，工具按优先级自动读取：①环境变量 `FINMIND_TOKEN`；②本地文件 `docs/research/local/finmind_token.txt`（该目录已被 `.gitignore` 永久排除，把 token 单独一行写入该文件即可）。token 不得出现在报告、skill、commit 中
5. 交叉验证：FinMind 数值与 Goodinfo（或 macrotrends 上的 ADR，如 TSM）对照，误差规则同下；台积电等有 ADR 的公司注意 ADR 与台股原股的汇率/存托比率差异（1 TSM ADR = 5 股 2330）

---

## 执行规范

### 第一步：获取数据

对每个财务指标（收入、净利润、毛利率、经营现金流、资产负债率等），分别从**来源1**和**来源2**取数。

### 第二步：误差计算与标记

```
误差率 = |来源1数值 - 来源2数值| / 来源1数值 × 100%
```

| 误差 | 处理方式 |
| ------ | --------- |
| ≤ 1% | ✅ 一致，取来源1数值，标注两个来源 |
| 1% ~ 5% | ⚠️ 标记"数据存在差异"，注明两个数值，说明可能原因（汇率/会计口径） |
| > 5% | ❌ 标记"数据存在重大差异"，必须查原始财报核实，不得直接使用 |

### 第三步：数据呈现格式

每个关键数据必须按以下格式标注：

```
收入：1,239亿元 ✅
  - macrotrends: 1,241亿元
  - stockanalysis: 1,237亿元
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
| 汇率换算 | 港币/人民币/美元换算时间点不同 |
| 财年定义 | 自然年 vs 财年（如苹果财年10月结束） |
| 合并口径 | 是否含少数股东权益 |
| 数据更新滞后 | 某平台尚未更新最新一期财报 |

---

## 特别规则

1. **未上市公司**（米哈游、莉莉丝等）：只有一手数据来源时，数据前标记 `[估计]`，不执行交叉验证
2. **季度数据 vs 年度数据**：优先使用年度数据做交叉验证，季度数据部分来源可能有滞后
3. **原始财报优先**：若两个来源均与原始财报（10-K/年报PDF）不符，以原始财报为准，标记来源错误

---

## 股价与复权（历史序列必读）

价格有三种口径，混用会让历史股价位置、长期涨幅、历史估值分位全部失真：

| 口径 | 含义 | 用途 |
| ------ | ------ | ------ |
| 不复权 | 实际成交价，除权除息日跳空 | 仅用于"当前时点"快照 |
| 前复权 | 以最新价为基准回调历史价 | 历史股价对比、N年涨幅、历史PE band 一律用它 |
| 后复权 | 以上市首日为基准前推 | 计算历史总回报/年化收益 |

规则：

1. 涉及历史价格的分析统一用**前复权**，且同一分析内**不得混用**复权与不复权来源。
2. 当前市值/当前PE 用**当前实际股价 × 当前总股本**即可，与复权无关——复权只影响历史序列。
3. 跨越拆股/大比例送转的每股指标（历史EPS、历史股价），必须复权还原后再同比。
4. 总回报/年化收益需计入分红（后复权已含），只看价格涨幅会低估。
5. 增发/回购后市值验算以最新总股本为准（`docs/research/tools/financial_rigor.py verify-market-cap` 偏差>5% 会提示核对）。

**A股前复权的算法**（Tushare 只给不复权价和复权因子，前复权要自己算）：

```
前复权价 = 不复权收盘价 × 该日 adj_factor ÷ 最新交易日 adj_factor
```

`daily` 与 `adj_factor` 按 `trade_date` 对齐后逐日相乘即可。`adj_factor` 是 1 次/小时的接口，**一次把整段区间取回来缓存**，不要为每个年份分别请求。历史 PE band、N 年涨幅、历史股价分位一律用换算后的序列；当前市值/当前 PE 仍用当前实际股价，与复权无关。

---

## 快速索引

| 场景 | 主要来源 | 备用来源 |
| ------ | --------- | --------- |
| PDD / 拼多多 | macrotrends.net/stocks/charts/PDD | stockanalysis.com/stocks/pdd |
| 腾讯 | macrotrends.net/stocks/charts/TCEHY | aastocks（0700.HK） |
| 网易 | macrotrends.net/stocks/charts/NTES | aastocks（9999.HK） |
| 三七互娱 | eastmoney.com（002555） | cninfo.com.cn |
| 吉比特 | eastmoney.com（603444） | cninfo.com.cn |
| A股行情/估值/复权/分红（任意标的） | Tushare `daily`、`daily_basic`、`adj_factor`、`dividend` | eastmoney.com（同一标的页） |
| A股财务报表（任意标的） | eastmoney.com | cninfo.com.cn 年报PDF（Tushare 报表接口无权限） |
| Nintendo | macrotrends.net/stocks/charts/NTDOY | stockanalysis.com/stocks/ntdoy |
| Capcom | macrotrends（CCOEY） | stockanalysis（CCOEY） |
| 台积电 | docs/research/tools/twstock_data.py（2330） | goodinfo.tw / macrotrends（TSM，注意1 ADR=5股） |
| 联发科 | docs/research/tools/twstock_data.py（2454） | goodinfo.tw |
