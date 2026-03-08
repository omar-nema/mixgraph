# NTS Radio Scraper — Implementation Plan

## Goal

Scrape NTS Radio (nts.live) for DJ sets with tracklists, producing the same adjacency graph data structure as the Lot Radio scraper. NTS is ~165x larger (84,646 episodes, ~1.6M tracks projected vs Lot Radio's 9,665 tracks).

## Research Findings

- NTS has a **public REST API** at `nts.live/api/v2/` — no authentication required
- Tracklist coverage is **~90%** (vs Lot Radio's 34%), averaging ~21 tracks per episode
- The `/api/v2/shows` endpoint has an **offset cap at 1000** (only 1,008 of 1,675 shows reachable via pagination)
- **Sitemaps** (`sitemap1.xml.gz`, `sitemap2.xml.gz`) contain all 1,675 shows and all 84,646 episode URLs — this is our discovery source
- API handles 100+ req/sec but we'll self-limit to ~5 req/sec to be respectful
- No browser, no HTML parsing, no Selenium needed — pure HTTP + JSON

## API Endpoints

| Endpoint | Purpose | Auth |
|----------|---------|------|
| `GET /sitemap1.xml.gz` | Discovery: all show + episode URLs | None |
| `GET /sitemap2.xml.gz` | Discovery: remaining episode URLs | None |
| `GET /api/v2/shows/{show_slug}` | Show metadata (description, genres, moods, location) | None |
| `GET /api/v2/shows/{show}/episodes/{ep}` | Episode metadata (broadcast date, genres, location, DJ name) | None |
| `GET /api/v2/shows/{show}/episodes/{ep}/tracklist` | Tracklist: artist, title, uid, offset/duration estimates | None |

### Tracklist Response Shape
```json
{
  "metadata": { "resultset": { "count": 23, "offset": 0, "limit": 23 } },
  "results": [
    {
      "artist": "Bossman Dlow Feat. Sexyy Red",
      "title": "Come Here (Lord Unknown Rework)",
      "uid": "5cd6b2f1-...",
      "offset": null,
      "duration": null,
      "offset_estimate": 158,
      "duration_estimate": 150
    }
  ]
}
```

### Episode Response Shape (key fields)
```json
{
  "name": "150 Session - Günter Schickert Tribute",
  "episode_alias": "150session-17th-january-2026",
  "show_alias": "150session",
  "broadcast": "2026-01-17T15:00:00+00:00",
  "genres": [{ "id": "genres-rock-krautrock", "value": "Krautrock" }],
  "location_long": "Berlin",
  "location_short": "BLN",
  "moods": [{ "id": "moods-dwam", "value": "Dwam" }],
  "mixcloud": "https://www.mixcloud.com/NTSRadio/...",
  "audio_sources": [{ "url": "https://soundcloud.com/...", "source": "soundcloud" }]
}
```

## Architecture

Same 3-phase pipeline as the Lot Radio scraper, adapted for NTS's clean API:

```
Phase 1: Discovery       Phase 2: Scraping           Phase 3: Graph
(sitemap parsing)        (API fetch per episode)      (reuse existing code)
     │                        │                            │
     ▼                        ▼                            ▼
 sitemaps ──► episode     episode ──► metadata         episodes ──► adjacencies
              index       + tracklist fetch                        + graph.json
```

### File Structure
```
nts-scraper/
├── discover.py       # Phase 1: parse sitemaps, output episode index
├── scraper.py        # Phase 2: orchestrator, fetches metadata + tracklists
├── parse.py          # Phase 2: parse API JSON into our episode schema
├── adjacency.py      # Phase 3: symlink/copy from lot-radio-scraper (identical logic)
├── graph.py          # Phase 3: symlink/copy from lot-radio-scraper (identical logic)
├── requirements.txt
└── output/
    ├── nts_episode_index.json      # Phase 1 output: all (show, episode) pairs
    ├── nts_episodes.json           # Phase 2 output: episodes with tracklists
    ├── nts_adjacencies.json        # Phase 3 output: track pairs
    ├── nts_graph.json              # Phase 3 output: BFS-ready graph
    └── nts_stats.json              # Phase 3 output: summary statistics
```

## Phase 1: Discovery (`discover.py`)

Parse NTS sitemaps to extract all episode URLs.

**Input:** `https://www.nts.live/sitemap1.xml.gz`, `sitemap2.xml.gz`

**Logic:**
1. Fetch both gzipped sitemaps via HTTP
2. Regex extract all episode URLs matching `nts.live/shows/{show}/episodes/{episode}`
3. Deduplicate by `(show_alias, episode_alias)` tuple
4. Save as JSON array to `output/nts_episode_index.json`

**Output schema:**
```json
[
  { "show_alias": "150session", "episode_alias": "150session-17th-january-2026" },
  ...
]
```

**Expected result:** ~84,646 entries. Fast — just 2 HTTP requests + parsing.

## Phase 2: Scraping (`scraper.py` + `parse.py`)

Fetch metadata and tracklist for each episode via API.

**For each episode in the index:**
1. `GET /api/v2/shows/{show}/episodes/{ep}` — episode metadata
2. `GET /api/v2/shows/{show}/episodes/{ep}/tracklist` — track list

These two requests can be made concurrently per episode.

**Rate limiting:**
- 5 concurrent requests (asyncio semaphore)
- 0.2s delay between batches
- 3 retries with exponential backoff (1s, 2s, 4s)
- ~5 req/sec effective throughput

**At 5 req/sec, ~84K episodes x 2 requests each = ~34K seconds ≈ 9.4 hours.**
We can increase to 10-20 req/sec if needed (API tolerates it), bringing it to ~2-5 hours.

**Idempotent operation:**
- Load existing `nts_episodes.json` on start
- Skip episodes already scraped
- Save progress every 500 episodes
- CLI flag `--resume` to continue interrupted runs

**Normalized episode schema (matches Lot Radio format):**
```json
{
  "url": "https://www.nts.live/shows/150session/episodes/150session-17th-january-2026",
  "source": "nts",
  "show_alias": "150session",
  "episode_alias": "150session-17th-january-2026",
  "artist_name": "150 Session",
  "date": "2026-01-17",
  "genres": ["Krautrock", "Experimental", "Industrial"],
  "location": "Berlin",
  "description": "...",
  "tracklist": [
    { "title": "Palaver", "artist": "Günter Schickert", "position": 1 },
    { "title": "Untitled", "artist": "Air India", "position": 2 }
  ],
  "track_count": 33,
  "mixcloud_url": "https://www.mixcloud.com/NTSRadio/...",
  "nts_moods": ["Dwam"]
}
```

**Key differences from Lot Radio parse.py:**
- No HTML parsing — everything comes from JSON API
- Artist name comes from `episode.name` (show name / DJ name)
- Date comes from `episode.broadcast` (ISO format, just take the date part)
- Genres come pre-structured as `[{id, value}]` — just extract `value`
- Tracklist comes from separate `/tracklist` endpoint (not embedded in page HTML)

## Phase 3: Adjacency + Graph Generation

**Reuse `adjacency.py` and `graph.py` from lot-radio-scraper verbatim.** The episode schema is intentionally normalized to match, so the same code generates:
- `nts_adjacencies.json` — consecutive track pairs
- `nts_graph.json` — bidirectional BFS graph with normalized track IDs (`artist:::title`)
- `nts_stats.json` — summary statistics

If we later want a **merged graph** across both Lot Radio and NTS, we just concatenate the episode lists and rebuild.

## Projected Dataset

| Metric | Lot Radio | NTS (est.) | Combined |
|--------|-----------|------------|----------|
| Episodes | 1,501 | 84,646 | 86,147 |
| With tracklist | 509 (34%) | ~76,181 (90%) | ~76,690 |
| Total tracks | 9,665 | ~1,585,693 | ~1,595,358 |
| Unique tracks (est.) | 9,475 | ~500K+ | ~500K+ |
| Adjacency pairs | 9,156 | ~1,509,512 | ~1,518,668 |
| Graph edges | 18,124 | ~3M+ | ~3M+ |

## CLI Interface

```bash
# Full run (all 3 phases)
python3 scraper.py

# Discovery only
python3 discover.py

# Skip discovery, use existing index
python3 scraper.py --skip-discovery

# Resume interrupted scrape
python3 scraper.py --resume

# Test with small subset
python3 scraper.py --test 100

# Skip adjacency/graph generation
python3 scraper.py --skip-adjacency

# Increase concurrency (default 5)
python3 scraper.py --concurrency 10
```

## Dependencies

Same as Lot Radio scraper (no new deps needed):
```
httpx[socks]>=0.27.0    # async HTTP client
```

No `beautifulsoup4` or `lxml` needed — no HTML parsing.

## Risk & Mitigations

| Risk | Mitigation |
|------|------------|
| API rate limiting kicks in | Self-limit to 5 req/sec; exponential backoff on 429s |
| Sitemap format changes | Regex is simple; easy to update |
| API response shape changes | Validate required fields; log + skip malformed episodes |
| 9+ hour runtime for full scrape | Idempotent resume; save progress every 500 eps |
| Large output files (graph could be 500MB+) | Consider chunked writes; gzip output option |
