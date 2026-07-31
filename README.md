# AI Research

面向港股、美股和 A 股上市公司的长期价值研究仓库。项目以核心商业模式为主线，结合最新财报、公告、经营指标和重要消息，持续判断公司的价值创造机制是否发生变化，并据此形成长期投资观点、估值区间和跟踪条件。

## 研究特点

- 从用户、付费者、价值主张、收费方式和现金来源定义商业模式。
- 建立“供给—获客—使用—变现—利润—现金—再投资”驱动链。
- 为每家公司选择 5–8 个核心维度及少量关键指标，避免通用 KPI 堆砌。
- 每次更新都核验最新财报、监管公告、公司动态、竞争和行业消息。
- 区分商业模式的参数变化、机制变化与结构性变化。
- 结合现金流、资本回报、研发组织、治理和资本配置验证商业质量。
- 将核心驱动指标直接连接到长期假设、估值和行动条件。

## 目录结构

```text
.
├── AGENTS.md                            # Codex 仓库级长期规则
├── .codex/
│   ├── hooks.json                       # 任务结束前自动校验研究文件名
│   └── hooks/validate_research_paths.py # 确定性命名校验器
├── .agents/skills/
│   └── public-company-financial-research/
│       ├── SKILL.md                    # 核心工作流与输出要求
│       ├── agents/openai.yaml          # skill 展示配置
│       └── references/                 # 模型、指标、来源和模板
├── research/
│   ├── companies/                      # 按市场、代码和公司保存研究记录
│   └── reports/                        # 专题报告与最终导出文件
└── .gitignore                          # 临时文件和生成产物忽略规则
```

Codex 没有完全等同于 `.claude/` 的单一目录。官方约定是：使用根目录 `AGENTS.md` 保存持久项目规则，使用 `.agents/skills/` 保存仓库级 skill；命令审批 rules 与生命周期 hooks 才放在 `.codex/` 配置层。本仓库使用 `.codex/hooks.json` 在 Codex 准备结束任务时自动检查公司研究路径。

研究记录采用以下命名规则：

```text
research/companies/<市场>-<代码>-<公司英文简称>/YYYY-MM-DD-HHMM-analysis.md
```

严格格式如下：

- 港股目录：`hk-<4至5位代码>-<英文slug>`
- 美股目录：`us-<小写ticker>-<英文slug>`
- A 股目录：`sh|sz|bj-<6位代码>-<英文slug>`
- 研究文件：`YYYY-MM-DD-HHMM-analysis.md`
- 同一公司同一天只保留一个研究文件，后续更新追加到已有文件。

手动校验：

```bash
python3 .codex/hooks/validate_research_paths.py
```

## 使用方法

在 Codex 中调用 `$public-company-financial-research`，并提供公司名称、股票代码和希望解决的问题。例如：

```text
使用 $public-company-financial-research 更新美团的研究记录。
重点判断核心商业模式和关键驱动指标是否发生变化，
并结合当前估值给出长期投资结论。
```

skill 会优先读取同一公司已有的研究记录，在保留历史观点的基础上追加更新，而不是用新信息覆盖旧判断。

## Skill 参考资料

- [核心工作流](.agents/skills/public-company-financial-research/SKILL.md)
- [商业模式与核心驱动指标](.agents/skills/public-company-financial-research/references/business-model-playbook.md)
- [指标与估算方法](.agents/skills/public-company-financial-research/references/metric-playbook.md)
- [来源优先级与最新信息核验](.agents/skills/public-company-financial-research/references/sources-and-priority.md)
- [风险诊断清单](.agents/skills/public-company-financial-research/references/red-flags.md)
- [研究记录模板](.agents/skills/public-company-financial-research/references/analysis-template.md)

## 证据原则

1. 优先使用监管机构、交易所和公司正式披露。
2. 明确区分披露事实、可复核计算和分析推断。
3. 记录数据期间、发布日期、消息发生日和参考股价时间。
4. 不用第三方摘要覆盖官方数据，不用单季波动轻易推翻长期判断。
5. 找不到最新披露时，明确说明信息空窗和结论限制。

## 免责声明

仓库内容仅用于研究与教育，不构成个性化投资建议。上市公司经营、市场价格和监管环境会持续变化，任何投资判断都应结合最新原始资料独立复核。
