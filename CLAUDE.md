# adjacency

Music discovery app. Scrapes DJ set tracklists from radio stations (Lot Radio, NTS), builds a track adjacency graph, and visualizes clusters in a vanilla HTML/JS frontend.

## Project structure

```
index.html              # HTML markup only (loads external CSS/JS)
css/
  desktop.css           # All desktop styles: tokens, night mode, components
  mobile.css            # All mobile styles: @media (max-width: 768px) rules
js/
  data.js               # State variables, SVG icons, glow/gradient palettes
  audio.js              # Playback engine: SC widget, Mixcloud, progress bar
  graph.js              # Cluster selection (BFS), layout engine, card/connection rendering
  mobile.js             # Mobile carousel, track selection, source pills
  filters.js            # Search indexes, autocomplete, genre/artist/DJ filter UI
  app.js                # Init, crates view, theme toggle, event wiring
  crates-worker.js      # Web Worker for crates page generation (off main thread)
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
  utils.py              # Shared normalize() for track ID generation
  output/               # combined_graph.json, audio_cache.json
plans/                  # Implementation plans and docs
  cloud-migration.md    # Plan: Cloudflare Workers + R2 API migration
sandbox/                # Frontend experiments (prototyping)
```

## Hosting

- **Frontend**: GitHub Pages (auto-deploys on push to `main`)
- **Backend**: Cloudflare Worker (`b2b-api`) for BFS cluster selection via KV store

## Commands

```bash
# Run scrapers
cd scrapers/lot-radio && python3 scraper.py
cd scrapers/nts && python3 scraper.py

# Build combined graph (both sources, defaults to both inputs)
cd pipeline && python3 graph.py

# Run audio enrichment (incremental, Ctrl-C safe)
cd pipeline && python3 enrich.py

# Extract DJ names from show titles (run after graph.py)
cd pipeline && python3 extract_dj_names.py

# Serve frontend locally
python3 -m http.server 8000
```

## Frontend

- **No build tools, no frameworks** — plain HTML/CSS/JS split across `index.html`, `css/`, and `js/`
- Uses CSS custom properties for theming (`:root` design tokens)
- Space Grotesk font via Google Fonts CDN
- SoundCloud widget API for individual tracks + DJ sets, Mixcloud widget as fallback
- Graph layout is hand-rolled (no D3) — keep it that way unless I say otherwise

## Mobile vs Desktop

- **Always test both mobile and desktop after any visual or layout change.** Resize the browser or use devtools device mode to verify nothing broke on the other side.
- **Desktop reproduction requires a real browser at >900px width.** When reproducing or verifying desktop issues, use Playwright or Chrome DevTools MCP — not the preview tool, which is too narrow for desktop layout.

## Testing frontend changes

- **Verify every frontend-facing change in Playwright after editing.** Load the local dev server in Playwright, check for console errors, and confirm the page renders correctly before presenting results to the user. Don't just rely on the preview tool — use Playwright to catch runtime JS errors.

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

## DJ name extraction

- `extract_dj_names.py` is the **last step** after rebuilding the graph — run it after `graph.py`
- It parses show title strings (e.g. "Soup To Nuts w/ Shy One") into actual DJ names (e.g. ["Shy One"])
- Output: `pipeline/output/dj_name_map.json` — mapping of `{ "show title": ["dj1", "dj2"] }`
- The pipeline does NOT depend on an LLM — extraction is pattern-based (w/, with, presents, b2b, invites)
- The frontend loads this mapping to power DJ search with clean names

## Light and Dark mode

- The app has two themes: light (default) and dark (`body.night`).
- **All colors must work in both modes.** Use CSS custom properties (`var(--bg)`, `var(--card-bg)`, `var(--text-primary)`, etc.) instead of hardcoded hex values whenever possible.
- If you must use a hardcoded color (e.g. for a specific accent), add a corresponding `body.night` override.
- Dark mode overrides live in the `body.night` block near the top of the CSS — keep them grouped there.
- **Test both modes after any visual change.** Toggle with the night mode button in the bottom-left corner.
- The accent color is `var(--connection-highlight)` — it already adapts between modes (`#B5705A` light, `#d4896e` dark).

## Dev panel

The bottom-right corner has a slider/mixer icon (`#dev-toggle`) that opens a slide-out dev panel (`#dev-panel`). This is the internal tools panel — not user-facing. It contains:

- **DJ search** — search DJs by name with autocomplete
- **Artist search** — search artists by name with autocomplete
- **Cluster controls** — current cluster ID (click to copy), freeze button, manual cluster ID input
- **Cluster limits** — R1 max and R2 per R1 dropdowns (control BFS depth)
- **Source filter** — filter by audio source (SoundCloud, Mixcloud, etc.)
- **Helpers** — toggle helper text toasts
- **Gradient art** — sliders for warp, frequency, blur, grain, saturate, hue shift

When adding experimental/debug features (font switchers, layout toggles, debug info), **put them in the dev panel** as a new section with an `<h4>` heading — don't create floating overlays or separate UI.

## Style preferences

- Keep things simple — this is a personal project, not production
- Prefer inline solutions over new files/abstractions
- No TypeScript, no bundlers, no package.json for the frontend
- When editing frontend files, preserve the existing CSS token system and code organization
- CSS is split: `css/desktop.css` for desktop, `css/mobile.css` for mobile — keep them separate
- JS is split by concern: `data.js` → `audio.js` → `graph.js` → `mobile.js` → `filters.js` → `app.js` (load order matters)
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
