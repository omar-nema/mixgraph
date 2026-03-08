# Lot Radio Scraper — Spec for Claude Code

## Goal

Build a scraper that collects all DJ sets with tracklists from The Lot Radio (thelotradio.com) and outputs structured JSON data. This data will feed a music recommendation engine that uses DJ set adjacency (tracks played next to each other) as its core signal.

## Background

The Lot Radio is a Brooklyn-based internet radio station. Their website archives DJ sets, many with timestamped tracklists. The site is built on Contentful CMS (images hosted on `images.ctfassets.net`) with a JavaScript frontend. The Index page at `thelotradio.com/the-index` lists ~1,501 sessions, but content loads dynamically via JS — static HTML fetches return an empty shell.

Individual episode pages at URLs like `thelotradio.com/shows/{show-name}/{YYYY-MM-DD-HHMM}` DO render tracklist data in the HTML.

## Architecture

### Phase 1: Discover all episode URLs

The Index page (`/the-index`) loads episodes dynamically. You need to find how the frontend fetches episode data. Likely approaches, in order of preference:

1. **Contentful API**: The site uses Contentful. Check if there's a publicly accessible Contentful Delivery API being called. Inspect the site's JS bundle or network requests for a Contentful space ID and access token. If found, you can query their API directly for all episode entries — this is the ideal path.
2. **Internal API / Next.js data routes**: The site may expose API routes (e.g., `/_next/data/...` or `/api/...`) that return JSON. Check the network tab when the Index page loads.
3. **Sitemap**: Check `thelotradio.com/sitemap.xml` for a full list of episode URLs.
4. **Crawl the Shows page**: `thelotradio.com/shows` lists all show series. Each show page (e.g., `/shows/sorry-records`) lists individual episodes with links like `/shows/sorry-records/2025-10-13-2200`. Crawl show pages → collect episode URLs.
5. **Headless browser on Index page**: As a last resort, use Playwright or Puppeteer to load `/the-index`, scroll through all 1,501 results, and collect episode URLs.

Start with approach 1 — check for a Contentful API. Then fall through to the others.

### Phase 2: Scrape each episode page

For each episode URL, fetch the page and extract structured data. The HTML structure (observed from real pages) looks like this:

**Episode with tracklist** (e.g., Flying Lotus 01.22.2026):
```
# Flying Lotus

- 01.22.2026
- Experimental Electronic, House, Techno
- The Lot Radio, NYC

### The session
Flying Lotus' debut Lot Radio set...

### Tracklist
- 00:01:36  B.B.E. (Big Booty Express)  Jay Dee & J Dilla
- 00:03:08  Black Heaven  Flying Lotus
- 00:05:11  Gooie  Wu-Lu
...
```

**Episode without tracklist** (e.g., DJ Sundae 09.20.2025):
- The tracklist section is simply absent from the HTML, or shows "Sorry…No tracklist provided"

### What to extract per episode

| Field | Source | Required |
|-------|--------|----------|
| `episode_url` | The page URL | Yes |
| `artist_name` | The `<h1>` on the episode page (the DJ/artist name) | Yes |
| `date` | The date field (format: `MM.DD.YYYY`) | Yes |
| `genres` | Comma-separated genre tags | Yes |
| `location` | e.g., "The Lot Radio, NYC" | Yes |
| `description` | "The session" text block | No |
| `show_name` | The show series name, extracted from the URL path (e.g., "special-guests", "sorry-records") | Yes |
| `has_tracklist` | Boolean — whether a tracklist was found | Yes |
| `tracklist` | Ordered array of track objects (see below) | Only if present |

### Track object schema

Each track in the tracklist array:

```json
{
  "position": 1,
  "timestamp": "00:01:36",
  "title": "B.B.E. (Big Booty Express)",
  "artist": "Jay Dee & J Dilla"
}
```

- `position`: 1-indexed order in the set (this is the critical field for adjacency)
- `timestamp`: The timestamp string as-is from the page (e.g., "00:01:36"). May be null if the episode has a tracklist but no timestamps.
- `title`: Track title
- `artist`: Artist name(s) as displayed

## Output Format

### Primary output: `lot_radio_episodes.json`

A JSON array of episode objects:

```json
[
  {
    "episode_url": "https://www.thelotradio.com/shows/special-guests/2026-01-22-1600",
    "artist_name": "Flying Lotus",
    "date": "2026-01-22",
    "genres": ["Experimental Electronic", "House", "Techno"],
    "location": "The Lot Radio, NYC",
    "description": "Flying Lotus' debut Lot Radio set, exploring experimental sounds and perhaps some new music as well.",
    "show_name": "special-guests",
    "has_tracklist": true,
    "tracklist": [
      {
        "position": 1,
        "timestamp": "00:01:36",
        "title": "B.B.E. (Big Booty Express)",
        "artist": "Jay Dee & J Dilla"
      },
      {
        "position": 2,
        "timestamp": "00:03:08",
        "title": "Black Heaven",
        "artist": "Flying Lotus"
      }
    ]
  },
  {
    "episode_url": "https://www.thelotradio.com/shows/special-guests/2025-09-20-1500",
    "artist_name": "DJ Sundae",
    "date": "2025-09-20",
    "genres": ["Electro", "Indie", "Experimental", "Folk", "Dub"],
    "location": "The Lot Radio, NYC",
    "description": "DJ Sundae from Paris, France (NTS, Idle Press, Efficient Space)",
    "show_name": "special-guests",
    "has_tracklist": false,
    "tracklist": []
  }
]
```

### Secondary output: `lot_radio_adjacencies.json`

A derived file that extracts all track adjacency pairs from the tracklists. This is the core data for the recommendation engine.

```json
[
  {
    "track_a": {
      "title": "B.B.E. (Big Booty Express)",
      "artist": "Jay Dee & J Dilla"
    },
    "track_b": {
      "title": "Black Heaven",
      "artist": "Flying Lotus"
    },
    "episode_url": "https://www.thelotradio.com/shows/special-guests/2026-01-22-1600",
    "dj": "Flying Lotus",
    "position_a": 1,
    "position_b": 2
  }
]
```

Each entry represents two tracks that were played consecutively. For a tracklist of N tracks, there are N-1 adjacency pairs.

### Stats output: `lot_radio_stats.json`

Summary statistics for sanity-checking:

```json
{
  "total_episodes_found": 1501,
  "episodes_with_tracklist": 823,
  "episodes_without_tracklist": 678,
  "total_tracks": 12450,
  "total_adjacency_pairs": 11627,
  "unique_artists": 4200,
  "unique_tracks": 9800,
  "scrape_date": "2026-02-07",
  "errors": [
    {
      "url": "https://www.thelotradio.com/shows/...",
      "error": "Timeout after 10s"
    }
  ]
}
```

## Technical Requirements

- **Language**: Python 3
- **HTTP client**: `httpx` or `requests` with retry logic (3 retries, exponential backoff)
- **HTML parsing**: `beautifulsoup4` with `lxml` parser
- **Headless browser** (if needed for discovery): `playwright`
- **Rate limiting**: Maximum 2 requests per second. Be respectful — this is a community radio station, not a megacorp.
- **Error handling**: Log and skip failed pages, don't crash the whole run. Collect errors in the stats output.
- **Idempotency**: If the scraper is re-run, it should be able to skip already-scraped episodes (check by URL in existing output file).
- **Progress**: Print progress to stdout (e.g., "Scraped 150/1501 episodes, 89 with tracklists")

## Date Normalization

Input dates on the site are formatted as `MM.DD.YYYY` (e.g., "01.22.2026"). Normalize to ISO format `YYYY-MM-DD` in the output.

## Edge Cases to Handle

1. **No tracklist**: Set `has_tracklist: false`, `tracklist: []`
2. **Tracklist without timestamps**: Some episodes may list tracks without timestamps. Still capture them with `timestamp: null`.
3. **Multiple artists on a single episode**: Some episodes are b2b sets (e.g., "Beatrice b2b Raeza"). Capture the full name as-is in `artist_name`.
4. **Remix/feature notation**: Track titles may include "(Remix)", "feat.", etc. Capture as-is, don't try to parse these.
5. **Missing fields**: If genre, location, or description are missing, use `null`.
6. **Duplicate episodes**: Deduplicate by URL.

## Directory Structure

```
lot-radio-scraper/
├── scraper.py          # Main scraper script
├── discover.py         # Episode URL discovery (Phase 1)
├── parse.py            # Episode page parser (Phase 2)
├── adjacency.py        # Generates adjacency pairs from episodes
├── requirements.txt
├── README.md
├── output/
│   ├── lot_radio_episodes.json
│   ├── lot_radio_adjacencies.json
│   └── lot_radio_stats.json
└── logs/
    └── scrape.log
```

## Running

```bash
# Install dependencies
pip install -r requirements.txt

# Run full scrape
python scraper.py

# Or run phases separately:
python discover.py          # Outputs episode_urls.json
python scraper.py --urls episode_urls.json  # Scrapes from URL list
python adjacency.py         # Generates adjacencies from episodes.json
```

## What Success Looks Like

- 1000+ episodes scraped
- 500+ episodes with tracklists (based on the "Sorry…No tracklist provided" pattern, probably ~50-60% have tracklists)
- Clean JSON output with no parsing artifacts
- Adjacency file ready to be loaded into a graph database or queried for recommendations