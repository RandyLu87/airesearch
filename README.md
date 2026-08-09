# AI Research

面向港股、美股和 A 股上市公司的长期价值研究仓库。研究以核心商业模式和因果驱动为主线，每次运行同一套六步流程：数据采集 → 多维度分析 → 分析总结 → 数据校验 → 渲染网站 → 更新首页。

## 产出方式

项目把「研究事实」和「呈现形式」分开：

- 每家公司的规范数据是四份固定文件名的 JSON：`financials-collection.json`（双源采集）、`financials-analysis.json`（六维分析，含追问与回答）、`financials-summary.json`（结论、0–10 信心度评分与四类策略建议）、`financials-final.json`（校验通过后由脚本合并的渲染输入，不手写）。
- 完整性有两道闸门：`data_validator.py` 按模板逐字段打分（满分 10，低于 7 走关键信息补全流程）；`build_final.py` 合并时复用同一校验，低于阈值拒绝生成。
- 公司分析页与首页由 `npm run publish` 从 `financials-final.json` 确定性生成，不手工编辑；缺失字段显示原因，不用 0 或空白代替。
- 生成站点使用受 Runway 启发的编辑型视觉语言：纸白底、黑色排版、细分隔线、本地 Inter 字体，无 CDN 和运行时后端依赖。

## 目录结构

```text
.
├── AGENTS.md                                  # 仓库级规则（Codex 与 Claude Code 共用）
├── CONTEXT.md                                 # 领域语言与当前架构
├── CLAUDE.md                                  # Claude Code 指针，指向 AGENTS.md
├── docs/adr/                                  # 已确认的架构决策
├── docs/research/
│   ├── public-company-financial-research.md   # 研究流程总纲（1–6 步）
│   ├── workflow/<NN>-*.md                     # 每一步的唯一正文
│   └── tools/                                 # data_validator / build_final / financial_rigor / twstock_data
├── docs/model/                                # 数据源规范、采集清单与四份产出模板
├── scripts/research/                          # 研究路径校验器
├── .agents/skills/public-company-financial-research/
│   ├── SKILL.md                               # 薄壳，指向 docs/research/public-company-financial-research.md
│   └── agents/openai.yaml                     # Codex 侧调用描述
├── .claude/
│   ├── skills/public-company-financial-research/SKILL.md   # 同一份薄壳
│   └── settings.json                          # Stop hook，与 .codex/hooks.json 同脚本
├── apps/web/                                  # Next.js 静态站点生成器
├── research/
│   ├── companies/<company>/
│   │   ├── financials-*.json                  # 新流程四份规范产出
│   │   ├── snapshots/*.json                   # 旧流程只读存档（不再渲染）
│   │   └── *.md                               # 只读历史研究记录
│   ├── reports/                               # 专题研究和最终导出
│   └── site/                                  # 可直接打开/托管的最终 HTML
└── tests/
    └── publication.test.mjs                   # 顶层发布契约
```

研究方法论与校验器都是仓库共享资产，Codex 与 Claude Code 读同一份；两侧的 skill 只是指向 `docs/research/public-company-financial-research.md` 的薄壳。持久规则的唯一正文在根目录 `AGENTS.md`，`CLAUDE.md` 只是指向它的指针。生命周期 hook 分别配置在 `.codex/hooks.json` 与 `.claude/settings.json`，但调用的是同一个校验脚本。详见 [ADR-0012](docs/adr/0012-share-research-contract-across-agents.md)。

## 文件命名

- 港股：`hk-<4至5位代码>-<英文slug>`
- 美股：`us-<小写ticker>-<英文slug>`
- A 股：`sh|sz|bj-<6位代码>-<英文slug>`
- `<slug>` 只能使用小写 ASCII kebab-case。
- 研究产出固定四份文件名（`financials-collection/analysis/summary/final.json`），渲染层按名发现，不接受变体。
- 公司目录里的 `snapshots/`、`financials.json`、`commitments.json` 与历史 `.md` 是旧流程的只读存档，不再新增。

## 使用方法

调用 `$public-company-financial-research`，提供公司、证券代码和研究问题。skill 会执行六步流程：后台 Agent 双源采集与六维分析、评估 Agent 打分与策略、完整性校验与补全，最后发布公司分析页并更新首页。

```text
使用 $public-company-financial-research 研究网易云音乐。
重点判断订阅主导的商业模式、护城河与当前估值隐含的预期。
```

本地命令：

```bash
npm install
python3 docs/research/tools/data_validator.py check \
  --collection research/companies/<id>/financials-collection.json \
  --analysis   research/companies/<id>/financials-analysis.json \
  --summary    research/companies/<id>/financials-summary.json   # 完整性打分
python3 docs/research/tools/build_final.py --collection … --analysis … --summary … \
  --out research/companies/<id>/financials-final.json             # 合并（内置闸门）
npm run publish     # 生成 research/site
npm run verify      # 类型检查、发布契约测试、研究路径校验
```

打开 [研究站点](research/site/index.html)。HTML 使用相对资源路径，既可以离线打开，也可以部署在任意路径深度下（根路径或子路径都行），不需要改任何配置。

### 线上地址

同一份 `research/site/` 同时发布到两处，互为备份：

| 地址 | 托管 | 触发方式 |
| --- | --- | --- |
| <https://invest.owlltech.com> | Cloudflare Pages（主） | 连接仓库，push 到 `main` 自动部署 |
| <https://randylu87.github.io/airesearch/> | GitHub Pages（备） | `.github/workflows/pages.yml` |

保留两套是因为单一托管在大陆的可达性不可靠。**样式已在发布时内联进每个 HTML**（见 `apps/web/scripts/copy-output.mjs`），所以只要 HTML 到达就一定能正常显示，不会出现「有内容、没样式」。宿主层的取舍与备选方案记录在 [#11](https://github.com/RandyLu87/airesearch/issues/11)。

## Skill 参考资料

- [核心工作流](.agents/skills/public-company-financial-research/SKILL.md)
- [研究流程总纲](docs/research/public-company-financial-research.md)
- [数据源与交叉验证规范](docs/model/financial-data.md)
- [数据采集清单](docs/model/financial-model.md)

## 证据原则

1. 优先使用监管机构、交易所和公司正式披露。
2. 明确区分披露事实、可复核计算和分析推断。
3. 记录数据期间、发布日期、消息发生日、抓取时间与参考价格时间。
4. 不用第三方摘要覆盖官方数据，不用单季波动轻易推翻长期判断。
5. 缺少最新披露时，记录信息空窗、已查范围和结论限制。

## 免责声明

仓库内容仅用于研究与教育，不构成个性化投资建议。上市公司经营、市场价格和监管环境会持续变化，任何投资判断都应结合最新原始资料独立复核。
