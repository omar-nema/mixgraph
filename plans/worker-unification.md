# Worker unification: make worker/index.js a thin adapter over shared/graph-logic.js

## Problem

`worker/index.js` (573 lines) reimplements most of the logic in `shared/graph-logic.js` (525 lines) from scratch. The worker version diverges because it reads nodes from KV one at a time (async) while the shared functions take a `graphNodes` object (sync, in-memory). This duplication caused the R2 slot validation bug and makes every behavior change a two-file edit.

Goal: worker/index.js becomes ~150 lines (routing, KV caching, CORS) -- the same shape as local-server.js.

---

## 1. The accessor pattern

Replace every `graphNodes[id]` lookup with a `getNode(id)` function parameter. This is the only structural change to shared/graph-logic.js.

**Before:**
```js
export function getNeighbors(graphNodes, nodeId, exclude) {
  const node = graphNodes[nodeId];
  if (!node) return [];
  return node.edges
    .map(e => e.node)
    .filter(id => id in graphNodes && !exclude.has(id));
}
```

**After:**
```js
export async function getNeighbors(getNode, nodeId, exclude) {
  const node = await getNode(nodeId);
  if (!node) return [];
  // For the "id in graphNodes" filter, we can't check existence without fetching.
  // Two options: (a) fetch all neighbors to validate, or (b) skip validation and
  // let downstream handle nulls. Go with (b) -- callers already null-check.
  return node.edges
    .map(e => e.node)
    .filter(id => !exclude.has(id));
}
```

The `getNode` function signature: `async (id) => nodeObject | null`

**For local-server.js**, the accessor wraps the in-memory object:
```js
const getNode = (id) => Promise.resolve(graphNodes[id] || null);
```

**For worker/index.js**, the accessor reads from KV:
```js
const getNode = (id) => env.GRAPH_KV.get(`node:${id}`, 'json');
```

### Node shape contract

Both accessors must return the same shape. Currently they don't:
- Local server nodes have graph fields (`title`, `artist`, `genres`, `edges`) separate from audio fields (in `audioCache`)
- KV nodes have everything merged (build_kv.js merges graph + audio into one object)

Two options:
1. **Merge at accessor time (local server)** -- the local `getNode` merges `graphNodes[id]` + `audioCache[id]` into one object on the fly
2. **Keep them separate** -- pass `audioCache` or a `getAudio` accessor alongside `getNode`

**Go with option 1.** The KV nodes already have the merged shape. Make the local accessor match:
```js
function makeGetNode(graphNodes, audioCache) {
  return (id) => {
    const node = graphNodes[id];
    if (!node) return Promise.resolve(null);
    const cached = audioCache[id] || {};
    return Promise.resolve({
      ...node,
      source: cached.source || 'not_found',
      scTrackUrl: cached.scTrackUrl || null,
      artUrl: cached.artUrl || null,
      setUrl: cached.setUrl || null,
      setSource: cached.setSource || null,
      setOffsetSec: cached.setOffsetSec || null,
      setDj: cached.setDj || null,
    });
  };
}
```

This eliminates the separate `enrichFromCache` step and the worker's `enrichNodeFromKV` function -- both become unnecessary because the node already arrives with audio fields.

---

## 2. Which shared functions need to change and how

### Must become async (take `getNode` instead of `graphNodes`)

| Function | Changes | Notes |
|----------|---------|-------|
| `getNeighbors` | `await getNode(nodeId)`, drop the `id in graphNodes` existence filter | Callers handle nulls downstream |
| `getEdgeContext` | `await getNode(fromId)` | Simple, one lookup |
| `collectDjs` | `await getNode(graphId)` | Simple, one lookup |
| `selectCluster` | Big one. Take `getNode` instead of `graphNodes`. Rewrite `makeNode` to use `await getNode`. Batch neighbor fetches with `Promise.all` for performance | See detailed walkthrough below |
| `cratesBfs` | `await getNode(key)` inside BFS loop. Use level-by-level `Promise.all` like worker already does | Performance-critical |
| `estimateClusterSize` | `await getNode(seedKey)` + `await Promise.all` for R1 nodes | Minor |
| `generateCratesPage` | Already calls other functions that become async, so it becomes async too | Wrapper |

### Stay sync (no node lookups)

| Function | Why |
|----------|-----|
| `shuffleArray` | Pure utility |
| `splitArtists` | Pure string parsing |
| `enrichFromCache` | **Delete.** No longer needed -- audio data is on the node itself |
| `matchesSourceFilter` | Rewrite to check node fields directly instead of audioCache lookup |
| `getFilteredPool` | **Does NOT use getNode** -- operates on pre-computed candidate lists. Keep sync. See section 5 |
| `weightedPickFromPool` | Pure math on arrays. No change |
| `buildCandidates` | Startup-only, runs against full graph. Keep sync, keep `graphNodes` param |
| `buildIndexes` | Same -- startup-only, full graph scan |
| `buildGenreList` | Same |
| `cratesTreemap` | Pure layout math |

### selectCluster -- detailed rewrite

The current flow:
1. Look up root node
2. Get R1 neighbors (edge list from root)
3. For each R1 candidate, check if it has children (requires fetching the R1 node)
4. Select R1 nodes, then for each get R2 candidates
5. Enrich all nodes from audio cache

New flow with `getNode`:
1. `const rootNode = await getNode(rootId)` -- single fetch
2. R1 candidate IDs from `rootNode.edges` -- no fetch needed, just read edge list
3. `await Promise.all(r1CandidateIds.map(getNode))` -- batch fetch all R1 candidates
4. Filter + shuffle + select R1, then collect R2 candidate IDs
5. `await Promise.all(r2CandidateIds.map(getNode))` -- batch fetch all R2 candidates
6. Build cluster nodes from already-fetched data (no `enrichFromCache`, fields are on the node)

Total KV reads: 1 (root) + N (R1 candidates) + M (R2 candidates). Same as what the worker does now, but using shared code.

**Key fix for R2 slot validation bug:** In `makeNode`, validate the fetched node before assigning a local ID:
```js
// Current worker bug (line 162-163): reserves ID before validation
usedIds.add(r2Picks[j]);  // reserved!
// ... then line 173 skips if unplayable, but ID is already consumed

// Fixed in shared selectCluster:
const r2Node = await getNode(r2GraphId);
if (!r2Node) continue;                              // skip missing
if (!r2Node.scTrackUrl && !r2Node.setUrl) continue;  // skip unplayable
usedIds.add(r2GraphId);                              // only NOW reserve
```

Wait -- actually, the shared `selectCluster` currently doesn't do playability checks at all (it delegates that to `enrichFromCache` after the fact). The worker added playability filtering inline. After unification, the shared code should adopt the worker's playability filtering (skip nodes where `!scTrackUrl && !setUrl`) inside the BFS loop, since audio data is now on the node.

---

## 3. How worker/index.js becomes a thin adapter

After the refactor, worker/index.js drops to roughly this shape:

```
~20 lines  CORS + helpers (jsonResponse, csvParam, searchList -- or import searchList)
~10 lines  KV caching for index blobs
~80 lines  Route handlers calling shared functions
~15 lines  Event tracking (worker-only, stays inline)
~10 lines  Error handling + export
```

### What stays in the worker:

- **`getNode` accessor**: `(id) => env.GRAPH_KV.get(\`node:\${id}\`, 'json')`
- **Index blob caching**: Module-level `let _candidates = null` etc., loaded from KV on first request. These replace `buildCandidates` / `buildIndexes` / `buildGenreList` at the worker level -- the worker reads pre-computed blobs, it doesn't recompute them.
- **Route handlers**: Thin wrappers that parse query params and call shared functions.
- **`clusterMeetsMinimum` + re-roll loop**: This logic only exists in the worker (local server doesn't re-roll). Keep it in the worker adapter.
- **`/api/crates-index`**: Worker-only endpoint (reads a pre-computed KV blob). Stays in worker.
- **`/api/event`**: Analytics Engine. Worker-only.
- **CORS handling**: Worker-only (Express has its own cors middleware).

### What gets deleted from the worker:

- `collectDjsFromNode` (use shared `collectDjs`)
- `getEdgeContextFromNode` (use shared `getEdgeContext`)
- `shuffleArray` (use shared)
- `enrichNodeFromKV` (eliminated by merged node shape)
- `selectClusterFromKV` (use shared `selectCluster`)
- Inline BFS for crates (use shared `generateCratesPage`)
- Inline filtering logic for shuffle (use shared `getFilteredPool` + `weightedPickFromPool`)

### shuffle route example:

```js
if (url.pathname === '/api/shuffle') {
  const candidates = await getCandidates(env.GRAPH_KV);
  const filters = { source: q.get('source'), genres: csvParam(q.get('genres')), ... };
  const exclude = new Set(csvParam(q.get('exclude')));
  const r1 = parseInt(q.get('r1')) || 4;
  const r2 = parseInt(q.get('r2')) || 1;

  // getFilteredPool works on enriched candidates (no getNode needed)
  const pool = getFilteredPool(candidates, filters);
  let unseen = pool.filter(c => !exclude.has(c.id));
  if (unseen.length === 0) unseen = pool;

  const picked = weightedPickFromPool(unseen, ...);
  const getNodeFn = (id) => env.GRAPH_KV.get(`node:${id}`, 'json');
  const cluster = await selectCluster(getNodeFn, picked.id, r1, r2, djNameMap);
  return jsonResponse(cluster);
}
```

---

## 4. How local-server.js adapts

Minimal changes. local-server.js already imports everything from shared. The only updates:

1. **Create the accessor:**
   ```js
   const getNode = makeGetNode(graphNodes, audioCache);
   ```

2. **Await shared function calls** -- every `selectCluster(...)` becomes `await selectCluster(getNode, ...)`, every `generateCratesPage(...)` becomes `await generateCratesPage(getNode, ...)`.

3. **Route handlers become async:**
   ```js
   app.get('/api/shuffle', async (req, res) => { ... });
   ```

4. **Drop `audioCache` from direct calls** -- it's now inside the accessor. `selectCluster` no longer takes `audioCache` as a separate parameter.

Everything else stays the same. The pre-computed indexes (`candidates`, `artistListAlpha`, etc.) are still built at startup from the full `graphNodes` object -- that path doesn't use the accessor.

---

## 5. Pre-computed indexes and candidates

### The asymmetry

- **Local server**: calls `buildCandidates(graphNodes, audioCache)` at startup, gets `{ candidates: string[], candidateWeights, idxMap }`. These are arrays of node IDs with weights computed from the full graph.
- **Worker**: reads `candidates` blob from KV -- an array of enriched objects (`{ id, w, g, s, st, ss, a, e, d }`) pre-computed by `build_kv.js`.

### Approach: keep the two paths, unify the interface

`getFilteredPool` currently takes `graphNodes` and `audioCache` because it needs to check genres, artists, DJs, and source for each candidate. In the worker, this data is pre-baked into the enriched candidate objects.

**Option A: Make getFilteredPool work on enriched candidate objects.** Both local server and worker produce the same enriched shape. Local server computes them at startup, worker reads them from KV. `getFilteredPool` takes a list of enriched candidates instead of `graphNodes` + `audioCache` + `candidates`.

This is the cleanest path. Change `buildCandidates` to return enriched objects (same shape as build_kv.js produces), and change `getFilteredPool` to operate on those objects.

**Option B: Keep getFilteredPool using graphNodes.** The worker can't call it (no full graph). Keep separate filtering implementations.

**Go with Option A.** The enriched candidate shape is already well-defined in build_kv.js. Move that enrichment logic into `buildCandidates` in shared/graph-logic.js so both paths produce the same array.

### buildCandidates changes:

```js
// Returns: { candidates: EnrichedCandidate[], candidateWeights: ..., idxMap: ... }
// Where EnrichedCandidate = { id, w, g, s, st, ss, a, e, d }
export function buildCandidates(graphNodes, audioCache, djNameMap) {
  // ... existing filtering logic ...
  // ... existing weight computation ...
  // Return enriched objects instead of bare IDs
  return { candidates: enrichedCandidates, candidateWeights, idxMap };
}
```

Then `getFilteredPool` signature becomes:
```js
export function getFilteredPool(candidates, filters) {
  // candidates is EnrichedCandidate[]
  // Filter on c.g (genres), c.a (artists), c.d (DJs), c.s/c.st/c.ss (source)
}
```

`weightedPickFromPool` stays roughly the same but works on enriched candidates (weight is `c.w`).

**build_kv.js** can then import `buildCandidates` and get the enriched candidates directly, removing the manual enrichment loop it currently has.

---

## 6. Migration strategy -- incremental

This can and should be done incrementally. Each step is independently deployable.

### Phase 1: Unify the candidate/filtering layer (no async changes)

1. **Refactor `buildCandidates`** to return enriched candidate objects (merge the enrichment from build_kv.js into shared/graph-logic.js). Add `djNameMap` parameter.
2. **Refactor `getFilteredPool`** to work on enriched candidate objects instead of `graphNodes` + `audioCache`.
3. **Refactor `weightedPickFromPool`** to work on enriched candidates.
4. **Update local-server.js** to use the new signatures.
5. **Update build_kv.js** to use the new `buildCandidates` output directly.
6. **Update worker/index.js** to import and use `getFilteredPool` + `weightedPickFromPool` from shared.

At this point the worker's shuffle filtering and weighted picking use shared code. The worker still has its own `selectClusterFromKV` and crates BFS.

**Test**: deploy worker, verify /api/shuffle returns same results. Run local server, verify same.

### Phase 2: Make graph traversal functions async (the accessor pattern)

1. **Add `getNode` parameter** to `getNeighbors`, `getEdgeContext`, `collectDjs`. Make them async.
2. **Make `selectCluster` async**, taking `getNode` instead of `graphNodes` + `audioCache`. Include playability filtering (from worker).
3. **Update local-server.js** -- create `makeGetNode`, await the calls.
4. **Update worker/index.js** -- replace `selectClusterFromKV` with shared `selectCluster(getNode, ...)`. Delete `collectDjsFromNode`, `getEdgeContextFromNode`, `enrichNodeFromKV`, `selectClusterFromKV`.

**Test**: deploy worker, verify /api/cluster/:id and /api/shuffle return valid clusters. Compare output shape with before.

### Phase 3: Unify crates

1. **Make `cratesBfs` async** -- level-by-level `Promise.all` for KV compatibility (already done in worker).
2. **Make `generateCratesPage` async**, taking `getNode`.
3. **Update worker/index.js** -- replace inline crates BFS with shared `generateCratesPage`. Delete all crates-related code from worker.
4. **Update local-server.js** -- await `generateCratesPage`.

**Test**: verify /api/crates returns same shape. Compare crate artwork counts.

### Phase 4: Cleanup

1. Delete `enrichFromCache` from shared (no longer used).
2. Delete `matchesSourceFilter` or fold it into `getFilteredPool`.
3. Move `searchList` and `csvParam` to shared if desired (they're duplicated but trivial).
4. Verify worker/index.js is ~150 lines.

---

## 7. How this fixes the R2 slot validation bug

The bug in `worker/index.js` lines 161-173:

```js
// Lines 161-163: Reserve R2 IDs BEFORE fetching/validating
const r2Picks = r2Candidates.slice(0, r2Limit);
for (let j = 0; j < r2Picks.length; j++) {
  usedIds.add(r2Picks[j]);  // <-- reserved before we know if node exists
  r2Fetches.push({ ... });
}

// Lines 170-173: Fetch and validate AFTER reservation
const r2KVs = await Promise.all(r2Fetches.map(f => getNode(kv, f.r2Id)));
for (let k = 0; k < r2Fetches.length; k++) {
  if (!r2KVs[k]) continue;                              // node missing -- but ID already consumed
  if (!r2KVs[k].scTrackUrl && !r2KVs[k].setUrl) continue; // unplayable -- ID already consumed
```

When a reserved R2 ID turns out to be missing or unplayable, that slot is wasted. No other R2 candidate can take it because `usedIds` already claims it's used.

The shared `selectCluster` (after refactor) fixes this by structure: the `makeNode` helper fetches and validates before adding to `usedIds`:

```js
const r2Candidates = getNeighbors(r1Node, usedIds);  // edges not in usedIds
shuffleArray(r2Candidates);

// Fetch batch, then iterate with validation
const r2Nodes = await Promise.all(r2Candidates.slice(0, r2Limit * 2).map(getNode));
let r2Added = 0;
for (let j = 0; j < r2Nodes.length && r2Added < r2Limit; j++) {
  const r2Node = r2Nodes[j];
  if (!r2Node) continue;
  if (!r2Node.scTrackUrl && !r2Node.setUrl) continue;
  usedIds.add(r2Candidates[j]);  // only after validation
  // ... build cluster node ...
  r2Added++;
}
```

Key change: fetch a slightly larger batch of R2 candidates (e.g., `r2Limit * 2`), then iterate until `r2Limit` valid ones are found. This means over-fetching slightly but guarantees slots aren't wasted on invalid nodes.

---

## 8. Risks and things to watch out for

### Performance: KV read count for selectCluster

The shared `selectCluster` will do `Promise.all` for R1 and R2 fetches, same as the worker already does. No regression. But the `getNeighbors` filter (`id in graphNodes`) currently validates that neighbor IDs actually exist in the graph. With KV we can't do this check without fetching. Two options:
- **Skip the check** (recommended) -- build_kv.js already only writes valid nodes, so edges pointing to non-existent nodes are rare. The downstream `getNode` call returns null and we skip.
- **Validate by fetching** -- too many KV reads, not worth it.

### Performance: cratesBfs KV reads

`cratesBfs` with a `size` of 15-55 nodes means 3-5 levels of BFS, each with a `Promise.all` frontier fetch. This could be 50+ KV reads per crate cluster, and a page has 12 clusters. That's 600+ KV reads per crates request. The worker already does this and it works, but monitor latency. The `crates-index` endpoint (client-side crates) avoids this entirely and should remain the primary path.

### Existence check in getNeighbors

Current shared code: `filter(id => id in graphNodes && !exclude.has(id))`. The `in graphNodes` check is free when you have the full graph. With KV, we can't do this without fetching every neighbor. Drop this check and rely on null handling downstream. This is a minor behavior change -- a cluster could theoretically include an edge pointing to a node that doesn't exist in KV (because it was skipped during build_kv due to key length). But `getNode` returns null for those, and `makeNode` skips nulls.

### Crates page skipping

The shared `generateCratesPage` replays all previous pages to build `usedNodes` before producing the current page (O(page) work). The worker currently does direct page slicing (line 396: `startIdx = page * count`) with no replay. This is a deliberate divergence -- the worker version is faster but produces slightly different results (no cross-page dedup via `usedNodes`).

Decision: **adopt the worker's direct slicing approach** in the shared function. Cross-page dedup was never reliable anyway (crates are randomized), and the performance win matters at page 20+.

### Enriched candidate shape

The worker's enriched candidate objects use short keys (`g`, `s`, `st`, `a`, `e`, `d`) to minimize KV blob size. The shared code should use the same short keys for consistency, even though it's a bit less readable. Add a comment block documenting the shape.

### DJ name map loading

The worker loads `dj-name-map` from KV and caches it module-level. The local server loads it from disk at startup. After unification, `selectCluster` needs the djNameMap to build DJ pills. Options:
- Pass `djNameMap` as a parameter to `selectCluster` (current approach, keep it)
- Bake DJ names into the node at KV build time (would avoid the extra parameter but changes the node shape)

**Keep passing djNameMap.** It's already there, and baking it into nodes would balloon KV storage.

### Worker-only features

Some things exist only in the worker and don't need to move to shared:
- `clusterMeetsMinimum` + re-roll loop (quality gate for random clusters)
- `/api/crates-index` (pre-computed blob, no computation)
- `/api/event` (analytics)
- CORS headers

These stay in worker/index.js.

### Testing strategy

- After each phase, compare API responses between local server and deployed worker for the same inputs
- Specific test cases:
  - Shuffle with no filters
  - Shuffle with genre + artist + DJ filters combined
  - Shuffle with source filter
  - Cluster for a known node ID
  - Cluster with expand=2
  - Crates page 0, page 5, page 20
  - Edge case: node with no playable R2 neighbors (validates the slot fix)
