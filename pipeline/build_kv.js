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

// Build KV entries
const entries = [];

// Index blobs (small, read on every request)
entries.push({
  key: 'candidates',
  value: JSON.stringify({
    ids: candidates,
    weights: Array.from(candidateWeights),
  }),
});
entries.push({ key: 'genres', value: JSON.stringify(displayGenres) });
entries.push({ key: 'artist-index', value: JSON.stringify(artistListAlpha) });
entries.push({ key: 'dj-index', value: JSON.stringify(djListAlpha) });
entries.push({ key: 'dj-name-map', value: JSON.stringify(djNameMap) });

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
    // Audio fields
    source: cached.source || 'not_found',
    scTrackUrl: cached.scTrackUrl || null,
    artUrl: cached.artUrl || null,
    setUrl: cached.setUrl || null,
    setSource: cached.setSource || null,
    setOffsetSec: cached.setOffsetSec || null,
    setDj: cached.setDj || null,
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
  console.log(`  npx wrangler kv:bulk put --namespace-id=04f5b3defaf84e6ba843601156adc9d6 pipeline/output/kv-bulk-${i}.json`);
}
