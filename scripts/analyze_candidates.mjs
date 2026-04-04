// Analyze what percentage of candidates would be eliminated by requiring
// >= 2 playable R1 nodes AND >= 2 total playable R2 nodes.

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..', 'pipeline', 'output');

console.log('Loading data...');
const graphData = JSON.parse(readFileSync(`${root}/combined_graph.json`, 'utf8'));
const graphNodes = graphData.nodes;
const audioCache = JSON.parse(readFileSync(`${root}/audio_cache.json`, 'utf8'));
console.log(`${Object.keys(graphNodes).length} graph nodes, ${Object.keys(audioCache).length} audio cache entries`);

// Replicate build_kv playability: a node is playable if it has scTrackUrl OR (setUrl AND setOffsetSec)
// This matches what the worker sees after build_kv strips setUrl when there's no offset.
function isPlayable(nodeId) {
  const cached = audioCache[nodeId];
  if (!cached) return false;
  if (cached.scTrackUrl) return true;
  if (cached.setUrl && cached.setOffsetSec) return true;
  return false;
}

// Replicate buildCandidates from shared/graph-logic.js
function buildCandidates() {
  const mcNodes = new Set(
    Object.keys(audioCache).filter(nid => audioCache[nid].source === 'mixcloud_set')
  );
  const unplayable = new Set(
    Object.keys(audioCache).filter(nid => {
      const c = audioCache[nid];
      return !c.scTrackUrl && !(c.setUrl && c.setOffsetSec);
    })
  );
  return Object.keys(graphNodes).filter(nid => {
    const edges = graphNodes[nid].edges || [];
    if (edges.length < 2) return false;
    if (mcNodes.has(nid)) return false;
    if (unplayable.has(nid)) return false;
    return !edges.some(e => mcNodes.has(e.node));
  });
}

const candidates = buildCandidates();
console.log(`\nTotal candidates: ${candidates.length}`);

// For each candidate, simulate the worker's cluster selection:
// - Get R1 neighbors (all edges from root, excluding root itself)
// - Filter playable R1s (matching worker line 133: skip if !scTrackUrl && !setUrl)
// - For each playable R1, get R2 candidates (neighbors excluding used nodes), count playable R2s
let passR1 = 0;
let passR1andR2 = 0;

const r1Counts = [];  // distribution tracking
const r2Counts = [];

for (const rootId of candidates) {
  const rootNode = graphNodes[rootId];
  const usedIds = new Set([rootId]);

  // R1: all neighbors
  const r1All = (rootNode.edges || [])
    .map(e => e.node)
    .filter(id => id in graphNodes && !usedIds.has(id));

  // Filter playable R1s (worker line 133)
  const playableR1s = r1All.filter(id => isPlayable(id));
  const playableR1Count = playableR1s.length;
  r1Counts.push(playableR1Count);

  if (playableR1Count >= 2) {
    passR1++;

    // For R2 count: simulate adding ALL playable R1s to usedIds (worst case, worker picks up to r1Limit=4)
    // Actually, the worker picks r1Limit R1s. But we want to know: across ALL playable R1s,
    // how many total playable R2s exist? This is the potential pool.
    // To match the worker more closely: it picks up to 4 R1s, then for each, up to r2Limit R2s.
    // But for this analysis, let's count total playable R2 potential across all playable R1s.

    // Mark all R1s as used (conservative - worker only uses selected ones)
    const r1Used = new Set([rootId, ...playableR1s]);

    let totalPlayableR2 = 0;
    for (const r1Id of playableR1s) {
      const r1Node = graphNodes[r1Id];
      if (!r1Node) continue;
      const r2Candidates = (r1Node.edges || [])
        .map(e => e.node)
        .filter(id => id in graphNodes && !r1Used.has(id));

      const playableR2s = r2Candidates.filter(id => isPlayable(id));
      totalPlayableR2 += playableR2s.length;

      // Add R2 candidates to used to avoid double-counting across R1s
      for (const id of r2Candidates) r1Used.add(id);
    }

    r2Counts.push(totalPlayableR2);

    if (totalPlayableR2 >= 2) {
      passR1andR2++;
    }
  } else {
    r2Counts.push(0);
  }
}

console.log(`\n=== Results ===`);
console.log(`Total candidates:                           ${candidates.length}`);
console.log(`Candidates with >= 2 playable R1:           ${passR1} (${(passR1/candidates.length*100).toFixed(1)}%)`);
console.log(`Candidates with >= 2 playable R1 AND R2:    ${passR1andR2} (${(passR1andR2/candidates.length*100).toFixed(1)}%)`);
console.log(`\nEliminated by R1 filter:                    ${candidates.length - passR1} (${((candidates.length - passR1)/candidates.length*100).toFixed(1)}%)`);
console.log(`Eliminated by R1+R2 filter:                 ${candidates.length - passR1andR2} (${((candidates.length - passR1andR2)/candidates.length*100).toFixed(1)}%)`);

// Distribution of playable R1 counts
console.log(`\n=== Playable R1 distribution ===`);
const r1Dist = {};
for (const c of r1Counts) { r1Dist[c] = (r1Dist[c] || 0) + 1; }
for (const [k, v] of Object.entries(r1Dist).sort((a, b) => Number(a[0]) - Number(b[0]))) {
  console.log(`  ${k} playable R1s: ${v} candidates (${(v/candidates.length*100).toFixed(1)}%)`);
}

// Distribution of playable R2 counts (for those passing R1 filter)
console.log(`\n=== Playable R2 distribution (candidates with >= 2 playable R1) ===`);
const r2Dist = {};
const r2Filtered = r2Counts.filter((_, i) => r1Counts[i] >= 2);
for (const c of r2Filtered) {
  const bucket = c >= 10 ? '10+' : String(c);
  r2Dist[bucket] = (r2Dist[bucket] || 0) + 1;
}
for (const [k, v] of Object.entries(r2Dist).sort((a, b) => {
  const na = a[0] === '1' && a[0].length > 1 ? 10 : Number(a[0]);
  const nb = b[0] === '1' && b[0].length > 1 ? 10 : Number(b[0]);
  return na - nb;
})) {
  console.log(`  ${k} playable R2s: ${v} candidates (${(v/passR1*100).toFixed(1)}% of R1-passing)`);
}
