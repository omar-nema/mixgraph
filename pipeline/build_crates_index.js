// Build crates-index KV entry — fast client-side crates without per-request BFS.
// Run this after graph.py + enrich.py to update the crates index in KV.
// Outputs pipeline/output/kv-crates-index.json — upload with the printed wrangler command.

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { buildCandidates } from '../shared/graph-logic.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, 'output');

console.log('Loading graph data...');
const t0 = Date.now();
const graphData = JSON.parse(readFileSync(`${root}/combined_graph.json`, 'utf8'));
const graphNodes = graphData.nodes;
const audioCache = JSON.parse(readFileSync(`${root}/audio_cache.json`, 'utf8'));
const djNameMap = JSON.parse(readFileSync(`${root}/dj_name_map.json`, 'utf8'));
console.log(`Loaded in ${Date.now() - t0}ms — ${Object.keys(graphNodes).length} nodes`);

const { candidates, candidateWeights } = buildCandidates(graphNodes, audioCache);

// Build enriched candidates (same logic as build_kv.js)
const enrichedCandidates = candidates.map((id, i) => {
  const node = graphNodes[id];
  const cached = audioCache[id] || {};
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
    g: node.genres || [],
    a: (node.artist || '').toLowerCase(),
    e: (node.edges || []).length,
    d: [...djNames],
  };
});

// Build crates index — seeds with 4+ edges, artworks from seed + neighbors
const cratesIndex = enrichedCandidates
  .filter(c => c.e >= 4)
  .map(c => {
    const node = graphNodes[c.id];
    const cached = audioCache[c.id] || {};
    const artworks = [];
    const neighborIds = [];
    if (cached.artUrl) artworks.push(cached.artUrl);
    for (const edge of (node.edges || [])) {
      if (artworks.length >= 4) break;
      const nArt = (audioCache[edge.node] || {}).artUrl;
      if (nArt && !artworks.includes(nArt)) {
        artworks.push(nArt);
        neighborIds.push(edge.node);
      }
    }
    const r1 = (node.edges || []).length;
    const displayCount = 1 + r1 + Math.min(2, r1) * 2;
    return { id: c.id, artworks, n: neighborIds, count: displayCount, weight: displayCount, g: c.g, a: c.a, d: c.d };
  });

const cratesIndexJson = JSON.stringify(cratesIndex);
const cratesMB = (Buffer.byteLength(cratesIndexJson) / 1024 / 1024).toFixed(1);
console.log(`Crates index: ${cratesIndex.length} seeds, ${cratesMB}MB`);

// Write as a KV bulk file (array of {key, value} pairs)
const outPath = `${root}/kv-crates-index.json`;
writeFileSync(outPath, JSON.stringify([{ key: 'crates-index', value: cratesIndexJson }]));
console.log(`Wrote ${outPath}`);
console.log(`\nUpload with:`);
console.log(`  npx wrangler kv:bulk put --namespace-id=04f5b3defaf84e6ba843601156adc9d6 pipeline/output/kv-crates-index.json`);
