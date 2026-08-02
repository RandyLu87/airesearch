# AI Research

面向港股、美股和 A 股上市公司的长期价值研究仓库。研究以核心商业模式和因果驱动为主线，每次更新都重新核验最新财报、公告、公司/行业消息和参考价格，再判断商业模式、关键指标、估值与长期投资结论是否变化。

## 产出方式

项目把“研究事实”和“呈现形式”分开：

- `Research Snapshot` 是唯一规范数据源，采用经过 Zod 校验的 JSON，保存事实、计算、推断、驱动指标、估值情景和证据链。
- `Research Report` 是由快照确定性生成的 HTML，不手工编辑；每份报告嵌入源 JSON 的 SHA-256。
- `Company Research Page` 汇总同一公司的最新判断、两份快照对比和历史报告入口。
- 生成站点使用受 Runway 启发的编辑型视觉语言：纸白底、黑色排版、细分隔线、本地 Inter 字体、内联 SVG 决策图表，无 CDN 和运行时后端依赖。

## 目录结构

```text
.
├── AGENTS.md                                  # Codex 仓库级规则
├── CONTEXT.md                                 # 领域语言与当前架构
├── docs/adr/                                  # 已确认的架构决策
├── .codex/hooks/validate_research_paths.py    # 路径和快照一致性校验
├── .agents/skills/public-company-financial-research/
│   ├── SKILL.md                               # 研究工作流
│   ├── references/                            # 数据源、指标与快照契约
│   └── scripts/                               # 固化的数据抓取入口
├── packages/
│   ├── research-schema/                       # Zod 快照模型与对比逻辑
│   └── research-ui/                           # React 报告组件与 SVG 图表
├── apps/web/                                  # Next.js 静态站点生成器
├── research/
│   ├── companies/<company>/
│   │   ├── snapshots/*.json                   # canonical snapshots
│   │   └── *.md                               # 只读历史研究记录
│   ├── reports/                               # 专题研究和最终导出
│   └── site/                                  # 可直接打开/托管的最终 HTML
└── tests/publication.test.mjs                 # 顶层发布契约
```

Codex 没有完全等同于 `.claude/` 的单一配置目录。本仓库用根目录 `AGENTS.md` 保存持久规则，`.agents/skills/` 保存仓库级 skill，`.codex/` 保存生命周期 hooks。

## 文件命名

规范快照只能位于：

```text
research/companies/<company-dir>/snapshots/YYYY-MM-DD-HHMM-analysis.json
```

- 港股：`hk-<4至5位代码>-<英文slug>`
- 美股：`us-<小写ticker>-<英文slug>`
- A 股：`sh|sz|bj-<6位代码>-<英文slug>`
- `<slug>` 只能使用小写 ASCII kebab-case。
- 时间采用 Asia/Shanghai 24 小时制；同一公司同一天只有一份规范快照。
- 公司目录根部既有的同名 `.md` 是历史输入；后续研究不再以 Markdown 为规范产出。

## 使用方法

在 Codex 中调用 `$public-company-financial-research`，提供公司、证券代码和研究问题。skill 会读取最新快照、构建数据包、更新 JSON，然后调用同一套生成器发布公司主页和报告。

```text
使用 $public-company-financial-research 更新网易云音乐研究。
重点判断订阅主导的商业模式、核心驱动和长期投资结论是否变化。
```

本地命令：

```bash
npm install
npm run publish     # 生成 research/site
npm run verify      # 类型检查、端到端发布契约、研究路径校验
```

打开 [研究站点](research/site/index.html)，或直接查看 [网易云音乐公司研究主页](research/site/companies/hk-9899-netease-cloud-music.html)。HTML 使用相对资源路径，可以离线打开，也可以原样部署到任意静态托管服务。

## Skill 参考资料

- [核心工作流](.agents/skills/public-company-financial-research/SKILL.md)
- [研究快照契约](.agents/skills/public-company-financial-research/references/analysis-template.md)
- [数据 API 与降级路径](.agents/skills/public-company-financial-research/references/data-source-registry.md)
- [商业模式与核心驱动指标](.agents/skills/public-company-financial-research/references/business-model-playbook.md)
- [指标与估算方法](.agents/skills/public-company-financial-research/references/metric-playbook.md)
- [来源优先级与最新信息核验](.agents/skills/public-company-financial-research/references/sources-and-priority.md)
- [风险诊断清单](.agents/skills/public-company-financial-research/references/red-flags.md)

## 证据原则

1. 优先使用监管机构、交易所和公司正式披露。
2. 明确区分披露事实、可复核计算和分析推断。
3. 记录数据期间、发布日期、消息发生日、抓取时间与参考价格时间。
4. 不用第三方摘要覆盖官方数据，不用单季波动轻易推翻长期判断。
5. 缺少最新披露时，记录信息空窗、已查范围和结论限制。

## 免责声明

仓库内容仅用于研究与教育，不构成个性化投资建议。上市公司经营、市场价格和监管环境会持续变化，任何投资判断都应结合最新原始资料独立复核。
