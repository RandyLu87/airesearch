# 数据采集（研究流程第 1 步）

本文件是 `docs/research/public-company-financial-research.md` 第 1 步的唯一正文：一步完成研究上下文、双源取数与程序化交叉验证。两份文件是本步骤的唯一依据：

- **数据源规范**：`docs/model/financial-data.md` —— 每个关键数据必须来自两个独立来源，误差 >1% 须标记。
- **采集清单**：`docs/model/financial-model.md` —— 只采集其中 10 个维度，不多不少。

## 1. 建立研究上下文

1. 先运行 `date` 确认今天日期，以 Asia/Shanghai 定数据截止时间，不凭训练数据假设「最新」。
2. 明确公司、代码、交易所、报告币种、会计准则。
3. 搜索 `research/companies/`；已有记录时先读最近一次研究产出作为可比基线。按仓库 `AGENTS.md` 确定公司目录命名；同一公司同一天只维护一份产出，不新建第二份。

## 2. 按市场选定双源

按 `docs/model/financial-data.md` 的优先级取数，主副来源缺一不可：

| 市场 | 主来源 | 副来源 | 原始一手 |
|------|--------|--------|---------|
| 美股 | macrotrends | stockanalysis | SEC EDGAR（10-K / 10-Q） |
| 港股 | aastocks | macrotrends（ADR 代码） | HKEX 披露易年报 PDF |
| A股 | 东方财富 | 巨潮资讯 | 原始年报 / 季报 PDF |
| 台股 | FinMind（`docs/research/tools/twstock_data.py`） | Goodinfo | 公开资讯观测站 MOPS |

误差处理规则、常见差异原因（GAAP vs Non-GAAP、汇率、财年定义、合并口径）、未上市公司 `[估计]` 标记、历史序列前复权要求，全部以该规范正文为准，不在此复述。

## 3. 采集十个维度

**使用 Task 工具启动后台 Agent，从网络收集以下数据**（Codex 端用可用的子代理能力等价执行）。给 Agent 的指令必须带上第 1 节确定的数据截止时间和第 2 节的主副来源要求，要求它对每个数据点返回数值、来源名称、URL 与所属报告期，不接受无出处的数字。后台 Agent 只负责采集与出处记录；交叉验证（第 4 节）与落盘（第 5 节）在主会话完成。

逐项采集 `docs/model/financial-model.md` 定义的维度：

1. 收入结构：最近财年及近4季度分部收入、增速、毛利率
2. 财务指标：近5年收入、净利润、毛利率、经营利润率、自由现金流、现金储备
3. 竞争格局：市场份额、主要竞争对手对比
4. 商业模式与护城河：核心竞争优势来源
5. 技术能力：核心技术栈、研发投入
6. 管理层：创始人/CEO履历、持股比例、关键决策记录
7. 行业前景：TAM（总可寻址市场）、增长预测
8. 风险因素：地缘政治、监管、供应链等
9. 当前估值：市值、PE、PS、PEG、EV/Revenue
10. 多空双方核心论点

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

1. 每个关键数据点至少 2 个独立来源；
2. 发现来源间有差异时，优先采用公司年报/交易所数据，并注明差异原因；
3. 所有涉及计算的数据必须通过工具验算，禁止 LLM 心算；
4. 工具输出结果直接嵌入采集产出的 `crossValidationLog`（即报告附录「关键数据交叉验证记录」）；
5. 如果工具报告 ❌ 偏差过大，必须排查原因后才能继续分析。

**常见错误防范**：

- 市值单位：港币亿 vs 人民币亿 vs 美元亿，容易漏写/多写一个零；
- FCF 口径：不同来源对资本支出的定义可能不同（是否含租赁、收购等）；
- 债务口径：是否包含经营租赁负债；
- 持股比例：AB 股公司的经济权益 ≠ 投票权。

## 5. 落盘

按 `docs/model/financials—model-template.json` 的结构生成公司数据文件，落盘为 `research/companies/<company-id>/financials-collection.json`（文件名固定，渲染层按名发现）：

- 关键数值一律用模板定义的校验对象（value + 双源 + 偏差 + flag）；
- 待填写 `__TODO__`；取不到的字段不删除，写 `status: "unavailable"` 与缺失原因、已查范围；
- 每条工具验证输出记入 `crossValidationLog`。

## 完成标准

10 个维度均为「已取得」或「缺失原因 + 已查范围 + 分析影响」；关键数值都有双源记录与误差标记；市值通过 `verify-market-cap` 验算；数据截止时间已声明。
