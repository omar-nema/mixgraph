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
| `crates-worker.js:81` | `cratesTreemap()` | Move server-side for simplicity |

### Stays client-side

| Function | Reason |
|---|---|
| `computeLayout()` (`graph.js:393`) | Needs DOM measurements (`el.offsetHeight`) |
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

Generate a page of crates clusters. Fully deterministic — same `seed` + `page` always
returns the same clusters. See §12 for the pagination design.

**Query params**:
- `seed` — integer seed for deterministic shuffle (required)
- `page` — page number, 0-indexed (default 0)
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

**`crates-worker.js` changes**:
- Remove `initFromUrls()` and all graph/cache fetching
- Worker receives `postMessage({ type: 'request', page, count, vw, vh, seed })`, calls
  `api.getCratesPage(...)`, returns result to main thread
- The worker still exists to keep crates off the main thread, but it's now thin

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

## 12. Crates Mode: Deterministic Pagination

The current `crates-worker.js` uses a seeded LCG (`crateRand()`) but tracks `usedNodes`
and `seedIdx` as mutable state across page fetches. The server is stateless, so page N
must be derivable from `(seed, page, count)` alone — no growing state.

**Solution**: fast-forward the RNG.

The LCG in `crates-worker.js:11`:
```js
function crateRand() {
  crateSeed = (crateSeed * 16807) % 2147483647;
  return (crateSeed - 1) / 2147483646;
}
```

To generate page N with `count` items per page, fast-forward past the first `N * count`
clusters by re-running the shuffle from scratch up to that offset. Since the LCG is cheap
(nanoseconds per call), fast-forwarding 1000 clusters takes ~microseconds.

The key change: **drop `usedNodes` overlap tracking entirely.** That was an optimization
to avoid showing the same track in two crates on the same screen. It's not a correctness
requirement — a slight overlap between adjacent crates is acceptable. Without `usedNodes`,
`generateClusters(seed, page, count)` is fully deterministic:

```js
// In shared/graph-logic.js
export function generateCratesPage(graphNodes, audioCache, seed, page, count) {
  // 1. Build shuffled seed pool deterministically from seed
  let rngState = seed;
  function rng() {
    rngState = (rngState * 16807) % 2147483647;
    return (rngState - 1) / 2147483646;
  }
  const seedPool = buildSeedPool(graphNodes, rng);  // same shuffle logic as before

  // 2. Fast-forward: skip first page * count valid clusters
  const startIdx = page * count;
  let clusterCount = 0;
  let poolIdx = 0;
  while (clusterCount < startIdx && poolIdx < seedPool.length) {
    const cluster = buildCluster(graphNodes, seedPool[poolIdx++], rng);
    if (cluster) clusterCount++;
  }

  // 3. Generate `count` clusters from current position
  const clusters = [];
  while (clusters.length < count && poolIdx < seedPool.length) {
    const cluster = buildCluster(graphNodes, seedPool[poolIdx++], rng);
    if (cluster) clusters.push(cluster);
  }

  // 4. treemap layout inline
  cratesTreemap(clusters, pad, pad, vw - pad*2, vh - pad*2);

  return { clusters, hasMore: poolIdx < seedPool.length };
}
```

The `cratesTreemap` function stays in `shared/graph-logic.js` — it's pure math, no graph
data needed, but co-locating it simplifies the API (server returns positioned rects,
client just renders).

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
