# Research Snapshot 契约

新研究的规范产出是 JSON `Research Snapshot`，不是 Markdown 或手写 HTML。最终可执行定义以仓库 `packages/research-schema/src/index.ts` 的 Zod schema 为准；修改字段时先改 schema 和测试，再改本文件。

## 路径与生命周期

```text
research/companies/<company-id>/snapshots/YYYY-MM-DD-HHMM-analysis.json
```

- 时间采用 Asia/Shanghai，`snapshot.id` 必须等于文件名去掉 `.json`。
- `company.id` 必须等于公司目录名。
- 同一公司同一天只有一份 snapshot；日内补充直接更新它。
- 公司目录根部已有的 `.md` 仅作历史迁移输入，保留但不继续追加。
- JSON 是事实来源；`npm run publish` 负责生成 HTML，禁止反向从 HTML 修补 JSON。

## 顶层结构

```json
{
  "schemaVersion": "1.0.0",
  "company": {},
  "snapshot": {},
  "summary": {},
  "standardMetrics": [],
  "driverMetrics": [],
  "thesisChange": {},
  "financialHistory": [],
  "sections": [],
  "valuation": {},
  "risks": [],
  "viewChanges": {},
  "checkpoints": [],
  "evidence": [],
  "disclaimer": "本报告仅作研究与教育用途，不构成个性化投资建议。"
}
```

## 必填语义

### `company` 与 `snapshot`

- `company`：规范 ID、公司名、法定名、ticker、市场、报告币种、会计准则。
- `snapshot.createdAt`：研究快照创建时间；`dataCutoff`：本次消息与数据截止时间。均使用带时区 ISO 8601。
- `snapshot.sourceNote`：从历史 Markdown 迁移时指向公司目录内的原文件；没有历史文件时可写本次研究过程保留的输入记录文件名。

### `summary`

必须一眼回答：当前立场与确信度、一句话商业模式、商业模式变化等级、带时点的参考价格、合理价值区间、安全边际、最强证据、最大风险和下一验证条件。

`businessModelChange` 只能是：`未变`、`参数变化`、`机制变化`、`结构性变化`。

### `standardMetrics`

用于跨公司或跨快照的严格比较。每个 observation 必须记录：

- 稳定 `metricId`、`definitionVersion`、期间、期间类型、会计基础；
- `reported`、`calculated` 或 `unavailable` 状态；
- 数值使用十进制字符串，禁止二进制浮点写回；
- 币种、单位、scale、precision 与 evidence IDs；
- 缺失时省略 `value` 并填写 `reason`，禁止用 0 伪装缺失。

只有定义版本、币种、单位、scale、期间类型和会计基础全部兼容时，生成器才可计算 delta；否则显示“不可比较”及原因。

### `driverMetrics`

选择 5–8 个真正促使商业模式运转的公司特定指标，而不是通用 KPI 清单。每项必须包含：

- 定义和因果作用；
- 属性：增长、盈利、现金、护城河或治理；
- 最新期间、展示值、趋势、置信度和证据；
- 下一报告期的可证伪阈值。

### `thesisChange`

分别说明投资逻辑、财务质量、治理和估值相对上一快照如何变化，并列出本次新增证据和已被替换的旧假设。没有变化也必须明确写“未变”及理由。

### `financialHistory`、`sections` 与 `valuation`

- `financialHistory` 至少两个年度，尽可能覆盖五年；收入和净利润使用亿元十进制字符串，缺失现金流字段直接省略。
- `sections` 负责完整的商业模式、竞争、财务质量、组织研发、治理等论证。每节包含结论性摘要、证据要点和 evidence IDs。
- `valuation.scenarios` 必须恰好包含熊市、基准和牛市，各自写明商业模式假设、盈利/FCF、估值方法、价值区间和触发条件。
- `actionZones` 是条件化操作区间，不能只给目标价而没有触发行为。

### `evidence`

每条证据必须标记：

- `fact`：原始披露或直接可观察数据；
- `calculation`：使用已披露输入可复算的结果；
- `inference`：分析判断或区间估算。

同时保存标题、发布者、报告期/事件日、发布日期、抓取时间、直接 URL 和必要的口径限制。驱动指标和章节必须通过 `evidenceIds` 引用这些记录。

## 发布与验收

完成 JSON 后依次运行：

```bash
python3 .codex/hooks/validate_research_paths.py
npm run publish
npm run verify
```

验收结果必须包括公司主页、所有日期报告、本地字体/样式/脚本、内联 SVG 决策图表、两快照可比性说明，以及与源 JSON 匹配的 SHA-256。HTML 必须能通过文件系统直接打开，不依赖 CDN、NestJS、数据库或 Next.js 客户端运行时。
