# adjacency

Music discovery app. Scrapes DJ set tracklists from radio stations (Lot Radio, NTS), builds a track adjacency graph, and visualizes clusters in a vanilla HTML/JS frontend.

## Project structure

```
index.html              # Single-file vanilla HTML/CSS/JS app (project root)
web-app/
  output/               # Static data files (combined_graph.json, audio_cache.json)
scrapers/
  lot-radio/            # Lot Radio scraper
    discover.py         # Episode URL discovery
    scraper.py          # Main scrape orchestrator
    parse.py            # Episode page parser
    adjacency.py        # Generates adjacency pairs
    output/             # lot_radio_episodes.json, etc.
  nts/                  # NTS scraper
    discover.py         # Episode URL discovery
    scraper.py          # Main scrape orchestrator
    parse.py            # Episode page parser
    output/             # nts_episodes.json, etc.
pipeline/               # Data processing (shared across sources)
  graph.py              # Builds adjacency graph from episode JSONs
  enrich.py             # Audio enrichment: SC track -> SC set -> Mixcloud
  cluster.py            # Cluster selection + SoundCloud search functions
  output/               # combined_graph.json, audio_cache.json
plans/                  # Implementation plans and docs
sandbox/                # Frontend experiments (prototyping)
```

## Commands

```bash
# Run scrapers
cd scrapers/lot-radio && python3 scraper.py
cd scrapers/nts && python3 scraper.py

# Build combined graph (both sources, defaults to both inputs)
cd pipeline && python3 graph.py

# Run audio enrichment (incremental, Ctrl-C safe)
cd pipeline && python3 enrich.py

# Serve frontend locally
python3 -m http.server 8000
```

## Frontend

- **No build tools, no frameworks** — plain HTML/CSS/JS in a single file (`index.html`)
- Uses CSS custom properties for theming (`:root` design tokens)
- Space Grotesk font via Google Fonts CDN
- SoundCloud widget API for individual tracks + DJ sets, Mixcloud widget as fallback
- Graph layout is hand-rolled (no D3) — keep it that way unless I say otherwise

## Backend (Python scrapers)

- Python 3 with httpx, beautifulsoup4, lxml
- Rate limit: max 2 req/s — be respectful to community radio sites
- Scrapers are idempotent (skip already-scraped episodes)
- Don't touch existing output JSON files unless re-running a pipeline

## Audio enrichment

- Waterfall: SoundCloud individual track -> SoundCloud DJ set -> Mixcloud set (NO Deezer)
- NTS sets on 4 SC accounts: NTS Latest, NTS 2024-2025, NTS 2023, NTS 2020
- Lot Radio sets on `soundcloud.com/thelotradio`
- enrich.py is incremental, crash-safe, saves every 500 tracks

## Style preferences

- Keep things simple — this is a personal project, not production
- Prefer inline solutions over new files/abstractions
- No TypeScript, no bundlers, no package.json for the frontend
- When editing index.html, preserve the existing CSS token system and code organization
- Concise comments only where logic isn't obvious
- **Use flexbox for layout** — never use absolute positioning for standard UI elements like toolbars, navs, or button groups. Reserve absolute positioning for overlays, tooltips, and things that genuinely need to escape the flow

## Sandbox

`sandbox/` is for experimenting with frontend concepts (layouts, effects, interactions). When asked, port working experiments from sandbox into `index.html`.

## Long-running tasks

- **Run caffeinated** — wrap long-running commands with `caffeinate` (e.g., `caffeinate -dims python3 scraper.py`) so the machine stays awake if I step away or the lid closes
- **Progress updates every 30 minutes** — for any task that runs longer than a few minutes, post a status update every ~30 minutes with progress so far, estimated remaining work, and any issues hit

## Workflow habits

- **Document decisions** — when a meaningful architectural decision or strategic change is made, update the relevant docs (plans/, instructions.md, or this file) so there's a record
- **Keep things organized** — new files go in the right folder, not the root. Group related work together
- **Periodic cleanup** — on new session startup, glance at the codebase for stale code, unused files, or outdated plans. Flag anything worth removing or consolidating
- **Auto-commit meaningful work** — after completing a substantial change (new feature, significant refactor, new scraper pipeline, etc.), commit and push to GitHub. Skip commits for tiny tweaks, config edits, or mid-task WIP
