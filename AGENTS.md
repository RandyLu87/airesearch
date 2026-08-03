# Repository guidance

## Purpose

Maintain evidence-based, long-term research on public companies. Treat the core business model and its operating drivers as the main analytical thread.

## Repository layout

- Follow `docs/research/WORKFLOW.md` for company research; the skills under `.agents/skills/` and `.claude/skills/` are thin pointers to it.
- Keep shared research assets in `docs/research/` (methodology, snapshot contract) and `scripts/research/` (data fetching, validation).
- Store canonical JSON snapshots in `research/companies/<market>-<ticker>-<slug>/snapshots/`.
- Store each company's financial period ledger at `research/companies/<company-dir>/financials.json`; fetch reported periods once and reuse them.
- Publish generated company pages and dated HTML reports to `research/site/`; commit this final static output.
- Store polished thematic reports and final exports in `research/reports/<topic>/`.
- Keep disposable generation, rendering, review screenshots, caches, and smoke-test files under `tmp/`; do not commit them.

## Research workflow

- Use `$public-company-financial-research` for new company research and updates.
- Read the latest canonical JSON snapshot and any retained legacy note before adding a new update.
- Verify current filings, announcements, material company news, industry changes, and the reference share price each time.
- Preserve the distinction between disclosed facts, reproducible calculations, and analytical inferences.
- Prefer relative links for files inside this repository and direct source URLs for external evidence.

## File conventions

- Store every canonical snapshot at `research/companies/<company-dir>/snapshots/<analysis-file>`; never create company research at the repository root or under another directory.
- Name Hong Kong company directories `hk-<4-to-5-digit-code>-<company-slug>`.
- Name US company directories `us-<lowercase-ticker>-<company-slug>`; remove punctuation from the ticker.
- Name A-share company directories `sh-<6-digit-code>-<company-slug>`, `sz-<6-digit-code>-<company-slug>`, or `bj-<6-digit-code>-<company-slug>`.
- Write `<company-slug>` in lowercase ASCII kebab-case. Do not use spaces, Chinese characters, underscores, parentheses, or suffixes such as `new`, `final`, or `v2`.
- Name every canonical snapshot exactly `YYYY-MM-DD-HHMM-analysis.json`, using Asia/Shanghai creation time in 24-hour format.
- Keep only one canonical snapshot per company per calendar day. Update the same JSON snapshot for later same-day work instead of creating another timestamped version.
- Treat root-level `YYYY-MM-DD-HHMM-analysis.md` files inside an existing company directory as read-only legacy notes. New research must not use Markdown as its canonical output.
- Generate a new snapshot with `npm run snapshot:new -- <company-id>`; it inherits calibration from the previous snapshot and materialises `financialHistory` from the ledger so the two stay comparable.
- Never hand-write `financialHistory` or any engine-computed valuation field. Run `npm run snapshot:sync -- <snapshot-path>` instead; the checker rejects hand edits.
- Every company directory that holds snapshots must also hold `financials.json` covering at least the last two fiscal years.
- Author new snapshots against `schemaVersion` 1.1.0. Snapshots already published as 1.0.0 stay untouched.
- Never drop, add, or recalibrate a driver metric without recording it in `thesisChange.driverChanges`.
- Generate HTML only through `npm run publish`; never hand-edit `research/site/`.
- Never invent a different filename. Before finishing any research task, run `python3 scripts/research/validate_research_paths.py` and fix every reported violation without asking the user.
- Keep only the current final report source and useful final export; remove superseded exports and intermediate text conversions.
- Do not commit `.DS_Store`, caches, smoke-test files, rendered review images, or other disposable artifacts.

## Validation

- Change research methodology in `docs/research/`, never in a skill shell; both agents read the same files.
- Run `npm run snapshot:sync -- <snapshot-path>` after editing the ledger or any valuation component, then `npm run snapshot:check -- <snapshot-path>` while authoring, and `npm run snapshot:check -- --all` before finishing.
- Run `python3 scripts/research/validate_research_paths.py` after creating, renaming, or moving company research.
- Run `npm run verify` after changing snapshots, schemas, report components, styles, or publishing logic.
- Before handing off structural changes, run `git diff --check` and verify that all README links resolve.

## Agent skills

### Issue tracker

Issues and PRDs live in this repository's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical triage roles mapped to the repository's GitHub labels. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses a single domain context in `CONTEXT.md` with decisions under `docs/adr/`. See `docs/agents/domain.md`.
