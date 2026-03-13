# Plan: Scrape Remaining Lot Radio Tracklists

## Current state

- 1,501 episodes scraped, but only 509 have tracklists (34%)
- 992 episodes marked `has_tracklist: false`

## Root cause

The missing tracklists break down into three categories:

### 1. Parser bug with escaped quotes (~248 episodes)
The RSC (React Server Components) flight data double-escapes quote characters inside track names. For example, vinyl inch marks like `12"` appear as `12\\\\"` in the RSC stream.

The current parser (`parse.py:259`) does:
```python
cleaned = raw_array.replace('\\"', '"').replace("\\'", "'")
```

This replaces ALL `\"` with `"`, including structural JSON delimiters, producing broken JSON. Tracks like `Nah Skin Up (12" Mix)` or `$ki Mask "The Slump God"` cause the entire tracklist to fail.

**Fix:** Handle double-escaped quotes before single-escaped ones:
```python
cleaned = raw_array.replace('\\\\"', '\uFFFD').replace('\\"', '"').replace('\uFFFD', '\\"').replace("\\'", "'")
```

### 2. No tracklist on site (~694 episodes)
These episodes genuinely have no `"tracks"` field in the RSC data — the DJ never submitted a tracklist. Nothing to do here.

### 3. Tracklist added after initial scrape (~49 episodes)
Episodes that now have tracklist data on the site but didn't when first scraped. A re-scrape will pick these up.

## Steps

1. **Fix the JSON unescaping bug** in `scrapers/lot-radio/parse.py:259`
   - Replace the naive `replace('\\"', '"')` with escape-aware unescaping
   - Test against a known-failing episode (e.g. one with `12"` in a track name)

2. **Re-scrape episodes missing tracklists**
   - The scraper is idempotent but skips already-scraped episodes
   - Need to either: (a) add a `--rescrape-missing` flag that re-fetches episodes where `has_tracklist == false`, or (b) remove the 992 no-tracklist episodes from the output JSON so the scraper treats them as unscraped
   - Option (a) is cleaner

3. **Rebuild the graph** — run `pipeline/graph.py` to incorporate newly extracted tracklists

4. **Re-run enrichment** — `pipeline/enrich.py` will incrementally pick up new tracks

## Expected outcome

- ~248 episodes recovered from the parser fix
- ~49 episodes recovered from re-scraping (tracklists added since last run)
- ~694 episodes will remain without tracklists (genuinely missing from the site)
- Final coverage: ~806/1501 episodes with tracklists (54%), up from 34%
