# Cloud Migration Plan: Cloudflare Workers + R2

Move from serving a 110MB JSON file to the browser to a Cloudflare Worker API that runs
the graph logic server-side. A local Node server mirrors the same API so you can develop
and test without deploying.

---

## 1. Problem

The app currently loads two large files on startup:
- `web-app/output/combined_graph.json` — 126,720 nodes, ~110MB
- `web-app/output/audio_cache.json` — 126,719 entries

All graph logic (BFS, filtering, weighted random, index building) runs in the browser
against that in-memory dataset. Cold start is painfully slow on slow connections and
mobile. The crates Web Worker (`js/crates-worker.js`) fetches both files a second time
on its own.

---

## 2. Architecture Overview

```
┌─────────────────────────────────┐
│  Frontend (unchanged HTML/CSS)  │
│                                 │
│  js/api.js  ←─ BASE_URL toggle  │
│    ↓                            │
│  fetch(BASE_URL + endpoint)     │
└─────────────┬───────────────────┘
              │
    ┌─────────┴──────────┐
    │                    │
    ▼                    ▼
Cloudflare Worker    Local Node server
(production)         (development)
    │                    │
    ▼                    │
 R2 bucket               ▼
 combined_graph.json  pipeline/output/*.json
 audio_cache.json     (reads directly from disk)
 dj_name_map.json
    │                    │
    └────────┬───────────┘
             ▼
    shared/graph-logic.js
    (BFS, filtering, weighted random, index building)
```

**Key principle**: `shared/graph-logic.js` is written once and `require()`d / imported
by both the Worker and the local server. Zero duplication of graph logic.

---

## 3. What Moves Server-Side vs. What Stays Client-Side

### Moves to server

| Current location | Function | Why |
|---|---|---|
| `graph.js:79` | `selectCluster()` | BFS over full graph — needs graph in memory |
| `graph.js:12` | `getNeighbors()`, `getEdgeContext()`, `collectDjs()` | Used by selectCluster |
| `graph.js:53` | `enrichFromCache()` | Needs audio cache |
| `app.js:129` | `getFilteredPool()` | Needs full candidate list + indexes |
| `app.js:160` | `weightedPick()` | Needs candidate weights |
| `app.js:179` | `shuffle()` — pool selection logic | Needs pool |
| `app.js:244` | Candidate computation (2+ edges, no mixcloud) | Needs full graph |
| `app.js:261` | Genre rebalancing weight computation | Needs full graph |
| `filters.js:23` | `initFilters()` — building `artistIndex`, `djIndex`, `episodeIndex` | Needs full graph |
| `crates-worker.js:53` | `generateClusters()`, `cratesBfs()` | BFS over full graph |
| `crates-worker.js:81` | `cratesTreemap()` | Can stay client or move — pure math |

### Stays client-side

| Function | Reason |
|---|---|
| `computeLayout()` (`graph.js:393`) | Needs DOM measurements (`el.offsetHeight`) |
| `renderCards()`, `renderConnections()` (`graph.js:232,352`) | DOM rendering |
| `setupHovers()` (`graph.js:373`) | DOM event wiring |
| `showCluster()` (`app.js:1`) | Layout + render orchestration |
| All of `audio.js` | SoundCloud/Mixcloud widget playback |
| All of `mobile.js` | Mobile carousel, DOM rendering |
| Filter UI state (`searchFilters`, `djSearchFilters`, `genreFilters` etc. in `data.js`) | Client-side filter pill state |
| `shuffleHistory` (`data.js:16`) | Client-side dedup set — send as `exclude[]` param to shuffle |
| Theme toggle, help modal, hash navigation | Purely UI |
| `generateGradient()`, `glowPalettes` (`data.js`) | Visual, no graph data needed |

---

## 4. Shared Graph Logic Module

**File**: `shared/graph-logic.js` (plain CommonJS / ESM dual export)

```js
// Exported functions:

export function buildCandidates(graphNodes, audioCache) {
  // Current logic from app.js:244-253
  // Returns: { candidates: string[], candidateWeights: Float64Array, idxMap: Map }
}

export function buildIndexes(graphNodes, djNameMap) {
  // Current logic from filters.js:23-92
  // Returns: { artistIndex, djIndex, episodeIndex, artistListAlpha, djListAlpha }
}

export function buildGenreList(graphNodes) {
  // Current logic from filters.js:95-106
  // Returns: [{ name, count }] sorted by count desc
}

export function getFilteredPool(graphNodes, audioCache, candidates, filters) {
  // filters = { source, artists, djs, genres }
  // Current logic from app.js:129-153
  // Returns: string[] of node IDs
}

export function weightedPickFromPool(pool, candidateWeights, idxMap) {
  // Current logic from app.js:160-177
  // Returns: string (node ID)
}

export function selectCluster(graphNodes, audioCache, rootId, r1Limit = 4, r2Limit = 1) {
  // Current logic from graph.js:79-153
  // Returns: { meta, nodes, edges }
}

export function splitArtists(raw) {
  // Current logic from filters.js:5-21
}
```

**Usage in Worker**:
```js
import { selectCluster, getFilteredPool, buildCandidates } from '../shared/graph-logic.js';
```

**Usage in local Node server**:
```js
const { selectCluster, getFilteredPool, buildCandidates } = require('../shared/graph-logic');
```

---

## 5. API Contract

All endpoints return JSON. Errors return `{ error: string }` with appropriate HTTP status.

### `GET /api/shuffle`

Pick a random track and return its full cluster.

**Query params**:
- `source` — `none` | `soundcloud` | `soundcloud_set` | `lotradio` (default: `none`)
- `genres` — comma-separated genre names, e.g. `Soul,Jazz`
- `artists` — comma-separated artist names (url-encoded)
- `djs` — comma-separated DJ names (url-encoded)
- `exclude` — comma-separated root IDs to skip (client's `shuffleHistory`)
- `r1` — integer, default 4
- `r2` — integer, default 1

**Response**: same shape as `selectCluster()` output
```json
{
  "meta": {
    "root_id": "artist:::title",
    "found": 12,
    "not_found": 2,
    "totalR1": 8,
    "r1Shown": 4,
    "expandLevel": 0
  },
  "nodes": [
    {
      "id": "root",
      "graphId": "four tet:::baby",
      "rank": "root",
      "title": "Baby",
      "artist": "Four Tet",
      "djs": [{ "name": "Shy One", "episodeUrl": "https://..." }],
      "source": "soundcloud",
      "scTrackUrl": "https://soundcloud.com/...",
      "artUrl": "https://i1.sndcdn.com/...",
      "setUrl": null,
      "setSource": null,
      "setOffsetSec": null,
      "setDj": null
    }
  ],
  "edges": [
    {
      "from": "root",
      "to": "r1_0",
      "context": { "dj": "Shy One", "episodeUrl": "https://...", "date": "2023-04-01" }
    }
  ]
}
```

### `GET /api/cluster/:id`

Load cluster for a specific root ID (URL-encoded).

**Query params**: `r1` (default 4), `r2` (default 1), `expand` (0/1/2 for show-more levels)

**Response**: same shape as `/api/shuffle`

### `GET /api/search/artists`

Artist autocomplete.

**Query params**: `q` (search string), `limit` (default 20)

**Response**:
```json
[
  { "display": "Four Tet", "trackCount": 342, "clusterCount": 89 }
]
```

### `GET /api/search/djs`

DJ autocomplete.

**Query params**: `q`, `limit` (default 20)

**Response**:
```json
[
  { "display": "Shy One", "trackCount": 156, "clusterCount": 40 }
]
```

### `GET /api/genres`

Top genres list (replaces client-side genre index building).

**Response**:
```json
[
  { "name": "Soul", "count": 4821 },
  { "name": "Jazz", "count": 3102 }
]
```

### `GET /api/crates`

Generate a page of crates clusters (replaces `crates-worker.js`).

**Query params**:
- `seed` — integer seed for deterministic shuffle
- `page` — page number (0-indexed)
- `count` — clusters per page (default 12)
- `vw`, `vh` — viewport dimensions for treemap layout
- `pad` — treemap padding (default 8)

**Response**:
```json
{
  "clusters": [
    {
      "seedKey": "four tet:::baby",
      "label": "Four Tet",
      "title": "Baby",
      "artist": "Four Tet",
      "count": 23,
      "artworks": ["https://i1.sndcdn.com/...", "..."],
      "artKeys": ["four tet:::baby", "..."],
      "memberKeys": ["..."],
      "weight": 18,
      "rect": { "x": 8, "y": 8, "w": 400, "h": 300 }
    }
  ],
  "hasMore": true
}
```

---

## 6. Frontend Data Layer: `js/api.js`

New file. Single source of truth for the base URL. All data fetches go through this module.

```js
// js/api.js

// Toggle: set to local Node server URL for development, Worker URL for production
const API_BASE = 'http://localhost:3001';   // local
// const API_BASE = 'https://b2b.workers.dev'; // cloud

async function apiFetch(path, params = {}) {
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`API ${path} failed: ${resp.status}`);
  return resp.json();
}

export async function shuffleCluster(filters = {}) {
  return apiFetch('/api/shuffle', filters);
}

export async function loadCluster(id, { r1 = 4, r2 = 1, expand = 0 } = {}) {
  return apiFetch(`/api/cluster/${encodeURIComponent(id)}`, { r1, r2, expand });
}

export async function searchArtists(q, limit = 20) {
  return apiFetch('/api/search/artists', { q, limit });
}

export async function searchDjs(q, limit = 20) {
  return apiFetch('/api/search/djs', { q, limit });
}

export async function getGenres() {
  return apiFetch('/api/genres');
}

export async function getCratesPage(seed, page, count, vw, vh, pad = 8) {
  return apiFetch('/api/crates', { seed, page, count, vw, vh, pad });
}
```

**`app.js` changes** (minimal):
- `shuffle()` calls `api.shuffleCluster({ source, genres, artists, djs, exclude: [...shuffleHistory] })` — receives a complete cluster, passes directly to `showCluster()`
- `loadClusterById(id)` calls `api.loadCluster(id)` — same
- Remove: `getFilteredPool()`, `weightedPick()`, `matchesFilter()`, candidate computation, graph fetch from `DOMContentLoaded`
- Remove: `graphNodes`, `audioCache`, `candidates`, `candidateWeights` global state
- Keep: `shuffleHistory` (local dedup)

**`filters.js` changes**:
- `initFilters()` no longer builds indexes from local data — instead the genre pills and autocomplete call `api.getGenres()` / `api.searchArtists()` / `api.searchDjs()`
- All filter state (which pills are selected) stays client-side
- `getFilteredPool()` and `getFilteredPoolSize()` become API calls with current filter state

**`crates-worker.js` changes**:
- Worker no longer fetches the full JSON files itself
- Instead: `postMessage({ type: 'request', page, count, vw, vh, seed })` triggers a call to `api.getCratesPage()`
- The treemap layout still happens in the worker (pure math, no graph data needed)
- Or: move the crates worker to just do treemap layout client-side, everything else from API

---

## 7. Server-Side Implementation

### 7a. Local Node Server

**File**: `server/local-server.js`

```js
// Node 18+, zero dependencies (uses built-in http)
// Or use express for convenience — single file, no bundler

const express = require('express');   // or native http
const fs = require('fs');
const path = require('path');
const { buildCandidates, buildIndexes, buildGenreList,
        getFilteredPool, weightedPickFromPool, selectCluster,
        generateClusters, cratesTreemap } = require('../shared/graph-logic');

// Load all data on startup (fine for local dev — it's your own machine)
const graphData = JSON.parse(fs.readFileSync('../pipeline/output/combined_graph.json'));
const audioCache = JSON.parse(fs.readFileSync('../pipeline/output/audio_cache.json'));
const djNameMap = JSON.parse(fs.readFileSync('../pipeline/output/dj_name_map.json'));

const graphNodes = graphData.nodes;
const { candidates, candidateWeights, idxMap } = buildCandidates(graphNodes, audioCache);
const { artistListAlpha, djListAlpha } = buildIndexes(graphNodes, djNameMap);
const genreList = buildGenreList(graphNodes);

const app = express();
app.use(cors());  // allow localhost:8000

// Wire all api endpoints to shared logic functions
// ...

app.listen(3001);
```

Startup time: a few seconds to parse ~110MB JSON. That's fine for local dev. No changes needed
after startup; it's a read-only server.

### 7b. Cloudflare Worker

**File**: `worker/index.js`

The hard part: the graph is too large for a standard Worker's memory budget. Two options:

**Option A: Durable Object as graph cache** (recommended)

```
Worker (stateless, handles HTTP routing)
  → calls GraphDO.fetch(request) for data operations

GraphDO (Durable Object, persistent isolate)
  → lazy-loads graph from R2 on first request
  → holds graphNodes, audioCache, indexes in memory
  → handles BFS, filtering, search
```

The DO is a persistent V8 isolate that survives across requests. Its memory limit is ~128MB
per isolate. The graph JSON is ~110MB uncompressed; compressed it's ~15-20MB. The DO loads
and decompresses it once per warm period (~30 mins of inactivity resets it).

Cold start latency on DO wake: ~2-5s (R2 fetch + JSON parse). Subsequent requests: ~1-10ms.

**Option B: Pre-compute everything** (simpler, faster, less flexible)

Run all filtering offline and store pre-computed results in R2:
- `candidates.json` — list of valid root IDs + weights (small, ~2MB)
- `artist-index.json` — artist search index (~5MB)
- `dj-index.json` — DJ search index (~2MB)
- `genres.json` — genre list (~1KB)
- `nodes/{first-two-chars}.json` — graph nodes sharded by ID prefix (26 files × ~4MB each)

Shuffle: Worker loads `candidates.json` (small) + picks random ID + loads the relevant
node shard to run BFS. Each BFS needs ~3 node lookups max (root, r1, r2 neighbors) so
at most ~3 shard fetches. But R2 has ~1-10ms latency per fetch — 3 fetches ≈ 3-30ms.

Trade-off: Option A is simpler code (logic runs against in-memory graph just like now),
but has a cold start problem. Option B avoids cold starts but requires more data design
work and the shard-fetch approach adds per-request R2 latency.

**Recommended**: Start with Option A (DO). The cold start only affects the very first
request after 30 mins of idle — acceptable for a personal project. If cold starts become
annoying, add a warmup cron that pings the API every 25 minutes.

---

## 8. R2 Storage Format

Bucket: `b2b-graph-data`

```
b2b-graph-data/
  combined_graph.json.gz    # gzip-compressed graph (~15-20MB)
  audio_cache.json.gz       # gzip-compressed cache (~8-12MB)
  dj_name_map.json          # small, no compression needed
```

The DO loads and decompresses these on wake. `DecompressionStream` is available in
Workers — no library needed:
```js
const raw = await r2.get('combined_graph.json.gz');
const ds = new DecompressionStream('gzip');
const decompressed = await new Response(raw.body.pipeThrough(ds)).json();
```

---

## 9. Pipeline Changes

Add a deploy step after the normal pipeline run. No changes to `graph.py`, `enrich.py`,
or `extract_dj_names.py`.

**New file**: `pipeline/deploy_to_r2.sh`

```bash
#!/bin/bash
set -e
cd "$(dirname "$0")"

echo "Compressing graph..."
gzip -k -f output/combined_graph.json    # creates combined_graph.json.gz
gzip -k -f output/audio_cache.json

echo "Uploading to R2..."
npx wrangler r2 object put b2b-graph-data/combined_graph.json.gz \
  --file output/combined_graph.json.gz --content-encoding gzip
npx wrangler r2 object put b2b-graph-data/audio_cache.json.gz \
  --file output/audio_cache.json.gz --content-encoding gzip
npx wrangler r2 object put b2b-graph-data/dj_name_map.json \
  --file output/dj_name_map.json

echo "Deployed. Pinging Worker to warm DO..."
curl -s https://b2b.workers.dev/api/genres > /dev/null
echo "Done."
```

Full pipeline run after a scrape:
```bash
cd pipeline
caffeinate -dims python3 graph.py
caffeinate -dims python3 enrich.py
python3 extract_dj_names.py
./deploy_to_r2.sh
```

---

## 10. `genreWeightCaps` and Candidate Computation

Currently in `data.js:20-25`:
```js
const genreWeightCaps = { 'Ambient': 20, 'Folk': 5, 'Soul': 15, 'Indie Rock': 14 };
```

This config needs to live server-side (in `shared/graph-logic.js` or a config file).
The server computes weights once at startup; the client never sees them. The client only
sends genre filter params; the server handles weighting internally.

Candidate criteria (currently `app.js:244-253`):
- 2+ edges
- Not a Mixcloud-only node
- No Mixcloud-only neighbors

---

## 11. URL Hash Navigation

Currently `app.js` puts the root track ID in the hash: `#four tet:::baby`.
This should continue working — when the page loads with a hash, `loadClusterById()` calls
`api.loadCluster(id)` which is just a GET to `/api/cluster/:id`.

Share links remain valid. No change to URL scheme.

---

## 12. Crates Mode

`crates-worker.js` currently fetches both JSON files independently (second full download).
With the API:
1. Worker calls `api.getCratesPage(seed, page, count, vw, vh)` via `fetch()`
2. Server runs `generateClusters()` + `cratesTreemap()` and returns the page
3. Client worker just receives the page and renders it — no BFS in browser

The Worker file becomes much simpler — mostly just message passing. The treemap layout
can stay client-side (it's fast pure math with no graph data) or move server-side for
simplicity. Moving it server-side means passing `vw`/`vh` to the API which is slightly
awkward if the user resizes, but treemap rects are only used for initial layout so this
is fine.

---

## 13. How the Local/Cloud Toggle Works

In `js/api.js`:
```js
// Change this one line to switch environments:
const API_BASE = window.location.hostname === 'localhost'
  ? 'http://localhost:3001'
  : 'https://b2b.workers.dev';
```

Or make it explicit with a build-time `?dev=1` query param. The auto-detect
`hostname === 'localhost'` approach requires zero manual switching.

The local Node server and the Worker share `shared/graph-logic.js` exactly — any bug fix
or behavior change applies to both automatically.

---

## 14. Migration Steps (in order)

Do these one at a time. Each step is independently testable.

**Step 1: Extract shared logic module**
- Create `shared/graph-logic.js`
- Copy `selectCluster`, `getNeighbors`, `getEdgeContext`, `collectDjs`, `enrichFromCache`,
  `getFilteredPool`, `weightedPickFromPool`, `buildCandidates`, `buildGenreList`,
  `buildIndexes`, `splitArtists` into it
- Write the module to work with passed-in data (not global vars)
- No changes to frontend yet — just extraction + unit tests

**Step 2: Local Node server**
- Create `server/local-server.js` using `shared/graph-logic.js`
- Load JSONs from `pipeline/output/`
- Wire all API endpoints
- Test with curl/browser: `curl http://localhost:3001/api/genres`

**Step 3: `js/api.js` + frontend plumbing**
- Create `js/api.js` with `BASE_URL` auto-detect + all endpoint functions
- Wire `app.js`: replace `shuffle()` body with `api.shuffleCluster(...)` call,
  replace `loadClusterById()` with `api.loadCluster(id)` call
- The rest of `showCluster()`, `computeLayout()`, `renderCards()` is unchanged
- Remove global `graphNodes`, `audioCache`, `candidates`, `candidateWeights` from `data.js`
- Remove the JSON fetch block from `DOMContentLoaded` in `app.js`
- Test: open `index.html` with local server running

**Step 4: Filters + autocomplete**
- Replace `initFilters()` index-building with API calls
- `getGenres()` → populate genre pills
- `searchArtists(q)` → feed desktop + mobile autocomplete
- `searchDjs(q)` → feed DJ autocomplete
- `getFilteredPoolSize()` → call `/api/shuffle?...` with `countOnly=1` or store count
  in shuffle response `meta.poolSize`
- Test filter UX end-to-end

**Step 5: Crates mode**
- Replace `crates-worker.js` BFS + `initFromUrls()` with `api.getCratesPage()` call
- Keep treemap layout in worker or move to server (decide based on complexity)
- Test crates view

**Step 6: Cloudflare Worker**
- Create `worker/index.js` + `wrangler.toml`
- Implement `GraphDO` Durable Object that loads from R2 and exposes same API
- Test locally with `wrangler dev`
- Deploy: `wrangler deploy`
- Flip `API_BASE` auto-detect

**Step 7: R2 deploy script**
- Write `pipeline/deploy_to_r2.sh`
- Do first production deploy
- Test on live domain

---

## 15. What Stays Exactly the Same

- All scrapers (`scrapers/lot-radio/`, `scrapers/nts/`)
- `pipeline/graph.py`, `pipeline/enrich.py`, `pipeline/extract_dj_names.py`
- `pipeline/utils.py` — `normalize()` and track ID format (`artist:::title`)
- All rendering code in `graph.js` (`renderCards`, `renderConnections`, `computeLayout`)
- All audio playback in `audio.js`
- All mobile layout in `mobile.js`
- Filter UI DOM in `filters.js` (chips, popovers, pill state)
- `css/desktop.css`, `css/mobile.css` — untouched
- `index.html` — untouched (add `js/api.js` to load order before `app.js`)
- URL hash scheme — same `#artist:::title` format
- SoundCloud widget integration
- Audio cache schema (`audio_cache.json`) — unchanged

---

## 16. Risks and Drawbacks

**Cloudflare DO cold start (~2-5s)**
On first request after the DO sleeps (30 mins idle), it must reload and decompress
~110MB of JSON from R2. This shows as a slow shuffle. Mitigation: cron warmup ping
every 25 mins, or implement a simple loading spinner in the frontend.

**Worker memory limits**
DO memory budget is ~128MB. Compressed graph is ~15-20MB; decompressed is ~110MB.
This is tight. If the graph grows significantly (e.g. adding more sources), may need to
move to Option B (pre-computed shards). Monitor with `wrangler tail` on memory metrics.

**Local server startup time**
Parsing 110MB of JSON takes ~3-5 seconds in Node. Acceptable for dev — it's a one-time
cost. If it becomes annoying, cache a parsed binary (MessagePack or `.json.bin`).

**Latency added to shuffle**
Each shuffle now involves an HTTP round trip (~30-100ms to Cloudflare vs. ~0ms local).
This is barely perceptible for a user-initiated action. The current cold start of parsing
110MB in the browser (~8-15s) is much worse, so this is a net win.

**Shared module compatibility**
`shared/graph-logic.js` must work in both Node (CommonJS) and Workers (ESM). Use ESM
natively (`export`/`import`) since Workers require ESM and Node 18+ supports it.
Avoid `require()` in the shared module.

**Maintaining the toggle**
The auto-detect (`hostname === 'localhost'`) approach is clean but means local dev must
always run on localhost (not a local IP like 192.168.x.x). If you ever test on a phone
via local IP, you'd need to temporarily override the base URL.

**Crates mode pagination state**
Currently the Web Worker tracks `seedIdx` and `usedNodes` across page requests. With the
API, the server is stateless — it must re-derive pagination state from `seed` + `page`
parameters. The `generateClusters` function needs to be deterministic and resumable:
given `(seed, page, count)`, skip the first `page * count` clusters. This requires
making the seeded shuffle reproducible across calls, which the current `crateRand()` LCG
already supports — but the "usedNodes" overlap tracking is stateful. Simplest fix:
discard overlap tracking entirely (it was an optimization, not a correctness requirement)
or pass `usedKeys` as a request body param.
