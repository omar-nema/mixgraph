# Lot Radio Scraper

Scrapes DJ sets and tracklists from [The Lot Radio](https://thelotradio.com) and outputs structured JSON data for a music recommendation engine based on track adjacency.

## Quick Start

```bash
cd lot-radio-scraper

# Install dependencies
pip install -r requirements.txt

# Full scrape (discovery + scraping + adjacency generation)
python scraper.py

# Test with 10 episodes first
python scraper.py --test 10

# Run phases separately
python discover.py                           # Phase 1: discover all episode URLs
python scraper.py --skip-discovery           # Phase 2: scrape episodes (uses existing URLs)
python adjacency.py                          # Phase 3: generate adjacency pairs
```

## How It Works

### Phase 1: Discovery (`discover.py`)

The Lot Radio's Index page (`/the-index`) uses a Next.js Server Action to load episodes. The scraper calls this endpoint directly:

- **Endpoint**: `POST https://www.thelotradio.com/the-index`
- **Key header**: `next-action: <action-id>` (a 40-char hex hash tied to the site's deployment)
- **Accept header**: `text/x-component`
- **Payload**: `[{"limit": 16, "skip": 0, "order": "date:desc", ...}]`
- **Response format**: RSC flight data — multiple lines, with episode JSON on the line starting with `1:`

The scraper paginates through all ~1,500 episodes and extracts metadata: artist name, date, genres, location, show name, and episode URL.

### Phase 2: Scraping (`parse.py`)

Each episode page is fetched via plain HTTP (no headless browser needed — the site is server-rendered). Metadata like artist name, description, and location is parsed from the rendered HTML using BeautifulSoup.

**Tracklist extraction** is the tricky part. The tracklist data is NOT in rendered HTML elements (`<ul>`, `<li>`, etc.) — it's embedded as escaped JSON in the RSC (React Server Components) flight data stream within inline `<script>` tags. The format in the raw HTML looks like:

```
\"tracks\":[{\"name\":\"Track Title\",\"artist\":\"Artist Name\",\"timestamp\":121490}]
```

The scraper finds this pattern by searching the raw HTML for the `\"tracks\"` keyword with the correct surrounding escape characters, extracts the JSON array, unescapes it, and parses it. Timestamps are in milliseconds and get converted to `HH:MM:SS` format.

### Phase 3: Adjacency (`adjacency.py`)

Generates consecutive track pairs from each tracklist. For a set with N tracks, produces N-1 adjacency pairs — the core signal for the recommendation engine.

## Output Files

All output goes to the `output/` directory:

| File | Description |
|------|-------------|
| `lot_radio_episodes.json` | All episodes with tracklists |
| `lot_radio_adjacencies.json` | Consecutive track pairs |
| `lot_radio_stats.json` | Summary statistics |
| `episode_urls.json` | Discovered episode URLs/metadata (intermediate) |

## Configuration

The scraper respects The Lot Radio's servers:
- **Rate limit**: Max 2 requests/second
- **Retries**: 3 attempts with exponential backoff
- **Idempotent**: Re-runs skip already-scraped episodes
- **Progress saves**: Intermediate results saved every 50 episodes

## Troubleshooting

**Discovery fails with HTTP errors**: The `next-action` header ID (`c0ac6b5...`) is tied to the site's deployment. If the site has been redeployed, this ID will have changed. To find the new one:
1. Open `thelotradio.com/the-index` in Chrome
2. Open DevTools → Network tab
3. Scroll or interact with the page to trigger a load
4. Find the POST request to `/the-index` with `Accept: text/x-component`
5. Copy the `next-action` header value
6. Update `DEFAULT_NEXT_ACTION` in `discover.py`

**No tracklists found**: If the site changes its RSC serialization format, the tracklist extraction pattern in `parse.py` (`parse_tracklist()`) may need updating. The key assumption is that track data appears as `\"tracks\":[...]` with backslash-escaped quotes in the HTML source.

## Results from initial scrape (Feb 2026)

- 1,501 episodes scraped
- 509 episodes with tracklists (33.9%)
- 9,665 total tracks
- 9,156 adjacency pairs
- 7,388 unique artists
- Top genres: House (185), Techno (162), Electronica (86), Ambient (84)
