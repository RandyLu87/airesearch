---
name: public-company-financial-research
description: Research latest and historical financial reports of publicly listed companies for investment analysis. Use when the task involves SEC/annual/quarterly filings, earnings releases, investor presentations, restatements, multi-year trend analysis, valuation inputs, or risk assessment based on official financial statements and disclosures.
---

# Public Company Financial Research

## Overview

Produce evidence-based analysis of listed companies using official filings first, then supplement with trusted secondary data. Always separate facts, calculations, and inferences.

## Workflow

1. Define scope before collecting data.
- Identify ticker, exchange, reporting standard (US GAAP or IFRS), period range, and currency.
- Confirm whether the user needs latest quarter, trailing twelve months, annual history, or all.

2. Collect sources with strict priority.
- First priority: regulator filings and company investor-relations pages.
- Second priority: exchange disclosures and audited annual reports.
- Third priority: reputable market data vendors for cross-checking only.
- For source details and ordering rules, read `references/sources-and-priority.md`.

3. Build a normalized financial table.
- Capture revenue, gross profit, operating income, net income, EPS, operating cash flow, capex, free cash flow, debt, cash, shares outstanding, and segment mix.
- Normalize units (thousand/million/billion), currency, and fiscal calendar differences.
- Mark restated values explicitly; never mix original and restated numbers silently.
- Produce a required annual core-metrics comparison table (minimum 3 fiscal years; prefer 5 years when available) before writing narrative analysis.

4. Analyze latest results and historical trend.
- Latest: compare reported results with prior year period and prior quarter if relevant.
- History: analyze at least 5 years (or all available) of growth, margins, cash conversion, leverage, dilution, and cyclicality.
- Use the output structure in `references/analysis-template.md`.

5. Test quality and risk signals.
- Run red-flag checks for earnings quality, one-off adjustments, working-capital stress, refinancing pressure, and guidance credibility.
- Use `references/red-flags.md` to score risks.

6. Produce decision-oriented output.
- Provide a concise investment view: bull/base/bear cases, key assumptions, catalysts, and invalidation conditions.
- Include a source table with date, document name, and link.
- Clearly label each statement as: Fact, Calculation, or Inference.
- Keep "Latest Period Snapshot" and "Historical Trend" in tables, not prose.
- Add a dedicated "Annual Core Metrics Comparison" table with year-over-year deltas.

## Rules

- Verify “latest” data with live browsing before answering. Do not rely on stale memory.
- If filing dates conflict across sources, prefer regulator or exchange documents and explain discrepancy.
- Use absolute dates (YYYY-MM-DD) for filing date, period end date, and earnings release date.
- Distinguish non-GAAP from GAAP/IFRS and reconcile when possible.
- Avoid investment advice language that implies certainty; state assumptions and uncertainty.
- Annual core-data comparison must be a markdown table; prose-only annual comparison is not acceptable.
- Annual core-data comparison table must include: Fiscal Year, Revenue, YoY Revenue Growth, Gross Margin, Operating Income, Operating Margin, Net Income, Diluted EPS, Operating Cash Flow, Free Cash Flow, Net Debt (or Net Cash), Diluted Shares.
- If a required field is unavailable for a year, fill with `N/A` and explain in notes.
- For multi-currency disclosures, present reporting currency in the table and show converted values only in separate optional columns.

## Output Contract

Return sections in this exact order:

1. Company and Coverage Scope
2. Source Log (official first)
3. Latest Period Snapshot
4. Annual Core Metrics Comparison (multi-year table, required)
5. Quality and Risk Checks
6. Scenario View (bull/base/bear)
7. Key Monitoring Items (next earnings, debt maturities, guidance, regulatory events)

Use compact tables where possible.
Section 4 is mandatory and must be a table (minimum 3 fiscal years).

## References

- Source selection and verification: `references/sources-and-priority.md`
- Reusable analysis structure: `references/analysis-template.md`
- Risk diagnostics checklist: `references/red-flags.md`
