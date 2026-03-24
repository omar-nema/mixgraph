// Build KV bulk JSON from graph data for Cloudflare Workers KV upload.
// Reads pipeline/output/*.json, writes pipeline/output/kv-bulk-*.json
// (split into chunks because wrangler kv:bulk put has a 100MB limit per file)

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  buildCandidates, buildIndexes, buildGenreList,
} from '../shared/graph-logic.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, 'output');

console.log('Loading graph data...');
const t0 = Date.now();
const graphData = JSON.parse(readFileSync(`${root}/combined_graph.json`, 'utf8'));
const graphNodes = graphData.nodes;
const audioCache = JSON.parse(readFileSync(`${root}/audio_cache.json`, 'utf8'));
const djNameMap = JSON.parse(readFileSync(`${root}/dj_name_map.json`, 'utf8'));
console.log(`Loaded in ${Date.now() - t0}ms — ${Object.keys(graphNodes).length} nodes`);

// Pre-compute derived data
const { candidates, candidateWeights } = buildCandidates(graphNodes, audioCache);
const { artistListAlpha, djListAlpha } = buildIndexes(graphNodes, candidates, djNameMap);
const genreList = buildGenreList(graphNodes);
const displayGenres = genreList.slice(0, 30);

console.log(`${candidates.length} candidates, ${artistListAlpha.length} artists, ${djListAlpha.length} DJs`);

// Pre-compute crates seed pool: candidates with 4+ edges
// Stored as a separate KV blob so the worker doesn't need 68K KV reads to filter
const cratesSeeds = candidates.filter(id => (graphNodes[id]?.edges?.length ?? 0) >= 4);
console.log(`${cratesSeeds.length} crates seeds (nodes with 4+ edges)`);

// Build KV entries
const entries = [];

// Build enriched candidates — include filter fields so Worker doesn't need per-node reads
const enrichedCandidates = candidates.map((id, i) => {
  const node = graphNodes[id];
  const cached = audioCache[id] || {};
  // Collect DJ names for this node (expanded via djNameMap)
  const djNames = new Set();
  for (const edge of (node.edges || [])) {
    for (const ctx of (edge.contexts || [])) {
      const raw = (ctx.dj || '').trim();
      if (!raw) continue;
      const names = djNameMap[raw] || [raw];
      names.forEach(n => djNames.add(n.toLowerCase()));
    }
  }
  return {
    id,
    w: candidateWeights[i],
    g: node.genres || [],              // genres
    s: cached.source || 'not_found',   // source
    st: cached.scTrackUrl ? 1 : 0,     // has SC track (for source filter)
    ss: (cached.setUrl && cached.setOffsetSec) ? (cached.setSource || null) : null, // set source (strip if no offset)
    a: (node.artist || '').toLowerCase(), // artist (lowercase for filtering)
    e: (node.edges || []).length,       // edge count (for crates 4+ filter)
    d: [...djNames],                    // DJ names (lowercase)
  };
});

// Index blobs (small, read on every request)
entries.push({
  key: 'candidates',
  value: JSON.stringify(enrichedCandidates),
});
entries.push({ key: 'crates-seeds', value: JSON.stringify(cratesSeeds) });
entries.push({ key: 'genres', value: JSON.stringify(displayGenres) });
entries.push({ key: 'artist-index', value: JSON.stringify(artistListAlpha) });
entries.push({ key: 'dj-index', value: JSON.stringify(djListAlpha) });
entries.push({ key: 'dj-name-map', value: JSON.stringify(djNameMap) });

const candSizeMB = (Buffer.byteLength(JSON.stringify(enrichedCandidates)) / 1024 / 1024).toFixed(1);
console.log(`Enriched candidates blob: ${candSizeMB}MB`);

// Crates index — per-seed metadata for client-side crates rendering.
// One KV read + CDN cache → replaces per-request BFS (was 7-9s → <200ms).
const cratesIndex = enrichedCandidates
  .filter(c => c.e >= 4)
  .map(c => {
    const node = graphNodes[c.id];
    const cached = audioCache[c.id] || {};
    // Collect artwork URLs: seed + 1st-hop + 2nd-hop neighbors (duplicates OK, cap 10)
    const artworks = [];
    const neighborIds = [];
    if (cached.artUrl) artworks.push(cached.artUrl);
    // 1st-hop neighbors
    for (const edge of (node.edges || [])) {
      if (artworks.length >= 8) break;
      const nArt = (audioCache[edge.node] || {}).artUrl;
      if (nArt) {
        artworks.push(nArt);
        neighborIds.push(edge.node);
      }
    }
    // 2nd-hop neighbors (walk edges of 1st-hop nodes)
    if (artworks.length < 8) {
      for (const edge of (node.edges || [])) {
        if (artworks.length >= 8) break;
        const hop1 = graphNodes[edge.node];
        if (!hop1) continue;
        for (const e2 of (hop1.edges || [])) {
          if (artworks.length >= 8) break;
          if (e2.node === c.id) continue; // skip seed
          const nArt = (audioCache[e2.node] || {}).artUrl;
          if (nArt) {
            artworks.push(nArt);
            neighborIds.push(e2.node);
          }
        }
      }
    }
    // displayCount mirrors worker formula
    const r1 = (node.edges || []).length;
    const displayCount = 1 + r1 + Math.min(2, r1) * 2;
    return { id: c.id, artworks, n: neighborIds, count: displayCount, weight: displayCount, g: c.g, a: c.a, d: c.d };
  });

const cratesIndexJson = JSON.stringify(cratesIndex);
const cratesMB = (Buffer.byteLength(cratesIndexJson) / 1024 / 1024).toFixed(1);
console.log(`Crates index: ${cratesIndex.length} seeds, ${cratesMB}MB`);
entries.push({ key: 'crates-index', value: cratesIndexJson });

console.log(`Index blobs: ${entries.length} entries`);

// Individual node entries (one per graph node)
// Each node includes its graph data + audio cache merged
let nodeCount = 0;
for (const [id, node] of Object.entries(graphNodes)) {
  const cached = audioCache[id] || {};
  const merged = {
    title: node.title,
    artist: node.artist,
    genres: node.genres || [],
    edges: node.edges || [],
    // Audio fields — strip set audio if no offset (unplayable without timestamp)
    source: cached.source || 'not_found',
    scTrackUrl: cached.scTrackUrl || null,
    artUrl: cached.artUrl || null,
    setUrl: (cached.setUrl && cached.setOffsetSec) ? cached.setUrl : null,
    setSource: (cached.setUrl && cached.setOffsetSec) ? (cached.setSource || null) : null,
    setOffsetSec: cached.setOffsetSec || null,
    setDj: (cached.setUrl && cached.setOffsetSec) ? (cached.setDj || null) : null,
  };
  const kvKey = `node:${id}`;
  // KV key limit is 512 bytes — skip nodes with keys that are too long
  if (Buffer.byteLength(kvKey) > 512) {
    console.warn(`Skipping node with key too long (${Buffer.byteLength(kvKey)} bytes): ${id.slice(0, 80)}...`);
    continue;
  }
  entries.push({
    key: kvKey,
    value: JSON.stringify(merged),
  });
  nodeCount++;
}

console.log(`Node entries: ${nodeCount}`);
console.log(`Total entries: ${entries.length}`);

// Split into smaller chunks — Cloudflare bulk API can timeout on large payloads
const CHUNK_SIZE = 10000;
const chunks = [];
for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
  chunks.push(entries.slice(i, i + CHUNK_SIZE));
}

for (let i = 0; i < chunks.length; i++) {
  const path = `${root}/kv-bulk-${i}.json`;
  writeFileSync(path, JSON.stringify(chunks[i]));
  const sizeMB = (Buffer.byteLength(JSON.stringify(chunks[i])) / 1024 / 1024).toFixed(1);
  console.log(`Wrote ${path} (${chunks[i].length} entries, ${sizeMB}MB)`);
}

console.log(`\nDone. Upload with:`);
for (let i = 0; i < chunks.length; i++) {
  console.log(`  npx wrangler kv bulk put --namespace-id=04f5b3defaf84e6ba843601156adc9d6 --remote pipeline/output/kv-bulk-${i}.json`);
}
