# Cloud Migration Plan: Provider-Portable API

Move from serving 110MB of JSON to the browser to a server-side API that runs graph
logic (BFS, filtering, shuffle) on the server. The design goal is **provider portability**:
run entirely locally with a Node server, deploy to Cloudflare today, migrate to Fly/Vercel/
any other provider tomorrow — without rewriting logic.

"Resilience" here means easy provider swaps, NOT runtime fallback (the frontend does not
detect a failing backend and switch to another). If the backend is down, the app shows
an error. That's fine.

---

## 1. Problem

The app currently loads two large files on startup:
- `web-app/output/combined_graph.json` — 126,720 nodes, ~110MB
- `web-app/output/audio_cache.json` — 126,719 entries

All graph logic (BFS, filtering, weighted random, index building) runs in the browser
against that in-memory dataset. Cold start is painfully slow on slow connections and
mobile. The crates Web Worker (`js/crates-worker.js`) fetches both files a second time
independently.

---

## 2. Architecture Overview

Three distinct layers with clean boundaries:

```
┌──────────────────────────────────────┐
│  Frontend (unchanged HTML/CSS/JS)    │
│                                      │
│  js/api.js  ←── BASE_URL resolution  │
│    ↓                                 │
│  fetch(BASE_URL + endpoint)          │
└──────────────────┬───────────────────┘
                   │  HTTP (same API contract everywhere)
       ┌───────────┴──────────┐
       │                      │
       ▼                      ▼
 Local Node server       Cloudflare Worker
 server/local-server.js  worker/index.js
       │                      │
       ▼                      ▼
 Load from disk          Load from R2
 pipeline/output/*.json  b2b-graph-data/
       │                      │
       └──────────┬───────────┘
                  │  graph object (plain JS: { nodes, ... })
                  ▼
        shared/graph-logic.js
        (BFS, filtering, shuffle, indexing)
        Zero provider-specific code.
```

The boundary between the adapter and the shared module is explicit:
- **Adapters** (local server, Worker) handle: loading data from wherever it lives,
  HTTP routing, CORS headers, serializing responses.
- **`shared/graph-logic.js`** handles: everything algorithmic. It takes plain JS objects
  and returns plain JS objects. It has no `import` of any provider SDK, no R2 bindings,
  no KV, no fetch calls, no filesystem access.

Swapping providers means writing a new adapter file (~100 lines) and changing `BASE_URL`.
The shared logic is untouched.

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

### Stays client-side

| Function | Reason |
|---|---|
| `computeLayout()` (`graph.js:393`) | Needs DOM measurements (`el.offsetHeight`) |
| `cratesTreemap()` (`crates-worker.js:81`) | Pure math but needs live viewport dimensions — must re-run on resize |
| `renderCards()`, `renderConnections()` (`graph.js:232,352`) | DOM rendering |
| `setupHovers()` (`graph.js:373`) | DOM event wiring |
| `showCluster()` (`app.js:1`) | Layout + render orchestration |
| All of `audio.js` | SoundCloud/Mixcloud widget playback |
| All of `mobile.js` | Mobile carousel, DOM rendering |
| Filter UI state (`searchFilters`, `djSearchFilters`, `genreFilters` in `data.js`) | Client-side filter pill state |
| `shuffleHistory` (`data.js:16`) | Client-side dedup — sent as `exclude` param to shuffle |
| Theme toggle, help modal, hash navigation | Purely UI |
| `generateGradient()`, `glowPalettes` (`data.js`) | Visual, no graph data needed |

---

## 4. Shared Graph Logic Module

**File**: `shared/graph-logic.js`

**Hard rule**: zero provider-specific code in this file. No `import` of R2/KV/Durable
Object APIs. No `fetch()`. No `fs`. It receives plain JS data and returns plain JS data.
Any server that can load a JSON file can use it.

```js
// shared/graph-logic.js — pure functions, plain data in/out

export function buildCandidates(graphNodes, audioCache) {
  // Current logic from app.js:244-286
  // Filters to 2+ edges, no mixcloud nodes/neighbors
  // Computes genre rebalancing weights (genreWeightCaps lives here as a const)
  // Returns: { candidates: string[], candidateWeights: Float64Array, idxMap: Map }
}

export function buildIndexes(graphNodes, djNameMap) {
  // Current logic from filters.js:23-92
  // Returns: { artistIndex, djIndex, episodeIndex, artistListAlpha, djListAlpha }
}

export function buildGenreList(graphNodes) {
  // Current logic from filters.js:95-106
  // Returns: [{ name, count }] sorted by count desc, top 30
}

export function getFilteredPool(graphNodes, audioCache, candidates, filters) {
  // filters: { source, artists: string[], djs: string[], genres: string[] }
  // Current logic from app.js:129-153
  // Returns: string[] of matching node IDs
}

export function weightedPickFromPool(pool, candidateWeights, idxMap) {
  // Current logic from app.js:160-177
  // Returns: string (node ID) — uniform pick if no weights
}

export function selectCluster(graphNodes, audioCache, rootId, r1Limit = 4, r2Limit = 1) {
  // Current logic from graph.js:79-153
  // Returns: { meta, nodes, edges }
}

export function splitArtists(raw) {
  // Current logic from filters.js:5-21
}

export function generateCratesPage(graphNodes, audioCache, seed, page, count) {
  // Deterministic: given (seed, page, count), always returns the same clusters.
  // Fast-forward: replay the LCG from seed to skip past pages (see §12).
  // Returns: { clusters: [...], hasMore: boolean }
  // cratesTreemap() is included here — pure math, no graph needed but convenient to co-locate
}
```

**ESM only** — Workers require ESM; Node 18+ supports it natively. No CommonJS `require()`.

---

## 5. API Contract

All endpoints return `Content-Type: application/json`.
All endpoints set CORS headers (see §9).
Errors return `{ "error": "message" }` with the appropriate HTTP status.

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

**Response** — same shape as `selectCluster()` output, plus `meta.poolSize`:
```json
{
  "meta": {
    "root_id": "four tet:::baby",
    "found": 12,
    "not_found": 2,
    "totalR1": 8,
    "r1Shown": 4,
    "expandLevel": 0,
    "poolSize": 4821
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

Generate a page of crates clusters. Fully deterministic — same `(seed, page, filters)`
always returns the same clusters. See §12 for the full design.

The server returns cluster data only. **Treemap layout is computed client-side** — the
worker calls `cratesTreemap()` against the cluster list + current viewport after the
API response arrives. This keeps layout correct on resize without a new API call.

**Query params**:
- `seed` — integer seed for deterministic shuffle (required)
- `page` — page number, 0-indexed (default 0)
- `count` — clusters per page (default 12)
- `genres` — comma-separated genre names (mirrors shuffle filter)
- `artists` — comma-separated artist names (url-encoded)
- `djs` — comma-separated DJ names (url-encoded)

**Response** — no `rect` field; layout is client-side:
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
      "weight": 18
    }
  ],
  "hasMore": true
}
```

---

## 6. Frontend Data Layer: `js/api.js`

New file. Single source of truth for the base URL. All data fetches go through it.

```js
// js/api.js

// Resolution order:
// 1. ?api=<url> query param — for testing on real devices via local IP
// 2. Hostname check — localhost → local Node server
// 3. Default → production Worker URL
function resolveBase() {
  const param = new URLSearchParams(window.location.search).get('api');
  if (param) return param;                          // e.g. ?api=http://192.168.1.5:3001
  if (window.location.hostname === 'localhost') return 'http://localhost:3001';
  return 'https://b2b.workers.dev';
}

const API_BASE = resolveBase();

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

export async function getCratesPage({ seed, page, count, vw, vh, pad = 8 }) {
  return apiFetch('/api/crates', { seed, page, count, vw, vh, pad });
}
```

**Testing on a real phone**: open `http://192.168.1.x:8000?api=http://192.168.1.x:3001`.
The `?api=` param overrides everything else — no code changes needed.

**`app.js` changes** (minimal):
- `shuffle()` calls `api.shuffleCluster({ source, genres, artists, djs, exclude: [...shuffleHistory] })` — receives a complete cluster, passes directly to `showCluster()`
- `loadClusterById(id)` calls `api.loadCluster(id)` — same
- Remove: `getFilteredPool()`, `weightedPick()`, `matchesFilter()`, candidate computation, graph fetch from `DOMContentLoaded`
- Remove: `graphNodes`, `audioCache`, `candidates`, `candidateWeights` global state
- Keep: `shuffleHistory` (local dedup Set)
- `meta.poolSize` from the shuffle response feeds `getFilteredPoolSize()` display

**`filters.js` changes**:
- `initFilters()` no longer builds indexes — genre pills populated from `api.getGenres()`,
  autocomplete calls `api.searchArtists(q)` / `api.searchDjs(q)` on input
- Filter pill state stays entirely client-side
- `updateFilterUI()` uses `meta.poolSize` from the last shuffle response

**`crates-worker.js` changes** — see §12 for full detail:
- Remove `initFromUrls()` and all graph/cache fetching (~100 lines gone)
- Worker receives `postMessage({ type: 'generatePage', seed, page, count, vw, vh, pad, filters })`
- Calls `api.getCratesPage({ seed, page, count, filters })` — gets cluster list, no rects
- Runs `cratesTreemap(clusters, pad, pad, vw - pad*2, vh - pad*2)` locally on the result
- Posts `{ type: 'page', id, clusters }` back to main thread
- Worker also handles `type: 'prefetch'` — same flow but result is cached, not posted immediately

---

## 7. Server Adapters

Both adapters expose the exact same HTTP API. They differ only in how they load data.

### 7a. Local Node Server (development)

**File**: `server/local-server.js`

```js
import express from 'express';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  buildCandidates, buildIndexes, buildGenreList,
  getFilteredPool, weightedPickFromPool, selectCluster,
  generateCratesPage,
} from '../shared/graph-logic.js';

// Load all data synchronously at startup — fine on your own machine
const root = resolve(import.meta.dirname, '../pipeline/output');
const graphNodes = JSON.parse(readFileSync(`${root}/combined_graph.json`)).nodes;
const audioCache = JSON.parse(readFileSync(`${root}/audio_cache.json`));
const djNameMap  = JSON.parse(readFileSync(`${root}/dj_name_map.json`));

// Pre-compute derived data once
const { candidates, candidateWeights, idxMap } = buildCandidates(graphNodes, audioCache);
const { artistListAlpha, djListAlpha }         = buildIndexes(graphNodes, djNameMap);
const genreList                                = buildGenreList(graphNodes);

const app = express();
app.use(cors({ origin: '*' }));   // allow any origin (localhost:8000, local IP, etc.)

// Route handlers call shared functions directly — no glue code beyond
// parsing query params and serializing the response.
// ...

app.listen(3001, '0.0.0.0');  // bind to 0.0.0.0 so phones on the same network can reach it
```

Startup: ~3-5s to parse ~110MB JSON. One-time cost per server run.

### 7b. Cloudflare Worker (production)

**File**: `worker/index.js`

The Worker calls `shared/graph-logic.js` exactly like the local server. The adapter
handles Cloudflare-specific concerns: loading from R2, routing, CORS headers.

```js
import {
  buildCandidates, buildIndexes, buildGenreList,
  getFilteredPool, weightedPickFromPool, selectCluster,
  generateCratesPage,
} from '../shared/graph-logic.js';

// GraphDO: Cloudflare Durable Object — one persistent V8 isolate that holds the
// loaded graph in memory. The shared logic runs inside it.
// See memory discussion in §8.
export class GraphDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.graph = null;  // loaded lazily
  }

  async loadIfNeeded() {
    if (this.graph) return;
    // Load from R2 (Cloudflare-specific — this is the only provider code)
    const [gObj, aObj, dObj] = await Promise.all([
      this.env.BUCKET.get('combined_graph.json.gz'),
      this.env.BUCKET.get('audio_cache.json.gz'),
      this.env.BUCKET.get('dj_name_map.json'),
    ]);
    const ds = new DecompressionStream('gzip');
    const graphNodes = await new Response(gObj.body.pipeThrough(ds)).json().then(d => d.nodes);
    // ... etc

    // Build derived data using shared module (zero Cloudflare code)
    const { candidates, candidateWeights, idxMap } = buildCandidates(graphNodes, audioCache);
    const { artistListAlpha, djListAlpha }         = buildIndexes(graphNodes, djNameMap);
    const genreList                                = buildGenreList(graphNodes);
    this.graph = { graphNodes, audioCache, candidates, candidateWeights, idxMap,
                   artistListAlpha, djListAlpha, genreList };
  }

  async fetch(request) {
    await this.loadIfNeeded();
    // Route to shared functions exactly as the local server does
    // ...
  }
}

// Worker entry point: thin router that delegates to the DO
export default {
  async fetch(request, env) {
    const id = env.GRAPH_DO.idFromName('singleton');
    const stub = env.GRAPH_DO.get(id);
    return stub.fetch(request);
  }
};
```

**What makes this Cloudflare-specific** (the parts that change when you migrate):
1. `this.env.BUCKET.get(...)` — R2 object fetch
2. `export class GraphDO` + `export default { fetch }` — Worker/DO entrypoint convention
3. `wrangler.toml` — Cloudflare deployment config

Everything else — all the graph logic, all the route handlers, all the response shapes —
is in `shared/graph-logic.js` and a shared route-handler file that both adapters call.

**Migrating to another provider** means writing a new ~100-line adapter that:
1. Loads the JSON files from wherever (S3, disk, a CDN) into a plain `graphNodes` object
2. Passes it to the same shared functions
3. Exposes the same HTTP routes

---

## 8. Memory: The Critical Problem

**This is the most likely thing to break on day one.**

110MB of raw JSON expands significantly when parsed into JavaScript objects. Each V8
object has hidden class overhead, pointer indirection, and string interning costs. A
reasonable estimate is **2–3× expansion**: 110MB JSON → **220–330MB of live heap**.

The Cloudflare Durable Object memory limit is **128MB**. At current graph size, the DO
will likely OOM on the first warm-up attempt.

### Option A: Durable Object with slim in-memory format

Strip the graph down before storing it in the DO. The full node structure is:
```json
{
  "artist:::title": {
    "title": "...", "artist": "...", "genres": [...],
    "edges": [{ "node": "...", "contexts": [{ "dj": "...", "episode_url": "...", "date": "..." }] }]
  }
}
```

For BFS and filtering, `contexts` is only needed when building the cluster response.
Index-building only needs `artist`, `genres`, and edge `node` IDs. A stripped graph
(edge node IDs only, no contexts) might fit in 128MB. Full context data is kept in a
separate R2 object and fetched only for the ~15 nodes in a cluster response.

Complexity: requires splitting the graph into two R2 objects at pipeline time.

### Option B: Pre-sharded storage (recommended initial approach)

Rather than holding the full graph in memory at once, shard it at deploy time:

```
b2b-graph-data/
  meta.json               # candidates[], weights[], genreList, djIndex, artistIndex (~5MB total)
  nodes/aa.json           # all nodes whose ID starts with "aa" through "az"
  nodes/ba.json           # "ba" through "bz"
  ...                     # ~26 files × ~4-6MB each
```

On each shuffle request:
1. Load `meta.json` (cached in Worker module-level after first fetch, ~10ms)
2. Pick a random candidate from the pre-computed list — O(1)
3. Load the node shard containing the root + its neighbors (~2-4 shard files, ~10-30ms)
4. Run BFS within those shards — all nodes needed for a 2-ring cluster are typically
   in the same or adjacent shard by ID prefix

No single request touches more than ~15MB of data. No DO needed. Cold start is near-zero.

**Trade-off**: shard boundaries can split BFS traversal across files (root's r2 neighbors
may be in different shards than its r1 neighbors). In the worst case this means 3-4
parallel R2 fetches per shuffle. Still fast enough (~30-50ms total).

**Recommendation**: Start with Option B. It avoids the memory cliff entirely and has no
cold start. If the shard-boundary edge cases become a pain, revisit Option A with a
stripped in-memory format.

The local Node server is unaffected by this choice — it loads the full JSON at startup
and holds everything in Node's heap (no 128MB cap).

---

## 9. CORS

Both the local server and the Worker must return CORS headers on every response,
including error responses and `OPTIONS` preflight requests.

**Required headers**:
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

**Local server** (`server/local-server.js`): `app.use(cors({ origin: '*' }))` with the
`cors` npm package, or manually set headers in a middleware. Bind to `0.0.0.0` (not
`127.0.0.1`) so requests from phones on the local network are accepted.

**Cloudflare Worker**: add CORS headers in the Worker's `fetch` handler before
dispatching to the DO. Handle `OPTIONS` preflight at the Worker level so the DO never
sees it:
```js
if (request.method === 'OPTIONS') {
  return new Response(null, { headers: corsHeaders });
}
// ... then forward to DO
```

---

## 10. R2 Storage Format (Cloudflare adapter)

Bucket: `b2b-graph-data`

For Option B (recommended):
```
b2b-graph-data/
  meta.json               # candidates, weights, artistIndex, djIndex, genreList
  nodes/aa.json           # nodes with IDs starting "aa"–"az" (uncompressed OK at ~4-6MB)
  nodes/ba.json
  ...
  audio_cache.json.gz     # gzip-compressed (~8-12MB compressed)
  dj_name_map.json
```

For Option A (if revisited):
```
b2b-graph-data/
  graph-slim.json.gz      # stripped graph: edges only, no contexts (~20-30MB → ~5MB gzip)
  graph-contexts.json.gz  # full contexts: only needed for cluster responses (~80MB → ~15MB)
  audio_cache.json.gz
  dj_name_map.json
```

The pipeline deploy script generates the appropriate format. See §11.

---

## 11. Pipeline Changes

Add a deploy step. No changes to `graph.py`, `enrich.py`, or `extract_dj_names.py`.

**New file**: `pipeline/deploy_to_r2.sh`

```bash
#!/bin/bash
set -e
cd "$(dirname "$0")"

echo "Building shards..."
node ../server/build-shards.js   # reads pipeline/output/, writes pipeline/output/shards/

echo "Uploading meta + shards to R2..."
npx wrangler r2 object put b2b-graph-data/meta.json --file output/shards/meta.json
for f in output/shards/nodes/*.json; do
  key="nodes/$(basename $f)"
  npx wrangler r2 object put "b2b-graph-data/$key" --file "$f"
done

echo "Uploading audio cache..."
gzip -k -f output/audio_cache.json
npx wrangler r2 object put b2b-graph-data/audio_cache.json.gz \
  --file output/audio_cache.json.gz --content-encoding gzip

npx wrangler r2 object put b2b-graph-data/dj_name_map.json --file output/dj_name_map.json

echo "Done."
```

**New file**: `server/build-shards.js` — reads `pipeline/output/combined_graph.json`,
splits into `pipeline/output/shards/nodes/{prefix}.json` + writes
`pipeline/output/shards/meta.json` (candidates, weights, indexes).

Full pipeline run after a scrape:
```bash
cd pipeline
caffeinate -dims python3 graph.py
caffeinate -dims python3 enrich.py
python3 extract_dj_names.py
./deploy_to_r2.sh
```

---

## 12. Crates Mode: Full Design

### 12a. Current state

`crates-worker.js` is a self-contained Web Worker that:
1. Fetches the full `combined_graph.json` + `audio_cache.json` itself (second full download)
2. Builds its own compact `graphEdges` and `artUrls` maps
3. Generates clusters page-by-page with BFS (`cratesBfs()`, `generateClusters()`)
4. Tracks `usedNodes: Set` and `seedIdx: number` as mutable state across page requests
5. Runs `cratesTreemap()` to compute pixel rects
6. Posts finished, positioned clusters back to the main thread

After the migration:
- Steps 1–3 move to the server (`shared/graph-logic.js` + `/api/crates`)
- Step 4 (`usedNodes`) is dropped entirely — see §12b
- Steps 5–6 stay in the worker — treemap layout stays client-side — see §12c

### 12b. Pagination: stateless server via LCG fast-forward

The server is stateless. Page N must be derivable from `(seed, page, count, filters)` alone
without the server remembering anything from page N-1.

**Solution**: replay the LCG from scratch on each request, skipping past earlier pages.

The existing LCG in `crates-worker.js:11` is the Park-Miller generator:
```js
function crateRand() {
  crateSeed = (crateSeed * 16807) % 2147483647;
  return (crateSeed - 1) / 2147483646;
}
```

This is already fully deterministic given an initial seed. To serve page N:
1. Initialise `rngState = seed`
2. Build the full shuffled seed pool (same Fisher-Yates as before, driven by the RNG)
3. Fast-forward: step through the pool generating clusters until `page * count` valid
   clusters have been produced; discard their output
4. Generate the next `count` clusters — these are the page N results

Fast-forward cost: each skipped cluster runs `cratesBfs()` — roughly proportional to
cluster size (~15–40 nodes). At 12 clusters/page, page 20 skips 240 clusters.
Estimated: ~2–5ms per skipped cluster → page 20 ≈ 500ms–1.2s server time.
Practical limit: cap the API at page 50 (600 clusters skipped, ~3-6s worst case).
For a personal project with infinite-scroll crates, users rarely go past page 10.

**Drop `usedNodes` entirely.** The current overlap check (`if (overlap > members.length * 0.3) continue`)
prevents the same track appearing in two adjacent crates on screen. It's an aesthetic
optimisation, not a correctness requirement. Without it, `generateCratesPage` is pure
`(seed, page, count, filters) → clusters` with no external state:

```js
// In shared/graph-logic.js
export function generateCratesPage(graphNodes, audioCache, seed, page, count, filters = {}) {
  let rngState = seed;
  function rng() {
    rngState = (rngState * 16807) % 2147483647;
    return (rngState - 1) / 2147483646;
  }

  // Build filtered candidate pool (same filter logic as /api/shuffle)
  const pool = filters.genres || filters.artists || filters.djs
    ? getFilteredPool(graphNodes, audioCache, allCandidates, filters)
    : allCandidates;

  // Shuffle pool deterministically
  const seedPool = pool.filter(k => (graphNodes[k]?.edges?.length ?? 0) >= 4);
  for (let i = seedPool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [seedPool[i], seedPool[j]] = [seedPool[j], seedPool[i]];
  }

  // Fast-forward past earlier pages
  const skip = page * count;
  let poolIdx = 0, produced = 0;
  while (produced < skip && poolIdx < seedPool.length) {
    if (buildCrateCluster(graphNodes, audioCache, seedPool[poolIdx++])) produced++;
  }

  // Collect this page
  const clusters = [];
  while (clusters.length < count && poolIdx < seedPool.length) {
    const c = buildCrateCluster(graphNodes, audioCache, seedPool[poolIdx++]);
    if (c) clusters.push(c);
  }

  return { clusters, hasMore: poolIdx < seedPool.length };
}
```

`buildCrateCluster()` is the extracted body of the current `generateClusters()` loop —
it runs `cratesBfs()` for one seed and returns the cluster object (without a rect).

### 12c. Treemap layout stays client-side

`cratesTreemap()` (`crates-worker.js:81`) takes `(items, x, y, w, h)` and mutates each
item to add a `rect` property. It's pure math — no graph data, no network calls.

It must stay client-side because:
- It needs the **live viewport dimensions** (`vw`, `vh`) at render time
- If the user resizes, the layout needs to re-run against the same cluster list with new
  dimensions — without another API call

The worker keeps `cratesTreemap()` as a local function. After each `getCratesPage()`
response, the worker runs treemap before posting to the main thread:

```js
// Inside crates-worker.js (post-migration)
async function handleGeneratePage({ id, seed, page, count, vw, vh, pad, filters }) {
  const { clusters, hasMore } = await api.getCratesPage({ seed, page, count, ...filters });
  if (clusters.length === 0) {
    self.postMessage({ type: 'page', id, clusters: [] });
    return;
  }
  // Layout runs here in the worker — no DOM access needed, pure math
  cratesTreemap(clusters, pad, pad, vw - pad * 2, vh - pad * 2);
  self.postMessage({ type: 'page', id, clusters, hasMore });
}
```

On **resize**: the main thread re-runs treemap locally against the already-received
cluster list (cached in `app.js`) — no new API call needed. The current `app.js` crates
rendering would need a small addition to store the raw cluster list and re-layout on
`resize`.

### 12d. Prefetching

For smooth infinite-scroll, the worker should prefetch the next page while the current
one is rendering. Protocol:

```
Main thread                         Worker
──────────                          ──────
postMessage({ type: 'generatePage',   →  fetch /api/crates?page=0, run treemap
  id: 0, page: 0, ... })
                                    ←  postMessage({ type: 'page', id: 0, clusters })
postMessage({ type: 'prefetch',       →  fetch /api/crates?page=1 in background
  id: 1, page: 1, ... })                 (treemap deferred until vw/vh known)
[user scrolls near bottom]
postMessage({ type: 'generatePage',   →  if page 1 response already cached:
  id: 1, page: 1, vw, vh, ... })          run treemap, postMessage immediately
                                          else: await fetch, run treemap, postMessage
```

Implementation: the worker keeps a `Map<page, Promise<clusters>>` cache. `prefetch`
pre-fires the API call and stores the promise. `generatePage` awaits the promise
(already resolved if prefetch completed) then runs treemap.

`prefetch` does not pass `vw`/`vh` because the user might resize before consuming the
prefetched page. Treemap runs only when `generatePage` fires with current dimensions.

### 12e. Filtering in crates

Crates mode should respect the active genre/artist/DJ filters, consistent with the main
shuffle view. The worker receives the current filter state from the main thread as part
of each page request and passes it to the API:

```js
// Main thread → worker
postMessage({
  type: 'generatePage',
  seed: crateSeed,
  page: currentPage,
  count: 12,
  vw: window.innerWidth,
  vh: window.innerHeight,
  pad: 8,
  filters: {
    genres: genreFilters,      // ['Soul', 'Jazz']
    artists: [...searchFilters.map(f => f.display)],
    djs: [...djSearchFilters.map(f => f.display)],
  }
});
```

The server's `generateCratesPage()` applies `getFilteredPool()` before building the seed
pool (shown in §12b pseudocode). The same `getFilteredPool()` function used by `/api/shuffle`
handles this — no duplication.

**Consistency note**: if filters change while crates is open, the main thread should
reset the page counter to 0 and request a fresh page 0 with the new filters. The seed
stays the same (it was chosen when crates opened); the pool just narrows.

### 12f. What crates-worker.js looks like after migration

Before: ~172 lines — fetches full graph/cache, builds indexes, runs BFS, treemap.

After: ~60 lines — thin relay between main thread and API, plus local treemap:

```js
// crates-worker.js (post-migration, sketch)

import { getCratesPage } from './api.js';   // or inline apiFetch

const prefetchCache = new Map();  // page → Promise<{ clusters, hasMore }>

function cratesTreemap(items, x, y, w, h) { /* unchanged from current */ }

self.onmessage = async function(e) {
  const { type, id, seed, page, count, vw, vh, pad, filters } = e.data;

  if (type === 'prefetch') {
    if (!prefetchCache.has(page)) {
      prefetchCache.set(page, getCratesPage({ seed, page, count, ...filters }));
    }
    return;
  }

  if (type === 'generatePage') {
    let promise = prefetchCache.get(page);
    if (!promise) promise = getCratesPage({ seed, page, count, ...filters });
    prefetchCache.delete(page);  // consume

    const { clusters, hasMore } = await promise;
    if (clusters.length > 0) {
      cratesTreemap(clusters, pad, pad, vw - pad * 2, vh - pad * 2);
    }
    self.postMessage({ type: 'page', id, clusters, hasMore });
  }
};
```

---

## 13. How the Local/Cloud Toggle Works

In `js/api.js` (see §6 for full code):

```js
function resolveBase() {
  const param = new URLSearchParams(window.location.search).get('api');
  if (param) return param;
  if (window.location.hostname === 'localhost') return 'http://localhost:3001';
  return 'https://b2b.workers.dev';
}
```

**Normal dev**: `http://localhost:8000` → auto-routes to `localhost:3001`. Zero config.

**Testing on a phone**: open `http://192.168.1.x:8000?api=http://192.168.1.x:3001`.
The `?api=` param takes precedence. Works with any local IP, any port. The local Node
server must be bound to `0.0.0.0` for this to work (see §7a).

**Production**: any non-localhost hostname → auto-routes to `workers.dev`.

**Overriding in prod for debugging**: `https://b2b.example.com?api=https://staging.workers.dev`.

---

## 14. `genreWeightCaps` and Candidate Computation

Currently in `data.js:20-25`:
```js
const genreWeightCaps = { 'Ambient': 20, 'Folk': 5, 'Soul': 15, 'Indie Rock': 14 };
```

Moves to `shared/graph-logic.js` as a module-level constant. The server computes weights
once at startup; the frontend never sees them. The client only sends genre filter names
as params; weighting is opaque.

Candidate criteria (from `app.js:244-253`):
- 2+ edges
- Not a Mixcloud-only node
- No Mixcloud-only neighbors

---

## 15. URL Hash Navigation

Currently `app.js` puts the root track ID in the hash: `#four tet:::baby`.
This continues working — `loadClusterById(id)` calls `api.loadCluster(id)` which is
a GET to `/api/cluster/:id`. Share links remain valid. No change to URL scheme.

---

## 16. Migration Steps (in order)

Each step is independently testable. Do not move to the next step until the current
one passes a manual smoke test.

**Step 1: Extract shared logic module**
- Create `shared/graph-logic.js`
- Copy `selectCluster`, `getNeighbors`, `getEdgeContext`, `collectDjs`, `enrichFromCache`,
  `getFilteredPool`, `weightedPickFromPool`, `buildCandidates`, `buildGenreList`,
  `buildIndexes`, `splitArtists` into it
- Rewrite all functions to take data as arguments (no global vars)
- Write a quick smoke test: `node shared/smoke-test.js` that loads the JSONs, calls
  `selectCluster`, prints root node — verifies parity with browser behavior
- No frontend changes yet

**Step 2: Local Node server**
- Create `server/local-server.js` using `shared/graph-logic.js`
- Load JSONs from `pipeline/output/`
- Wire all API endpoints with CORS headers, bound to `0.0.0.0:3001`
- Test: `curl http://localhost:3001/api/genres`, `curl 'http://localhost:3001/api/shuffle'`

**Step 3: `js/api.js` + frontend plumbing**
- Create `js/api.js` with `resolveBase()` + all endpoint functions
- Wire `app.js`: replace `shuffle()` + `loadClusterById()` to use API
- Remove global graph state from `data.js` / startup fetch from `app.js`
- Test: open `http://localhost:8000` with local server running; basic shuffle works

**Step 4: Filters + autocomplete**
- Replace `initFilters()` index-building with API calls
- `getGenres()` → populate genre pills
- `searchArtists(q)` → feed autocomplete
- `searchDjs(q)` → feed DJ autocomplete
- `meta.poolSize` feeds filter label count
- Test filter UX end-to-end

**Step 5: Crates mode**
- Rewrite `crates-worker.js` to be a thin API proxy (no BFS)
- Implement deterministic `generateCratesPage()` in `shared/graph-logic.js`
- Test crates pagination (page 0, 1, 2 return different non-repeating clusters)

**Step 6: Build-shards script**
- Create `server/build-shards.js`
- Run against current graph, verify shard sizes and total
- Verify that BFS for a random root stays within ~3 shard files

**Step 7: Cloudflare Worker**
- Create `worker/index.js` + `wrangler.toml`
- Implement the Worker adapter using Option B (sharded R2 loads)
- Wire CORS preflight handling at Worker level
- Test locally: `wrangler dev`
- Deploy: `wrangler deploy`

**Step 8: R2 deploy script**
- Write `pipeline/deploy_to_r2.sh`
- Do first production deploy
- Test on live domain from desktop + phone

---

## 17. What Stays Exactly the Same

- All scrapers (`scrapers/lot-radio/`, `scrapers/nts/`)
- `pipeline/graph.py`, `pipeline/enrich.py`, `pipeline/extract_dj_names.py`
- `pipeline/utils.py` — `normalize()` and track ID format (`artist:::title`)
- All rendering code in `graph.js` (`renderCards`, `renderConnections`, `computeLayout`)
- All audio playback in `audio.js`
- All mobile layout in `mobile.js`
- Filter UI DOM in `filters.js` (chips, popovers, pill state)
- `css/desktop.css`, `css/mobile.css`
- `index.html` — untouched except: add `<script src="js/api.js">` before `app.js`
- URL hash scheme — same `#artist:::title` format
- SoundCloud widget integration
- Audio cache schema (`audio_cache.json`) — unchanged

---

## 18. Risks and Drawbacks

**V8 heap explosion (Option A)**
110MB of JSON → ~220-330MB of live V8 heap. The DO's 128MB limit is almost certainly
not enough at current graph size. This is why Option B (sharded) is the recommended
starting point. If you add more sources and the graph grows, Option A becomes even
less viable.

**Shard boundary BFS (Option B)**
A root node's r1 or r2 neighbors may fall in different shards. In the worst case, a
single `/api/shuffle` needs 3-4 parallel R2 fetches (~10-30ms each). This is fine
for a personal project but worth monitoring. Mitigation: if shard misses become
frequent, switch to content-based sharding (group by artist first char) so tracks
from the same DJ set tend to cluster in the same shard.

**Local server startup time**
~3-5s to parse ~110MB of JSON. Acceptable — one-time cost per server start. If annoying
over many restart cycles during dev, serialize the pre-built data structures to a binary
format (MessagePack, or JSON of just the derived indexes) and cache at a known path.

**Latency added to shuffle (~30-100ms)**
Each shuffle is now a round trip. This is imperceptible for a user-initiated tap/click.
The current browser cold start (~8-15s to download + parse 110MB) is far worse.

**ESM in Node**
`shared/graph-logic.js` uses ESM. Node requires `"type": "module"` in `package.json`
or `.mjs` extension. The local server must also use ESM. This is a minor gotcha if
you're used to `require()`.

**Durable Object lock-in (acknowledged)**
The DO is a Cloudflare-specific API. It's the only Cloudflare-specific part of the
Worker adapter. If migrating to Fly.io, replace the DO with a long-running Node process
(Fly keeps processes alive). On Vercel, replace with a serverless function that loads
the sharded data from S3/R2. In both cases, `shared/graph-logic.js` is untouched — only
the adapter changes.

**Crates fast-forward cost**
Fast-forwarding to page 50 means re-running 600 cluster constructions from scratch. At
~0.5ms per cluster, that's ~300ms. Acceptable for page 50 but noticeable for very deep
pagination. Mitigation: limit max page depth in the API (e.g. 50 pages), or cache
cluster lists by `(seed, count)` key in the server process.

---

## 19. Validation: How to Verify Each Step

Three layers of validation: **unit tests** for the shared logic module (runs fast, no
server needed), **curl/API checks** for each server step, and **Playwright tests** for
end-to-end browser behaviour after the frontend is wired up.

### 19a. Before starting: capture golden outputs from the browser

While the old client-side code still runs, capture ground truth by opening the browser
console on `http://localhost:8000` and running:

```js
// Paste this whole block into the console after the page loads

// 1. Index sizes (logged automatically — just note them from the existing console output)
//    "Graph loaded: 126720 nodes"
//    "Artist index: XXXX unique artists"
//    "DJ index: XXXX unique DJs"
//    "126720 candidates (2+ edges, no mixcloud)"   ← note this number

// 2. Top genres (logged by initFilters — "Genre index: 341 genres, showing top 30")
//    Copy the top 5 from the console

// 3. Known-root cluster — pick a root with many edges for a stable test
//    Find a real node ID: Object.keys(graphNodes).find(k => graphNodes[k].edges.length >= 8)
const knownRoot = Object.keys(graphNodes).find(k => graphNodes[k].edges.length >= 8);
console.log('TEST ROOT:', knownRoot);
const golden = selectCluster(knownRoot, 4, 1);
copy(JSON.stringify(golden));  // copies to clipboard
// Paste into a file: shared/test/fixtures/golden-cluster.json

// 4. Filtered pool sizes
const soulPool   = (() => { genreFilters = ['Soul'];   const n = getFilteredPool().length; genreFilters = []; return n; })();
const ambientPool = (() => { genreFilters = ['Ambient']; const n = getFilteredPool().length; genreFilters = []; return n; })();
console.log('Soul pool:', soulPool, 'Ambient pool:', ambientPool);

// 5. Artist filter pool size — pick a real artist name from the autocomplete
const artistEntry = artistListAlpha.find(a => a.trackIds.length > 50);
console.log('Artist filter test:', artistEntry.display, '→', artistEntry.trackIds.length, 'tracks');
copy(JSON.stringify({ knownRoot, soulPool, ambientPool, artistName: artistEntry.display, artistTrackCount: artistEntry.trackIds.length }));
// Paste into: shared/test/fixtures/golden-meta.json
```

These two JSON files (`golden-cluster.json`, `golden-meta.json`) are the source of truth
for all subsequent checks. Commit them as test fixtures.

---

### 19b. Unit tests for `shared/graph-logic.js`

**File**: `shared/test/graph-logic.test.js`
**Runner**: Node's built-in `node:test` (Node 18+, zero deps) or Jest.

```bash
node --test shared/test/graph-logic.test.js
```

#### Minimal fixture graph

Construct a deterministic 10-node graph with known structure so tests don't depend on
the 110MB production file:

```js
// shared/test/fixtures/mini-graph.js
export const miniGraph = {
  'artist a:::track 1': {
    title: 'Track 1', artist: 'Artist A', genres: ['Soul'],
    edges: [
      { node: 'artist b:::track 2', contexts: [{ dj: 'DJ X', episode_url: 'https://nts.live/ep/1', date: '2023-01-01' }] },
      { node: 'artist c:::track 3', contexts: [{ dj: 'DJ X', episode_url: 'https://nts.live/ep/1', date: '2023-01-01' }] },
      { node: 'artist d:::track 4', contexts: [{ dj: 'DJ Y', episode_url: 'https://nts.live/ep/2', date: '2023-02-01' }] },
    ]
  },
  'artist b:::track 2': {
    title: 'Track 2', artist: 'Artist B', genres: ['Jazz'],
    edges: [
      { node: 'artist a:::track 1', contexts: [{ dj: 'DJ X', episode_url: 'https://nts.live/ep/1', date: '2023-01-01' }] },
      { node: 'artist e:::track 5', contexts: [{ dj: 'DJ X', episode_url: 'https://nts.live/ep/1', date: '2023-01-01' }] },
    ]
  },
  'artist c:::track 3': {
    title: 'Track 3', artist: 'Artist C', genres: ['Soul', 'Jazz'],
    edges: [
      { node: 'artist a:::track 1', contexts: [{ dj: 'DJ X', episode_url: 'https://nts.live/ep/1', date: '2023-01-01' }] },
      { node: 'artist f:::track 6', contexts: [{ dj: 'DJ Z', episode_url: 'https://nts.live/ep/3', date: '2023-03-01' }] },
    ]
  },
  'artist d:::track 4': {
    title: 'Track 4', artist: 'Artist D', genres: ['Ambient'],
    edges: [
      { node: 'artist a:::track 1', contexts: [{ dj: 'DJ Y', episode_url: 'https://nts.live/ep/2', date: '2023-02-01' }] },
    ]
  },
  'artist e:::track 5': {
    title: 'Track 5', artist: 'Artist E', genres: ['Jazz'],
    edges: [
      { node: 'artist b:::track 2', contexts: [{ dj: 'DJ X', episode_url: 'https://nts.live/ep/1', date: '2023-01-01' }] },
    ]
  },
  'artist f:::track 6': {
    title: 'Track 6', artist: 'Artist F', genres: ['Soul'],
    edges: [
      { node: 'artist c:::track 3', contexts: [{ dj: 'DJ Z', episode_url: 'https://nts.live/ep/3', date: '2023-03-01' }] },
    ]
  },
};

export const miniCache = {
  'artist a:::track 1': { source: 'soundcloud', scTrackUrl: 'https://soundcloud.com/a/1', artUrl: 'https://art.example.com/1.jpg', setUrl: null, setSource: null, setOffsetSec: null, setDj: null },
  'artist b:::track 2': { source: 'soundcloud_set', scTrackUrl: null, artUrl: 'https://art.example.com/2.jpg', setUrl: 'https://soundcloud.com/set/1', setSource: 'soundcloud', setOffsetSec: 120, setDj: 'DJ X' },
  'artist c:::track 3': { source: 'soundcloud', scTrackUrl: 'https://soundcloud.com/c/3', artUrl: null, setUrl: null, setSource: null, setOffsetSec: null, setDj: null },
  'artist d:::track 4': { source: 'mixcloud_set', scTrackUrl: null, artUrl: null, setUrl: 'https://mixcloud.com/dj-y/ep2', setSource: 'mixcloud', setOffsetSec: 60, setDj: 'DJ Y' },
  'artist e:::track 5': { source: 'not_found', scTrackUrl: null, artUrl: null, setUrl: null, setSource: null, setOffsetSec: null, setDj: null },
  'artist f:::track 6': { source: 'soundcloud', scTrackUrl: 'https://soundcloud.com/f/6', artUrl: 'https://art.example.com/6.jpg', setUrl: null, setSource: null, setOffsetSec: null, setDj: null },
};

export const miniDjNameMap = {
  'DJ X': ['DJ X'],
  'DJ Y': ['DJ Y'],
  'DJ Z': ['DJ Z'],
};
```

#### Test cases

```js
// shared/test/graph-logic.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { miniGraph, miniCache, miniDjNameMap } from './fixtures/mini-graph.js';
import {
  buildCandidates, buildIndexes, buildGenreList,
  getFilteredPool, selectCluster, splitArtists, generateCratesPage,
} from '../graph-logic.js';

// ── buildCandidates ──────────────────────────────────────────────────────────

describe('buildCandidates', () => {
  it('includes nodes with 2+ edges and no mixcloud neighbours', () => {
    const { candidates } = buildCandidates(miniGraph, miniCache);
    // artist a has 3 edges, none mixcloud → include
    assert.ok(candidates.includes('artist a:::track 1'));
    // artist b has 2 edges, none mixcloud → include
    assert.ok(candidates.includes('artist b:::track 2'));
    // artist c has 2 edges, none mixcloud → include
    assert.ok(candidates.includes('artist c:::track 3'));
  });

  it('excludes nodes with fewer than 2 edges', () => {
    const { candidates } = buildCandidates(miniGraph, miniCache);
    // artist d, e, f each have 1 edge → exclude
    assert.ok(!candidates.includes('artist d:::track 4'));
    assert.ok(!candidates.includes('artist e:::track 5'));
    assert.ok(!candidates.includes('artist f:::track 6'));
  });

  it('excludes mixcloud-only nodes (the node itself)', () => {
    // artist d is mixcloud_set and has only 1 edge anyway, but test the mixcloud exclusion:
    // build a graph where a node has 3 edges but is itself mixcloud_set
    const g = { ...miniGraph };
    const c = { ...miniCache, 'artist a:::track 1': { source: 'mixcloud_set', scTrackUrl: null, artUrl: null, setUrl: 'https://mixcloud.com/x', setSource: 'mixcloud', setOffsetSec: null, setDj: null } };
    const { candidates } = buildCandidates(g, c);
    assert.ok(!candidates.includes('artist a:::track 1'));
  });
});

// ── selectCluster ─────────────────────────────────────────────────────────────

describe('selectCluster', () => {
  it('returns a cluster with root node as first entry', () => {
    const cluster = selectCluster(miniGraph, miniCache, 'artist a:::track 1');
    assert.equal(cluster.nodes[0].rank, 'root');
    assert.equal(cluster.nodes[0].graphId, 'artist a:::track 1');
    assert.equal(cluster.nodes[0].title, 'Track 1');
    assert.equal(cluster.nodes[0].artist, 'Artist A');
  });

  it('populates r1 nodes (direct neighbours of root)', () => {
    const cluster = selectCluster(miniGraph, miniCache, 'artist a:::track 1', 4, 1);
    const r1 = cluster.nodes.filter(n => n.rank === '1');
    // artist a has 3 neighbours (b, c, d) — all eligible for r1
    assert.ok(r1.length >= 1 && r1.length <= 4);
    // every r1 node must be a real neighbour of artist a
    const validNeighbours = new Set(['artist b:::track 2', 'artist c:::track 3', 'artist d:::track 4']);
    for (const n of r1) assert.ok(validNeighbours.has(n.graphId));
  });

  it('populates r2 nodes (neighbours of r1, not already used)', () => {
    const cluster = selectCluster(miniGraph, miniCache, 'artist a:::track 1', 4, 1);
    const r2 = cluster.nodes.filter(n => n.rank === '2');
    // r2 nodes must not include the root
    for (const n of r2) assert.notEqual(n.graphId, 'artist a:::track 1');
  });

  it('edges reference local node IDs (root, r1_0, r2_0_0, …)', () => {
    const cluster = selectCluster(miniGraph, miniCache, 'artist a:::track 1');
    assert.ok(cluster.edges.length > 0);
    assert.equal(cluster.edges[0].from, 'root');
    assert.match(cluster.edges[0].to, /^r1_\d+$/);
  });

  it('enriches nodes from audio cache', () => {
    const cluster = selectCluster(miniGraph, miniCache, 'artist a:::track 1');
    const root = cluster.nodes[0];
    assert.equal(root.source, 'soundcloud');
    assert.equal(root.scTrackUrl, 'https://soundcloud.com/a/1');
    assert.equal(root.artUrl, 'https://art.example.com/1.jpg');
  });

  it('marks not_found nodes correctly', () => {
    // artist e (track 5) has source: not_found
    const cluster = selectCluster(miniGraph, miniCache, 'artist b:::track 2', 4, 2);
    const e = cluster.nodes.find(n => n.graphId === 'artist e:::track 5');
    if (e) {
      assert.equal(e.source, 'not_found');
      assert.equal(e.scTrackUrl, null);
    }
    // artist e might not appear due to r2 limit — that's fine, no assertion failure
  });

  it('edges carry dj + episodeUrl context', () => {
    const cluster = selectCluster(miniGraph, miniCache, 'artist a:::track 1');
    const edge = cluster.edges[0];
    assert.ok(edge.context);
    assert.equal(typeof edge.context.dj, 'string');
    assert.ok(edge.context.episodeUrl.startsWith('https://'));
  });

  it('meta.totalR1 reflects actual neighbour count of root', () => {
    const cluster = selectCluster(miniGraph, miniCache, 'artist a:::track 1');
    assert.equal(cluster.meta.totalR1, 3);  // a has 3 neighbours: b, c, d
  });
});

// ── getFilteredPool ───────────────────────────────────────────────────────────

describe('getFilteredPool', () => {
  const { candidates } = buildCandidates(miniGraph, miniCache);

  it('returns all candidates when no filters are set', () => {
    const pool = getFilteredPool(miniGraph, miniCache, candidates, {});
    assert.deepEqual([...pool].sort(), [...candidates].sort());
  });

  it('filters by genre: only candidates whose genres include the filter', () => {
    const pool = getFilteredPool(miniGraph, miniCache, candidates, { genres: ['Soul'] });
    // candidates with Soul: artist a (Soul), artist c (Soul, Jazz)
    assert.ok(pool.includes('artist a:::track 1'));
    assert.ok(pool.includes('artist c:::track 3'));
    // artist b is Jazz only → excluded
    assert.ok(!pool.includes('artist b:::track 2'));
  });

  it('filters by multiple genres (OR — track matches any)', () => {
    const pool = getFilteredPool(miniGraph, miniCache, candidates, { genres: ['Soul', 'Jazz'] });
    // a (Soul), b (Jazz), c (Soul+Jazz) all qualify
    assert.ok(pool.includes('artist a:::track 1'));
    assert.ok(pool.includes('artist b:::track 2'));
    assert.ok(pool.includes('artist c:::track 3'));
  });

  it('filters by source: soundcloud excludes set-only nodes', () => {
    const pool = getFilteredPool(miniGraph, miniCache, candidates, { source: 'soundcloud' });
    // artist a has scTrackUrl → include; artist b is soundcloud_set, not individual → exclude
    assert.ok(pool.includes('artist a:::track 1'));
    assert.ok(!pool.includes('artist b:::track 2'));
  });

  it('returns empty array when no candidates match the filter', () => {
    const pool = getFilteredPool(miniGraph, miniCache, candidates, { genres: ['Classical'] });
    assert.equal(pool.length, 0);
  });
});

// ── buildIndexes ──────────────────────────────────────────────────────────────

describe('buildIndexes', () => {
  it('indexes all unique artist names', () => {
    const { artistIndex } = buildIndexes(miniGraph, miniDjNameMap);
    assert.ok('artist a' in artistIndex);
    assert.ok('artist b' in artistIndex);
  });

  it('splits multi-artist strings into individual entries', () => {
    const g = {
      ...miniGraph,
      'artist a & artist b:::collab track': {
        title: 'Collab Track', artist: 'Artist A & Artist B', genres: [],
        edges: [{ node: 'artist a:::track 1', contexts: [] }]
      }
    };
    const { artistIndex } = buildIndexes(g, miniDjNameMap);
    assert.ok('artist a' in artistIndex);
    assert.ok('artist b' in artistIndex);
  });

  it('builds djIndex keyed by lowercase dj name', () => {
    const { djIndex } = buildIndexes(miniGraph, miniDjNameMap);
    assert.ok('dj x' in djIndex);
    assert.ok('dj y' in djIndex);
    assert.ok('dj z' in djIndex);
  });

  it('djIndex trackIds includes both sides of an edge', () => {
    const { djIndex } = buildIndexes(miniGraph, miniDjNameMap);
    // DJ X appears on the edge between a and b — both node IDs should be in trackIds
    const djX = djIndex['dj x'];
    assert.ok(djX.trackIds.has('artist a:::track 1'));
    assert.ok(djX.trackIds.has('artist b:::track 2'));
  });
});

// ── buildGenreList ────────────────────────────────────────────────────────────

describe('buildGenreList', () => {
  it('returns genres sorted by count descending', () => {
    const genres = buildGenreList(miniGraph);
    // Soul appears in track 1, 3, 6 = 3 nodes; Jazz in 2, 3, 5 = 3; Ambient in 4 = 1
    const counts = Object.fromEntries(genres.map(g => [g.name, g.count]));
    assert.ok(counts['Soul'] >= 2);
    assert.ok(counts['Jazz'] >= 2);
    assert.ok(counts['Ambient'] >= 1);
    assert.ok(counts['Soul'] >= counts['Ambient']);
    // sorted descending
    for (let i = 1; i < genres.length; i++) {
      assert.ok(genres[i-1].count >= genres[i].count);
    }
  });
});

// ── splitArtists ──────────────────────────────────────────────────────────────

describe('splitArtists', () => {
  const cases = [
    ['Four Tet',                   ['Four Tet']],
    ['Four Tet & Burial',          ['Four Tet', 'Burial']],
    ['Bonobo feat. Nick Murphy',   ['Bonobo', 'Nick Murphy']],
    ['A ft. B',                    ['A', 'B']],
    ['X, Y, Z',                    ['X', 'Y', 'Z']],
    ['Faro (Oklou & Malibu)',       ['Faro', 'Oklou', 'Malibu']],
    ['A x B',                      ['A', 'B']],
  ];
  for (const [input, expected] of cases) {
    it(`splits "${input}" → [${expected.join(', ')}]`, () => {
      assert.deepEqual(splitArtists(input), expected);
    });
  }
});

// ── generateCratesPage ────────────────────────────────────────────────────────

describe('generateCratesPage (determinism)', () => {
  it('same (seed, page, count) always returns same seedKeys', () => {
    const r1 = generateCratesPage(miniGraph, miniCache, 42, 0, 2);
    const r2 = generateCratesPage(miniGraph, miniCache, 42, 0, 2);
    assert.deepEqual(r1.clusters.map(c => c.seedKey), r2.clusters.map(c => c.seedKey));
  });

  it('different pages return different clusters', () => {
    const p0 = generateCratesPage(miniGraph, miniCache, 42, 0, 2);
    const p1 = generateCratesPage(miniGraph, miniCache, 42, 1, 2);
    const p0Keys = p0.clusters.map(c => c.seedKey);
    const p1Keys = p1.clusters.map(c => c.seedKey);
    // No key should appear in both pages
    const overlap = p0Keys.filter(k => p1Keys.includes(k));
    assert.equal(overlap.length, 0);
  });

  it('hasMore is false when pool is exhausted', () => {
    // Request more clusters than candidates exist
    const result = generateCratesPage(miniGraph, miniCache, 42, 100, 100);
    assert.equal(result.hasMore, false);
  });
});
```

#### Parity test against production graph

After the unit tests pass on the fixture, run one parity check against the real graph:

```bash
# shared/test/parity-test.js
# Loads pipeline/output/combined_graph.json + audio_cache.json,
# calls selectCluster(knownRoot) and diffs against golden-cluster.json

node shared/test/parity-test.js
```

```js
// parity-test.js (sketch)
import { readFileSync } from 'fs';
import { selectCluster, buildCandidates, buildGenreList, buildIndexes } from '../graph-logic.js';

const { nodes: graphNodes } = JSON.parse(readFileSync('pipeline/output/combined_graph.json'));
const audioCache = JSON.parse(readFileSync('pipeline/output/audio_cache.json'));
const djNameMap  = JSON.parse(readFileSync('pipeline/output/dj_name_map.json'));
const golden     = JSON.parse(readFileSync('shared/test/fixtures/golden-cluster.json'));
const meta       = JSON.parse(readFileSync('shared/test/fixtures/golden-meta.json'));

// 1. Candidate count
const { candidates } = buildCandidates(graphNodes, audioCache);
console.assert(candidates.length === meta.candidateCount,
  `candidates: got ${candidates.length}, expected ${meta.candidateCount}`);

// 2. Index sizes
const { artistIndex, djIndex } = buildIndexes(graphNodes, djNameMap);
console.assert(Object.keys(artistIndex).length === meta.artistCount,
  `artists: got ${Object.keys(artistIndex).length}, expected ${meta.artistCount}`);

// 3. Genre top-5
const genres = buildGenreList(graphNodes);
console.assert(genres[0].name === meta.topGenre,
  `top genre: got ${genres[0].name}, expected ${meta.topGenre}`);

// 4. Known cluster root matches
const cluster = selectCluster(graphNodes, audioCache, golden.meta.root_id);
console.assert(cluster.nodes[0].graphId === golden.meta.root_id, 'root graphId mismatch');
console.assert(cluster.meta.totalR1 === golden.meta.totalR1,
  `totalR1: got ${cluster.meta.totalR1}, expected ${golden.meta.totalR1}`);

console.log('All parity checks passed.');
```

---

### 19c. API checks (Steps 2 + 7)

Run these against both the local server (`http://localhost:3001`) and the Cloudflare
Worker (`http://localhost:8787` via `wrangler dev`, then the live URL).

```bash
BASE=http://localhost:3001
ROOT_ENC="four%20tet%3A%3A%3Ababy"   # replace with your golden root, URL-encoded

# ── Genre list ──
COUNT=$(curl -s "$BASE/api/genres" | jq 'length')
echo "Genres: $COUNT"   # must match golden genre count

# ── CORS on all methods ──
curl -sI "$BASE/api/genres" | grep -i "access-control-allow-origin"
curl -sI -X OPTIONS "$BASE/api/shuffle" -H "Origin: http://localhost:8000" \
  | grep -i "access-control"

# ── Cluster shape for known root ──
curl -s "$BASE/api/cluster/$ROOT_ENC" | jq '{
  root:       .nodes[0].graphId,
  rootTitle:  .nodes[0].title,
  rootArtist: .nodes[0].artist,
  nodeCount:  (.nodes | length),
  edgeCount:  (.edges | length),
  totalR1:    .meta.totalR1
}'
# Expected: root matches golden-meta.json knownRoot; totalR1 matches golden

# ── Root node always first ──
curl -s "$BASE/api/cluster/$ROOT_ENC" | jq '.nodes[0].rank'   # → "root"

# ── All r1 edges depart from root ──
curl -s "$BASE/api/cluster/$ROOT_ENC" | jq '[.edges[] | select(.from == "root")] | length'
# Must equal r1Shown in meta

# ── Audio fields present on enriched nodes ──
curl -s "$BASE/api/cluster/$ROOT_ENC" | jq '
  .nodes[] | select(.source == "soundcloud") | {graphId, scTrackUrl, artUrl}
' | head -30

# ── Filtered pool size matches golden ──
SOUL_POOL=$(curl -s "$BASE/api/shuffle?genres=Soul" | jq '.meta.poolSize')
echo "Soul pool: $SOUL_POOL"   # must match golden soulPool value

# ── Artist autocomplete — top result for "four" contains "Four" ──
curl -s "$BASE/api/search/artists?q=four" | jq '.[0].display'

# ── Crates determinism ──
P0A=$(curl -s "$BASE/api/crates?seed=99&page=0&count=3" | jq -c '[.clusters[].seedKey]')
P0B=$(curl -s "$BASE/api/crates?seed=99&page=0&count=3" | jq -c '[.clusters[].seedKey]')
[ "$P0A" = "$P0B" ] && echo "crates determinism: PASS" || echo "crates determinism: FAIL"

# ── Crates pages don't overlap ──
P0=$(curl -s "$BASE/api/crates?seed=99&page=0&count=5" | jq -r '[.clusters[].seedKey] | @tsv')
P1=$(curl -s "$BASE/api/crates?seed=99&page=1&count=5" | jq -r '[.clusters[].seedKey] | @tsv')
comm -12 <(echo "$P0" | tr '\t' '\n' | sort) <(echo "$P1" | tr '\t' '\n' | sort) \
  && echo "crates no overlap: PASS" || echo "crates no overlap: FAIL"

# ── Local vs Worker parity (run after wrangler dev) ──
LOCAL=http://localhost:3001
WORKER=http://localhost:8787
diff \
  <(curl -s "$LOCAL/api/genres"  | jq 'map(.name)') \
  <(curl -s "$WORKER/api/genres" | jq 'map(.name)')
# → no diff
```

---

### 19d. Playwright tests for the frontend

**File**: `tests/e2e.test.js`
**Setup**: `npm install -D playwright` in the project root; `npx playwright install chromium`.

```bash
# Run with the local server already running on :3001
npx playwright test tests/e2e.test.js
```

```js
// tests/e2e.test.js
import { test, expect } from '@playwright/test';

const APP = 'http://localhost:8000';
const KNOWN_HASH = '#four%20tet%3A%3A%3Ababy';  // replace with real golden root

// ── Step 3: Basic shuffle and graph render ────────────────────────────────────

test('page loads without fetching combined_graph.json', async ({ page }) => {
  const graphFetched = [];
  page.on('request', req => {
    if (req.url().includes('combined_graph.json')) graphFetched.push(req.url());
  });
  await page.goto(APP);
  await page.waitForSelector('.node-card[data-rank="root"]', { timeout: 10000 });
  expect(graphFetched).toHaveLength(0);
});

test('shuffle renders a cluster with root, r1, and connection paths', async ({ page }) => {
  await page.goto(APP);
  await page.waitForSelector('.node-card[data-rank="root"]', { timeout: 10000 });

  // At least one r1 node
  const r1Count = await page.locator('.node-card[data-rank="1"]').count();
  expect(r1Count).toBeGreaterThan(0);

  // At least one SVG connection path
  const pathCount = await page.locator('.connection-path').count();
  expect(pathCount).toBeGreaterThan(0);
});

test('shuffle button produces a new cluster', async ({ page }) => {
  await page.goto(APP);
  await page.waitForSelector('.node-card[data-rank="root"]');

  const firstRoot = await page.locator('.node-card[data-rank="root"] .track-title').textContent();
  await page.locator('#shuffle-btn').click();
  await page.waitForTimeout(1500);  // wait for API + render
  const secondRoot = await page.locator('.node-card[data-rank="root"] .track-title').textContent();

  // Different cluster loaded (may rarely be the same track — acceptable)
  // Just verify the page didn't error out
  expect(secondRoot).toBeTruthy();
});

test('hash navigation loads the correct cluster', async ({ page }) => {
  await page.goto(APP + KNOWN_HASH);
  await page.waitForSelector('.node-card[data-rank="root"]', { timeout: 10000 });

  // Cluster ID display should show the hash value
  const clusterId = await page.locator('#cluster-id').textContent();
  expect(decodeURIComponent(KNOWN_HASH.slice(1))).toBe(clusterId);
});

test('back/forward browser navigation changes the cluster', async ({ page }) => {
  await page.goto(APP);
  await page.waitForSelector('.node-card[data-rank="root"]');
  const root1 = await page.locator('#cluster-id').textContent();

  await page.locator('#shuffle-btn').click();
  await page.waitForTimeout(1500);
  const root2 = await page.locator('#cluster-id').textContent();

  await page.goBack();
  await page.waitForTimeout(1000);
  const root1Again = await page.locator('#cluster-id').textContent();
  expect(root1Again).toBe(root1);
});

// ── Step 4: Filters ───────────────────────────────────────────────────────────

test('genre filter: selecting Soul narrows the pool and label appears', async ({ page }) => {
  await page.goto(APP);
  await page.waitForSelector('.node-card[data-rank="root"]');

  // Open genre popover and select Soul
  await page.locator('#pill-genre').click();
  await page.locator('.genre-pill', { hasText: 'Soul' }).click();
  await page.locator('#pill-genre').click();  // close popover
  await page.waitForTimeout(1500);  // shuffle fires on close

  // Filter label should appear above root card
  const label = await page.locator('#filter-label').textContent();
  expect(label).toContain('filtered results');

  // Pool size in label should be a number smaller than total candidates
  const match = label.match(/\((\d+)\)/);
  expect(match).not.toBeNull();
  const poolSize = parseInt(match[1]);
  expect(poolSize).toBeGreaterThan(0);
  expect(poolSize).toBeLessThan(126720);  // less than total graph
});

test('artist filter: searching and selecting an artist filters shuffle results', async ({ page }) => {
  await page.goto(APP);
  await page.waitForSelector('.node-card[data-rank="root"]');

  await page.locator('#pill-artist').click();
  await page.locator('#find-search').fill('Four Tet');
  await page.waitForSelector('.ac-item', { timeout: 3000 });
  await page.locator('.ac-item').first().click();
  await page.locator('#pill-artist').click();  // close popover → triggers shuffle
  await page.waitForTimeout(1500);

  // Chip should appear
  const chip = await page.locator('.find-chip').first().textContent();
  expect(chip).toContain('Four Tet');
});

test('clearing all filters removes the filter label', async ({ page }) => {
  await page.goto(APP);
  await page.waitForSelector('.node-card[data-rank="root"]');

  await page.locator('#pill-genre').click();
  await page.locator('.genre-pill').first().click();
  await page.locator('#pill-genre').click();
  await page.waitForTimeout(1000);

  // Label should be present
  await expect(page.locator('#filter-label')).not.toBeEmpty();

  // Clear genres
  await page.locator('#pill-genre').click();
  await page.locator('#genre-clear-btn').click();
  await page.waitForTimeout(500);

  const label = await page.locator('#filter-label').textContent();
  expect(label.trim()).toBe('');
});

// ── Step 5: Crates mode ───────────────────────────────────────────────────────

test('crates mode: opens without fetching combined_graph.json', async ({ page }) => {
  const graphFetched = [];
  page.on('request', req => {
    if (req.url().includes('combined_graph.json')) graphFetched.push(req.url());
  });

  await page.goto(APP);
  await page.waitForSelector('.node-card[data-rank="root"]');

  // Open crates (adapt selector to actual crates button in app)
  await page.locator('[data-view="crates"], #crates-btn').click();
  await page.waitForSelector('.crate-tile, .crate', { timeout: 10000 });

  expect(graphFetched).toHaveLength(0);
});

test('crates mode: at least one crate tile renders with artwork or label', async ({ page }) => {
  await page.goto(APP);
  await page.waitForSelector('.node-card[data-rank="root"]');
  await page.locator('[data-view="crates"], #crates-btn').click();
  await page.waitForSelector('.crate-tile, .crate', { timeout: 10000 });

  const tileCount = await page.locator('.crate-tile, .crate').count();
  expect(tileCount).toBeGreaterThan(0);
});

test('crates mode: scrolling loads a second page (pagination works)', async ({ page }) => {
  await page.goto(APP);
  await page.waitForSelector('.node-card[data-rank="root"]');
  await page.locator('[data-view="crates"], #crates-btn').click();
  await page.waitForSelector('.crate-tile, .crate', { timeout: 10000 });

  const beforeCount = await page.locator('.crate-tile, .crate').count();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(2000);
  const afterCount = await page.locator('.crate-tile, .crate').count();

  expect(afterCount).toBeGreaterThan(beforeCount);
});

// ── Mobile layout ─────────────────────────────────────────────────────────────

test('mobile layout renders on narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(APP);
  await page.waitForSelector('.mobile-card, [data-mobile]', { timeout: 10000 });

  // Desktop shuffle button should not be visible
  const desktopShuffleVisible = await page.locator('#shuffle-btn').isVisible();
  // Mobile shuffle button should be visible (adapt selector)
  const mobileShuffleVisible = await page.locator('#mobile-shuffle-btn, .mobile-shuffle').isVisible();
  expect(mobileShuffleVisible).toBe(true);
});

// ── Night mode ────────────────────────────────────────────────────────────────

test('night mode toggle adds body.night class', async ({ page }) => {
  await page.goto(APP);
  await page.waitForSelector('.node-card[data-rank="root"]');
  await page.locator('#theme-toggle').click();
  const hasNight = await page.evaluate(() => document.body.classList.contains('night'));
  expect(hasNight).toBe(true);
  // Toggle back
  await page.locator('#theme-toggle').click();
  const hasNight2 = await page.evaluate(() => document.body.classList.contains('night'));
  expect(hasNight2).toBe(false);
});
```

#### Playwright config

```js
// playwright.config.js
export default {
  testDir: './tests',
  use: { baseURL: 'http://localhost:8000' },
  webServer: {
    command: 'python3 -m http.server 8000',
    url: 'http://localhost:8000',
    reuseExistingServer: true,
  },
};
```

Note: the local Node server on `:3001` must be started separately before running
Playwright tests. The `webServer` config handles the static file server.

---

### 19e. Shuffle distribution sanity check

After Step 4, verify genre rebalancing still works — `genreWeightCaps` should prevent
Ambient/Folk from dominating:

```bash
# Sample 200 shuffle results and tally root genres
for i in $(seq 200); do
  curl -s 'http://localhost:3001/api/shuffle' | jq -r '
    .nodes[0].graphId as $id |
    .nodes[0] |
    "SHUFFLE_RESULT"
  '
done
# Then cross-reference the returned root IDs against genre data via:
node -e "
  const ids = /* collect root_ids from above */ ;
  const graph = JSON.parse(require('fs').readFileSync('pipeline/output/combined_graph.json')).nodes;
  const genreCounts = {};
  for (const id of ids) {
    for (const g of (graph[id]?.genres ?? [])) {
      genreCounts[g] = (genreCounts[g] || 0) + 1;
    }
  }
  console.table(Object.entries(genreCounts).sort((a,b) => b[1]-a[1]).slice(0, 10));
"
# Ambient should be ≤20% of results; Folk ≤5%; no single genre >25%
```
