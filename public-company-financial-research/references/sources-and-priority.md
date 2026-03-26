# Sources and Priority

## Source Priority

1. Regulator filings (highest)
- US: SEC EDGAR (10-K, 10-Q, 8-K, 20-F, 6-K, DEF 14A)
- Other markets: local exchange/regulator filing systems

2. Company investor relations
- Earnings press releases
- Earnings presentation decks
- Earnings call transcripts (official if provided)

3. Audited reports and notes
- Annual report, management discussion, notes to statements

4. Secondary aggregators (cross-check only)
- Use only to accelerate lookup or validate extraction
- Never override official filings with aggregator values

## Verification Protocol

1. Confirm document identity
- Company legal entity name
- Filing type
- Period end date
- Filing/release date

2. Confirm numeric integrity
- Check units and currency
- Check consolidated vs segment values
- Check basic vs diluted EPS

3. Detect restatements
- Look for amended filings (e.g., 10-K/A, 10-Q/A)
- Replace superseded data and annotate the change

4. Handle conflicting values
- Prefer regulator filing values
- If IR presentation differs from filing, report both and explain likely cause

## Minimum Source Log Fields

- source_type
- document_title
- period_end_date
- filing_or_publish_date
- url
- fields_extracted
- notes
