// Build crates-index KV entry — fast client-side crates without per-request BFS.
// Run this after graph.py + enrich.py to update the crates index in KV.
// Outputs pipeline/output/kv-crates-index.json — upload with the printed wrangler command.

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { buildCratesIndex } from '../shared/graph-logic.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..', 'pipeline', 'output');

console.log('Loading graph data...');
const t0 = Date.now();
const graphData = JSON.parse(readFileSync(`${root}/combined_graph.json`, 'utf8'));
const graphNodes = graphData.nodes;
const audioCache = JSON.parse(readFileSync(`${root}/audio_cache.json`, 'utf8'));
const djNameMap = JSON.parse(readFileSync(`${root}/dj_name_map.json`, 'utf8'));
console.log(`Loaded in ${Date.now() - t0}ms — ${Object.keys(graphNodes).length} nodes`);

// Build crates index — shared with build_kv.js (single source of truth).
const cratesIndex = buildCratesIndex(graphNodes, audioCache, djNameMap);

const cratesIndexJson = JSON.stringify(cratesIndex);
const cratesMB = (Buffer.byteLength(cratesIndexJson) / 1024 / 1024).toFixed(1);
console.log(`Crates index: ${cratesIndex.length} seeds, ${cratesMB}MB`);

// Write as a KV bulk file (array of {key, value} pairs)
const outPath = `${root}/kv-crates-index.json`;
writeFileSync(outPath, JSON.stringify([{ key: 'crates-index', value: cratesIndexJson }]));
console.log(`Wrote ${outPath}`);
console.log(`\nUpload with:`);
console.log(`  npx wrangler kv:bulk put --namespace-id=04f5b3defaf84e6ba843601156adc9d6 web-app/output/kv-crates-index.json`);
