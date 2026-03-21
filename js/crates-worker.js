// Web Worker for crates cluster generation (BFS + treemap layout)
// Keeps heavy graph traversal off the main thread

let graphEdges = null;  // { nodeId: [edgeNodeId, ...] }
let artUrls = null;     // { nodeId: artUrl }
let seedPool = [];
let seedIdx = 0;
let usedNodes = new Set();
let crateSeed = 1;

function crateRand() {
  crateSeed = (crateSeed * 16807) % 2147483647;
  return (crateSeed - 1) / 2147483646;
}

function cratesBfs(startKey, maxNodes) {
  const visited = new Set();
  const queue = [startKey];
  visited.add(startKey);
  while (queue.length && visited.size < maxNodes) {
    const key = queue.shift();
    const edges = graphEdges[key];
    if (!edges) continue;
    for (const nodeId of edges) {
      if (visited.size >= maxNodes) break;
      if (!visited.has(nodeId) && graphEdges[nodeId]) {
        visited.add(nodeId);
        queue.push(nodeId);
      }
    }
  }
  return [...visited];
}

function estimateClusterSize(seedKey) {
  const edges = graphEdges[seedKey];
  if (!edges) return 1;
  const used = new Set([seedKey]);
  const r1Ids = edges.filter(id => id in graphEdges && !used.has(id));
  r1Ids.forEach(id => used.add(id));
  let total = 1 + r1Ids.length;
  for (const r1Id of r1Ids) {
    const r1Edges = graphEdges[r1Id];
    if (!r1Edges) continue;
    const r2 = r1Edges.filter(id => id in graphEdges && !used.has(id));
    const r2Count = Math.min(2, r2.length);
    total += r2Count;
    for (let i = 0; i < r2Count; i++) used.add(r2[i]);
  }
  return total;
}

function generateClusters(count) {
  const clusters = [];
  while (clusters.length < count && seedIdx < seedPool.length) {
    const seedKey = seedPool[seedIdx++];
    if (usedNodes.has(seedKey)) continue;
    const size = 15 + Math.floor(crateRand() * 40);
    const members = cratesBfs(seedKey, size);
    const overlap = members.filter(m => usedNodes.has(m)).length;
    if (overlap > members.length * 0.3) continue;
    members.forEach(m => usedNodes.add(m));

    const artworks = [], artKeys = [];
    for (const key of members) {
      const url = artUrls[key];
      if (url) { artworks.push(url); artKeys.push(key); }
    }
    const [artist, title] = seedKey.split(':::');
    const displayCount = estimateClusterSize(seedKey);
    clusters.push({
      seedKey, label: artist || 'unknown',
      title: title || '', artist: artist || '',
      count: displayCount, artworks, artKeys,
      memberKeys: members, weight: members.length,
    });
  }
  return clusters;
}

function cratesTreemap(items, x, y, w, h) {
  if (items.length === 0) return items;
  if (items.length === 1) { items[0].rect = { x, y, w, h }; return items; }
  const total = items.reduce((s, it) => s + it.weight, 0);
  const sorted = [...items].sort((a, b) => b.weight - a.weight);
  let bestDiff = Infinity, splitIdx = 1, runSum = 0;
  for (let i = 0; i < sorted.length - 1; i++) {
    runSum += sorted[i].weight;
    const diff = Math.abs(runSum - (total - runSum));
    if (diff < bestDiff) { bestDiff = diff; splitIdx = i + 1; }
  }
  const left = sorted.slice(0, splitIdx);
  const right = sorted.slice(splitIdx);
  const ratio = left.reduce((s, it) => s + it.weight, 0) / total;
  if (w >= h) {
    const sw = w * ratio;
    cratesTreemap(left, x, y, sw, h);
    cratesTreemap(right, x + sw, y, w - sw, h);
  } else {
    const sh = h * ratio;
    cratesTreemap(left, x, y, w, sh);
    cratesTreemap(right, x, y + sh, w, h - sh);
  }
  return sorted;
}

// Build compact data from full graph + audio cache fetched in-worker
async function initFromUrls(graphUrl, audioCacheUrl, seed) {
  try {
  const [graphResp, cacheResp] = await Promise.all([
    fetch(graphUrl),
    fetch(audioCacheUrl)
  ]);
  if (!graphResp.ok || !cacheResp.ok) {
    self.postMessage({ type: 'error', message: `Fetch failed: graph=${graphResp.status} cache=${cacheResp.status}` });
    return;
  }
  const graphData = await graphResp.json();
  const audioCache = await cacheResp.json();

  // Build compact edge map
  graphEdges = {};
  const allKeys = Object.keys(graphData.nodes);
  for (const k of allKeys) {
    const node = graphData.nodes[k];
    if (node.edges) graphEdges[k] = node.edges.map(e => e.node);
  }

  // Build compact art url map
  artUrls = {};
  for (const k of Object.keys(audioCache)) {
    if (audioCache[k].artUrl) artUrls[k] = audioCache[k].artUrl;
  }

  // Build shuffled seed pool (must match main thread's pool)
  crateSeed = seed;
  seedPool = allKeys.filter(k => graphEdges[k] && graphEdges[k].length >= 4);
  for (let i = seedPool.length - 1; i > 0; i--) {
    const j = Math.floor(crateRand() * (i + 1));
    [seedPool[i], seedPool[j]] = [seedPool[j], seedPool[i]];
  }
  seedIdx = 0;
  usedNodes = new Set();

  self.postMessage({ type: 'ready', seedCount: seedPool.length });
  } catch(err) {
    self.postMessage({ type: 'error', message: err.message });
  }
}

self.onmessage = function(e) {
  const { type, id } = e.data;

  if (type === 'init') {
    initFromUrls(e.data.graphUrl, e.data.audioCacheUrl, e.data.crateSeed);
    return;
  }

  if (type === 'generatePage') {
    const { count, vw, vh, pad } = e.data;
    const clusters = generateClusters(count);
    if (clusters.length === 0) {
      self.postMessage({ type: 'page', id, clusters: [] });
      return;
    }
    const items = clusters.map((c, i) => ({ ...c, idx: i }));
    cratesTreemap(items, pad, pad, vw - pad * 2, vh - pad * 2);
    self.postMessage({ type: 'page', id, clusters: items });
    return;
  }
};
