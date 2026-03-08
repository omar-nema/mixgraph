# adjacency

Music discovery app. Scrapes DJ set tracklists from radio stations (Lot Radio, NTS), builds a track adjacency graph, and visualizes clusters in a vanilla HTML/JS frontend.

## Project structure

```
lot-radio-scraper/   # Lot Radio pipeline + frontend
  discover.py        # Episode URL discovery
  scraper.py         # Main scrape orchestrator
  parse.py           # Episode page parser
  adjacency.py       # Generates adjacency pairs
  graph.py           # Builds the graph from adjacencies
  enrich.py          # Deezer art/preview enrichment
  cluster.py         # Cluster selection logic
  index.html         # Frontend — single-file vanilla HTML/CSS/JS
  output/            # JSON data (graph, cache, episodes)
nts-scraper/         # NTS pipeline (same pattern)
combined-dataset/    # Merged graph across all sources
```

## Commands

```bash
# Run scrapers
cd lot-radio-scraper && python3 scraper.py
cd nts-scraper && python3 scraper.py

# Serve frontend locally
cd lot-radio-scraper && python3 -m http.server 8000
```

## Frontend

- **No build tools, no frameworks** — plain HTML/CSS/JS in a single file (`index.html`)
- Uses CSS custom properties for theming (`:root` design tokens)
- DM Mono font via Google Fonts CDN
- SoundCloud widget API + HTML5 `<audio>` for playback
- Graph layout is hand-rolled (no D3) — keep it that way unless I say otherwise

## Backend (Python scrapers)

- Python 3 with httpx, beautifulsoup4, lxml
- Rate limit: max 2 req/s — be respectful to community radio sites
- Scrapers are idempotent (skip already-scraped episodes)
- Don't touch existing output JSON files unless re-running a pipeline

## Style preferences

- Keep things simple — this is a personal project, not production
- Prefer inline solutions over new files/abstractions
- No TypeScript, no bundlers, no package.json for the frontend
- When editing index.html, preserve the existing CSS token system and code organization
- Concise comments only where logic isn't obvious

## Workflow habits

- **Document decisions** — when a meaningful architectural decision or strategic change is made, update the relevant docs (plans/, instructions.md, or this file) so there's a record
- **Keep things organized** — new files go in the right folder, not the root. Group related work together
- **Periodic cleanup** — on new session startup, glance at the codebase for stale code, unused files, or outdated plans. Flag anything worth removing or consolidating
- **Auto-commit meaningful work** — after completing a substantial change (new feature, significant refactor, new scraper pipeline, etc.), commit and push to GitHub. Skip commits for tiny tweaks, config edits, or mid-task WIP
