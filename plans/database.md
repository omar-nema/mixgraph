# Plan: Shard Graph Data for Lazy Loading

## Problem

combined_graph.json is 79 MB and growing. GitHub warns at 50 MB, hard-blocks at 100 MB. The client also downloads the entire file on first load. Need a solution that supports ~300 MB of data, is free, and low-maintenance.

## Recommendation: Split into ~5 MB JSON shards, serve from GitHub Pages

### Why not a real database

- The frontend is static (GitHub Pages), no server to run queries
- The data is read-only from the frontend's perspective — no writes, no auth
- A database (Supabase, PlanetScale, etc.) adds a server dependency, API layer, and ongoing maintenance for what is essentially static file serving

### Approach

1. **Split combined_graph.json into ~5 MB shards** — e.g. by hash of node ID. Index file maps node IDs to shard filenames.
2. **Commit shards to the repo** — each shard is well under GitHub's 50 MB warning. Serve via GitHub Pages as-is.
3. **Lazy-load on the frontend** — load the index on startup (~1 MB), then fetch shards on demand as the user explores clusters. Cache fetched shards in memory.
4. **audio_cache.json gets the same treatment** — split and lazy-load.

### Migration steps

1. Write a `split_graph.py` script that shards the graph + audio cache into ~5 MB files + an index
2. Update frontend fetch logic to load index, then fetch shards lazily
3. Remove the monolithic JSON files from git, replace with shards directory
4. Update trim_graph.py to output shards instead of a single file

### Data budget at 300 MB

- combined_graph shards: ~200 MB (room to grow)
- audio_cache shards: ~50 MB
- Future data (artist metadata, genre index, etc.): ~50 MB

All fine for GitHub Pages. GitHub repo soft limit is ~1-5 GB.

### Frontend changes

**Index + skeleton file (~5-10 MB, loaded on startup)**

The index maps every node ID to its shard and includes a lightweight edge list for BFS:
```json
{
  "artist:::title": { "s": "shard_03", "e": ["neighbor1:::track", "neighbor2:::track"] },
  ...
}
```
At 125k nodes with ~2 edges avg, this is ~5-10 MB. Loaded once on startup. This is everything the frontend needs to run `selectCluster()` / BFS without touching any shards.

**Cluster loading (on shuffle / cluster select)**

1. `selectCluster()` runs BFS on the skeleton edges — picks ~9 node IDs. No change to the algorithm.
2. Look up which shard each node lives in. A cluster will typically span 2-4 shards.
3. Fetch all needed shards in parallel (`Promise.all`), skip any already in the in-memory cache.
4. Pull the full node data (title, artist, DJs, edge contexts) from the fetched shards.
5. Render cards as usual.

**Multi-shard clusters**

A cluster's 9 nodes will almost certainly span multiple shards. This is fine — all shard fetches happen in parallel, so latency is just one network round-trip. Once a shard is cached in memory, future clusters that overlap with it load instantly. Worst case is 9 shards (~45 MB) but in practice neighbors share episodes/DJs and tend to land in 2-4 shards.

**Audio cache**

Same pattern — split into shards, fetch on demand when a track is played. Lookup: check in-memory cache first, fetch shard if missing.

**What changes in code**

- `loadData()` → fetches index + skeleton instead of full graph
- `showCluster()` → becomes async, awaits shard fetches before rendering
- Audio playback → becomes async, fetches audio cache shard before playing
- New: in-memory shard cache (`Map<shardName, data>`)

**What doesn't change**

- `selectCluster()`, `renderCards()`, layout, CSS, all UI code
- Data shape inside each shard — same structure as today's graph nodes
- Dev panel, cluster limits, DJ search — all work the same once data is in memory

### Tradeoffs

- **Pro**: Zero cost, zero maintenance, no new infrastructure, stays on GitHub Pages
- **Pro**: Lazy loading means users only download data they need (~5-10 MB per session vs 80 MB upfront)
- **Pro**: Each shard under 50 MB, no GitHub warnings
- **Con**: Slightly more complex frontend fetch logic
- **Con**: Git history bloat if shards change frequently on rebuilds (mitigated by stable hashing)

### Future: Cloudflare R2

If total data outgrows GitHub's repo size limits (~1-5 GB) or shard rebuilds bloat git history, move shards to Cloudflare R2. Free tier: 10 GB storage, 10M reads/month, zero egress fees. The frontend fetch logic stays the same — just change the base URL.

### Alternative considered: SQLite + sql.js

Load a SQLite database in the browser via WebAssembly. Compact binary format, supports queries. But adds ~1 MB wasm overhead, more complex than JSON fetches, and doesn't solve the hosting problem (still need somewhere to put the .db file). Better suited if we ever need client-side querying.
