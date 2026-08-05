# 渲染网站（研究流程第 5 步）

本文件是 `docs/research/public-company-financial-research.md` 第 5 步的唯一正文。把三份校验通过的落盘文件合并为最终 JSON，再由站点生成器渲染成 HTML。样式完全复用 `research/site/assets/research.css` 的既有类，不新增样式。

- **输入**：第 4 步校验通过的三份文件（统一命名，见下）。
- **中间产物**：`research/companies/<company-id>/financials-final.json`（`docs/model/financials—final-template.json` 契约）。
- **产出**：`research/site/companies/<company-id>.html`。

## 文件命名约定

前三步的落盘文件与本步骤产物统一用以下文件名（渲染层按名发现，不接受变体）：

| 步骤 | 文件 |
|------|------|
| 第 1 步·采集 | `research/companies/<company-id>/financials-collection.json` |
| 第 2 步·分析 | `research/companies/<company-id>/financials-analysis.json` |
| 第 3 步·总结 | `research/companies/<company-id>/financials-summary.json` |
| 第 5 步·合并 | `research/companies/<company-id>/financials-final.json` |

## 1. 生成最终 JSON

```bash
python3 docs/research/tools/build_final.py \
  --collection research/companies/<company-id>/financials-collection.json \
  --analysis   research/companies/<company-id>/financials-analysis.json \
  --summary    research/companies/<company-id>/financials-summary.json \
  --out        research/companies/<company-id>/financials-final.json
```

合并脚本内部复用 `data_validator.py` 重新校验三份输入：**任一低于阈值（默认 7 分）拒绝生成**，回到第 4 步补全；三份文件的 `meta.companyId` 不一致同样拒绝。校验闸门只在这里，渲染层无条件信任 `financials-final.json`。最终 JSON 原样嵌入三份产出（`collection` / `analysis` / `summary` 三个子树），并在 `meta.validation` 记录三份得分与校验时间——页面上「数据完整性」一格由此而来。**这份文件由脚本生成，不手写。**

## 2. 渲染 HTML

```bash
npm run publish
```

站点生成器（`apps/web`）会自动发现每个带 `financials-final.json` 的公司目录，渲染出 `research/site/companies/<company-id>.html`。页面结构与最终 JSON 一一对应：

1. 页头与摘要条：公司名、一句话生意本质；市值、股价（带时点）、PE、三份文件完整性得分、数据截止；
2. 维度总结与信心度（第 3 步产出）：六张卡片，各带结论、0–10 信心度与打分依据；
3. 策略建议（第 3 步产出）：空仓者 / 持仓者建议与触发条件，卖出信号 / 加仓信号清单，逐条带观察方式与依据；
4. 六个分析维度（第 2 步产出）：生意本质（收入结构表、5 年盈利趋势表）、护城河五类验证表、失败路径与空方论点、管理层关键决策复盘表、行业与长期趋势、估值（倍数表、三情景、同行对比表）——每个维度末尾渲染追问与回答、缺口清单；
5. 尾注：三份来源文件路径、校验阈值与生成时间、免责声明。

渲染规则：字段缺失或 `unavailable` 时如实显示原因，不用 0 或空字符串代替；双源校验对象显示数值并带误差标记（✅ / ⚠️ / ❌）；证据与来源渲染为可点击链接。

实现位置：`apps/web/app/companies/[company]/page.tsx`（公司页即分析页，站点只渲染新管线产出）。仓库里没有任何 `financials-final.json` 时，构建用哨兵参数 `__no-analysis__` 占位（Next `output: export` 不接受空静态参数表），`copy-output.mjs` 在拷贝阶段删除哨兵页，不会进入 `research/site/`。

## 3. 验证

- `npm run typecheck`、`npm test` 通过；
- 不要手改 `research/site/`——它只能由 `npm run publish` 生成；
- `python3 scripts/research/validate_research_paths.py` 通过。

## 完成标准

`financials-final.json` 由 `build_final.py` 生成且记录了三份得分；`npm run publish` 产出 `research/site/companies/<company-id>.html`；页面十个区块齐全、样式为既有 `research.css`、缺失字段显示原因而非空白；`npm test` 全部通过。
