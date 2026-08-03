# 研究契约下沉，skill 只做薄壳指针

## 状态

已接受，2026-08-03。

## 背景

`public-company-financial-research` 是唯一手写的仓库专属 skill，此前完整住在 `.agents/skills/` 下，即 Codex 的 skill 目录。Claude Code 只读 `.claude/skills/`，因此看不到它。此外 Claude Code 不自动加载 `AGENTS.md`（Codex 会），也没有 Codex 那样的 Stop hook，于是三样东西同时缺失：skill 看不见、仓库规范读不到、校验不强制。

拆开那 1155 行会发现，其中约 1065 行与调用它的 agent 毫无关系：478 行抓数脚本与接口目录、587 行方法论参考文档。真正与 skill 载体绑定的只有 90 行流程正文和 5 行 Codex 描述文件。

通用的 22 个 skill 不存在这个问题——两端各自从 mattpocock 上游拉取，内容一致。

## 决策

把与 agent 无关的内容下沉为仓库共享资产：

- 方法论参考与流程正文 → `docs/research/`
- 抓数脚本、接口目录、路径校验器 → `scripts/research/`
- 快照骨架生成器与校验器 → `packages/research-schema`，经仓库根 npm script 暴露

两端各保留一份 20 行以内的 skill 薄壳，内容仅为「执行 `docs/research/WORKFLOW.md`」加三条命令名。两份文件目前**逐字节相同** —— 两端的 frontmatter 恰好兼容，所以不需要差异。Codex 侧额外保留 `agents/openai.yaml` 作为调用描述，这是两端唯一的结构差异。新增 `CLAUDE.md` 作为指向 `AGENTS.md` 的指针，不复制正文。新增 `.claude/settings.json`，与 `.codex/hooks.json` 指向同一个校验脚本、同一套阻断契约。

两端调用的是同一条命令，不是同一份复制的脚本。

## 备选方案

**`.claude/skills/` 下做符号链接指向 `.agents/skills/`。** 字面上零漂移、改动最小。否决原因：依赖 Claude Code 能加载符号链接目录，这一点无法在不重启会话的情况下验证；更重要的是，它只解决 skill 可见性，不解决「1065 行本不该是 skill 私有资产」这个真问题——即便链接成功，方法论与脚本仍然住在某一个 agent 的私有目录里。薄壳既已缩到 20 行，共享它的收益本身也不大了。

**两份完整副本 + `npm run verify` 中比对哈希。** 无兼容性风险。否决原因：每次优化研究方法要手改两处，且 1155 行全部留在漂移面上——CI 只能告诉你两边不一致，不能替你同步。

## 后果

- 漂移面积从 1155 行降到约 20 行，且薄壳几乎永不修改，「改了一边另一边没跟上」基本不会发生。
- 即使某一端完全没装 skill，也能靠 `docs/research/WORKFLOW.md` 把研究做完；能力不再被 skill 分发机制绑架。
- 文档路径变了，README 与 AGENTS.md 中的链接需同步更新，历史提交中的路径引用会失效。
- 路径校验器改为向上搜索带 `workspaces` 的 `package.json` 来定位仓库根，不再按目录层数上溯——它已经搬过一次，层数计数会在下一次搬迁时静默失效。
