# Repository guidance

## Purpose

Maintain evidence-based, long-term research on public companies. Treat the core business model and its operating drivers as the main analytical thread.

## Repository layout

- Use `.agents/skills/public-company-financial-research/` for the repo-scoped Codex research skill.
- Store company research in `research/companies/<market>-<ticker>-<slug>/`.
- Store polished thematic reports and final exports in `research/reports/<topic>/`.
- Keep disposable generation, rendering, review screenshots, caches, and smoke-test files under `tmp/`; do not commit them.

## Research workflow

- Use `$public-company-financial-research` for new company research and updates.
- Read the latest existing company note before adding a new update.
- Verify current filings, announcements, material company news, industry changes, and the reference share price each time.
- Preserve the distinction between disclosed facts, reproducible calculations, and analytical inferences.
- Prefer relative links for files inside this repository and direct source URLs for external evidence.

## File conventions

- Store every company note at `research/companies/<company-dir>/<analysis-file>`; never create company research at the repository root or under another directory.
- Name Hong Kong company directories `hk-<4-to-5-digit-code>-<company-slug>`.
- Name US company directories `us-<lowercase-ticker>-<company-slug>`; remove punctuation from the ticker.
- Name A-share company directories `sh-<6-digit-code>-<company-slug>`, `sz-<6-digit-code>-<company-slug>`, or `bj-<6-digit-code>-<company-slug>`.
- Write `<company-slug>` in lowercase ASCII kebab-case. Do not use spaces, Chinese characters, underscores, parentheses, or suffixes such as `new`, `final`, or `v2`.
- Name every research note exactly `YYYY-MM-DD-HHMM-analysis.md`, using Asia/Shanghai creation time in 24-hour format.
- Keep only one research file per company per calendar day. Append later same-day updates to the existing file instead of creating another timestamped version.
- Never invent a different filename. Before finishing any research task, run `python3 .codex/hooks/validate_research_paths.py` and fix every reported violation without asking the user.
- Keep only the current final report source and useful final export; remove superseded exports and intermediate text conversions.
- Do not commit `.DS_Store`, caches, smoke-test files, rendered review images, or other disposable artifacts.

## Validation

- After changing the research skill, run the skill creator's `quick_validate.py` against `.agents/skills/public-company-financial-research/`.
- Run `python3 .codex/hooks/validate_research_paths.py` after creating, renaming, or moving company research.
- Before handing off structural changes, run `git diff --check` and verify that all README links resolve.
