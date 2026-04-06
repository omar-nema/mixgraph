# Data Coverage

## Lot Radio

- **1,501 episodes** discovered and scraped (full site)
- **661 episodes (44%)** have tracklists in our data
- **840 episodes (56%)** marked as no tracklist

Lot Radio's website likely has tracklists for more episodes — the parser may be missing them due to dynamic loading or unexpected page structure.

## NTS Radio

- **84,646 episodes** in the discovered index (full NTS catalog)
- **7,000 episodes scraped (8.3%)** — the most recent 7,000
- **6,569 of those (94%)** have tracklists

The scraper is idempotent and supports `--resume`, so coverage can be expanded incrementally by running `scraper.py` with a higher `--limit` or no limit at all.

## Combined Graph

- **68,218 nodes** (unique tracks)
- **99.8% audio coverage** via enrichment (64% SC individual tracks, 33% SC DJ sets, 3% Mixcloud, <0.2% not found)
