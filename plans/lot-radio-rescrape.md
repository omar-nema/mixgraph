# Plan: Recover Missing Lot Radio Tracklists

## Current state

- 1,501 episodes scraped, 661 have tracklists (44%)
- ~840 episodes without tracklists

## Breakdown of missing tracklists

1. **Parser bug with escaped quotes** — FIXED in `parse.py:258`. The RSC flight data double-escapes quotes inside track names (e.g. `12"` → `12\\\\"`). The fix uses a placeholder to preserve structural vs content quotes.

2. **No tracklist on site (~694 episodes)** — genuinely missing, DJ never submitted one. Nothing to do.

3. **Tracklist added after initial scrape (~49+ episodes)** — a re-scrape will pick these up.

## Remaining work

Add a `--rescrape-missing` flag to `scrapers/lot-radio/scraper.py` that re-fetches episodes where `has_tracklist == false`. Currently the scraper skips already-scraped episodes, so these never get retried.

After re-scraping:
1. Rebuild graph: `cd pipeline && python3 graph.py`
2. Re-run enrichment: `cd pipeline && python3 enrich.py`

## Expected outcome

- ~50-100 additional episodes recovered
- Final coverage: ~750/1501 episodes with tracklists (~50%)
