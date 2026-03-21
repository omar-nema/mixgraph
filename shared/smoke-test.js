// Quick smoke test: load graph data, run selectCluster, print result
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  selectCluster, buildCandidates, buildIndexes, buildGenreList,
  getFilteredPool, weightedPickFromPool, generateCratesPage,
} from './graph-logic.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../pipeline/output');

console.log('Loading graph data...');
const t0 = Date.now();
const graphNodes = JSON.parse(readFileSync(`${root}/combined_graph.json`, 'utf8')).nodes;
const audioCache = JSON.parse(readFileSync(`${root}/audio_cache.json`, 'utf8'));
const djNameMap = JSON.parse(readFileSync(`${root}/dj_name_map.json`, 'utf8'));
console.log(`Loaded in ${Date.now() - t0}ms — ${Object.keys(graphNodes).length} nodes`);

// Test 1: buildCandidates
console.log('\n── buildCandidates ──');
const { candidates, candidateWeights, idxMap } = buildCandidates(graphNodes, audioCache);
console.log(`${candidates.length} candidates`);

// Test 2: selectCluster on a known root
console.log('\n── selectCluster ──');
const testRoot = candidates.find(id => (graphNodes[id].edges || []).length >= 8);
console.log(`Test root: "${testRoot}" (${graphNodes[testRoot].edges.length} edges)`);
const cluster = selectCluster(graphNodes, audioCache, testRoot, 4, 1);
console.log(`Cluster: ${cluster.nodes.length} nodes, ${cluster.edges.length} edges`);
console.log(`  Root: ${cluster.nodes[0].artist} — ${cluster.nodes[0].title}`);
console.log(`  Found audio: ${cluster.meta.found}/${cluster.nodes.length}`);

// Test 3: buildIndexes
console.log('\n── buildIndexes ──');
const { artistListAlpha, djListAlpha } = buildIndexes(graphNodes, candidates, djNameMap);
console.log(`${artistListAlpha.length} artists, ${djListAlpha.length} DJs`);

// Test 4: buildGenreList
console.log('\n── buildGenreList ──');
const genres = buildGenreList(graphNodes);
console.log(`${genres.length} genres, top 5:`, genres.slice(0, 5).map(g => `${g.name} (${g.count})`).join(', '));

// Test 5: getFilteredPool
console.log('\n── getFilteredPool ──');
const soulPool = getFilteredPool(graphNodes, audioCache, candidates, { genres: ['Soul'] });
console.log(`Soul filter: ${soulPool.length} tracks`);

// Test 6: weightedPickFromPool
console.log('\n── weightedPickFromPool ──');
const pick = weightedPickFromPool(candidates.slice(0, 100), candidateWeights, idxMap);
console.log(`Random pick from first 100: "${pick}"`);

// Test 7: generateCratesPage
console.log('\n── generateCratesPage ──');
const crates = generateCratesPage(graphNodes, audioCache, candidates, 42, 0, 3);
console.log(`Page 0: ${crates.clusters.length} clusters, hasMore: ${crates.hasMore}`);
for (const c of crates.clusters) {
  console.log(`  ${c.artist} — ${c.title} (${c.count} display, ${c.memberKeys.length} members)`);
}

console.log('\n✓ All smoke tests passed');
