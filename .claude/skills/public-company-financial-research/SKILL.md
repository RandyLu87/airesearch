---
name: public-company-financial-research
description: 上市公司长期价值调研，以商业模式、核心驱动和最新变化为主线。Use when 首次研究或更新港股、美股、A股公司，解读财报与公告，追踪公司特定 KPI，判断投资逻辑变化，或形成长期投资建议。
---

# 上市公司价值调研

研究流程、数据源登记、指标与估值方法、快照契约全部保存在仓库内，两端共用一份：

**执行 `docs/research/WORKFLOW.md`，逐步完成其中 0–7 步。**

三条命令构成主链路：

```bash
npm run snapshot:new   -- <company-id>          # 从上一份快照继承口径，生成骨架
npm run snapshot:check -- <snapshot-path>       # 待办哨兵 → schema → 跨快照可比性
npm run publish                                 # 从已校验快照生成 HTML
```

规范产出是 `research/companies/<company>/snapshots/YYYY-MM-DD-HHMM-analysis.json`，不是 Markdown，也不是手写 HTML。仓库的命名与目录规范见 `AGENTS.md`。
