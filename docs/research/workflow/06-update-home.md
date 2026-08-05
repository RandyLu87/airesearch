# 更新首页（研究流程第 6 步）

本文件是 `docs/research/public-company-financial-research.md` 第 6 步的唯一正文。评估首页覆盖卡片是否需要因本次研究而变化：公司还没有卡片时新增一张，已有卡片时更新其时间。

- **输入**：第 5 步生成的 `research/companies/<company-id>/financials-final.json`。
- **产出**：`research/site/index.html`（由 `npm run publish` 生成，不手改）。

## 派生规则（生成器自动执行）

首页覆盖是**派生的，不做人工维护**——卡片列表由 `apps/web/app/page.tsx` 在构建时从数据文件推导：

- 有 `financials-final.json` 的公司自动获得一张卡片：代码、公司名、一句话生意本质（优先取 `businessEssence.conclusion`）、股价（带时点）、市值、数据截止，链接指向 `companies/<company-id>.html`；
- 没有 final 文件的公司不出现在首页（旧快照存档不渲染）；一个 final 都没有时首页显示空态说明。

排序规则：按各卡的数据截止日倒序，同日按公司 id 字母序，保证同一天发布的公司顺序稳定。卡片 CSS 类沿用既有样式（`report-link` / `company-card-meta` / `company-card-stance` / `company-card-facts`），样式零新增。

实现位置：`apps/web/app/page.tsx`（卡片派生与 `CompanyCard`）、`apps/web/lib/final-report.ts`（final 文件发现，与公司页共用）。

## 执行

第 5 步已经运行过 `npm run publish` 的话，首页同批已更新，本步骤只做核对；否则运行：

```bash
npm run publish
```

然后核对 `research/site/index.html`：

1. 本次研究的公司在首页有且只有一张卡；
2. 卡片时间等于本次研究的数据截止日（两管线都有产出时取较新者）；
3. 新增的分析报告卡链接可达 `companies/<company-id>.html`；
4. 其他公司的卡片未受影响。

## 完成标准

首页卡片与 `research/companies/` 下的数据文件一一对应（有快照或 final 即有卡，无则无）；本次研究公司的卡片时间正确；`npm test` 通过；`research/site/` 只由 `npm run publish` 生成。
