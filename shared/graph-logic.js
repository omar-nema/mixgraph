// ═══════════════════════════════════════════
// Shared graph logic — pure functions, no globals, no DOM, no provider APIs
// Used by both the local Node server and (future) Cloudflare Worker adapter.
// ═══════════════════════════════════════════

// Genre rebalancing: cap over-represented genres (target % of seed nodes)
export const genreWeightCaps = {
  'Ambient': 20,
  'Folk': 5,
  'Soul': 15,
  'Indie Rock': 14,
};

// ── Helpers ──

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function splitArtists(raw) {
  let names = [];
  const parenMatch = raw.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (parenMatch) {
    names.push(parenMatch[1].trim());
    raw = parenMatch[2].trim();
  }
  const parts = raw.split(/\s*,\s*|\s+[Ff]eat\.?\s+|\s+[Ff]t\.?\s+|\s+[Xx]\s+|\s*[&+]\s*|\s+and\s+/);
  for (const p of parts) {
    const trimmed = p.trim();
    if (trimmed) names.push(trimmed);
  }
  return names.length ? names : [raw];
}

// ── Graph traversal ──

export function getNeighbors(graphNodes, nodeId, exclude) {
  const node = graphNodes[nodeId];
  if (!node) return [];
  return node.edges
    .map(e => e.node)
    .filter(id => id in graphNodes && !exclude.has(id));
}

export function getEdgeContext(graphNodes, fromId, toId) {
  const node = graphNodes[fromId];
  if (!node) return null;
  for (const edge of node.edges) {
    if (edge.node === toId && edge.contexts && edge.contexts.length > 0) {
      const ctx = edge.contexts[0];
      return {
        dj: ctx.dj || '',
        episodeUrl: ctx.episode_url || '',
        date: ctx.date || '',
      };
    }
  }
  return null;
}

export function collectDjs(graphNodes, graphId, djNameMap = {}) {
  const n = graphNodes[graphId];
  if (!n) return [];
  const seen = new Set();
  const djs = [];
  for (const edge of n.edges) {
    for (const ctx of (edge.contexts || [])) {
      const rawDj = (ctx.dj || '').trim();
      if (!rawDj) continue;
      const names = djNameMap[rawDj] || [rawDj];
      for (const name of names) {
        if (name && !seen.has(name)) {
          seen.add(name);
          djs.push({ name, episodeUrl: ctx.episode_url || '' });
        }
      }
    }
  }
  return djs;
}

export function enrichFromCache(audioCache, clusterNodes) {
  let found = 0;
  for (const node of clusterNodes) {
    const cached = audioCache[node.graphId];
    if (cached && cached.source && cached.source !== 'not_found') {
      node.source = cached.source;
      node.scTrackUrl = cached.scTrackUrl || null;
      node.artUrl = cached.artUrl || null;
      node.setUrl = cached.setUrl || null;
      node.setSource = cached.setSource || null;
      node.setOffsetSec = cached.setOffsetSec ?? null; // keep 0 (real 0:00 offset)
      node.setDj = cached.setDj || null;
      found++;
    } else {
      node.artUrl = null;
      node.scTrackUrl = null;
      node.setUrl = null;
      node.setSource = null;
      node.setOffsetSec = null;
      node.setDj = null;
      node.source = 'not_found';
    }
  }
  return found;
}

// ── Cluster selection (BFS) ──

export function selectCluster(graphNodes, audioCache, rootId, r1Limit = 4, r2Limit = 1, djNameMap = {}) {
  const rootNode = graphNodes[rootId];
  if (!rootNode) return null;

  const clusterNodes = [];
  const clusterEdges = [];
  const usedIds = new Set([rootId]);

  function makeNode(localId, graphId, rank) {
    usedIds.add(graphId);
    const n = graphNodes[graphId];
    return {
      id: localId,
      graphId,
      rank,
      title: n.title,
      artist: n.artist,
      djs: collectDjs(graphNodes, graphId, djNameMap),
    };
  }

  function makeEdge(fromLocal, toLocal, fromGraphId, toGraphId) {
    const edge = { from: fromLocal, to: toLocal };
    const ctx = getEdgeContext(graphNodes, fromGraphId, toGraphId);
    if (ctx) edge.context = ctx;
    return edge;
  }

  // Root
  clusterNodes.push(makeNode('root', rootId, 'root'));

  // R1: all neighbors, prefer nodes with children
  const r1All = getNeighbors(graphNodes, rootId, usedIds);
  const totalR1Available = r1All.length;
  const r1Kids = new Map(r1All.map(cid => [cid, getNeighbors(graphNodes, cid, new Set([...usedIds, rootId])).length]));
  const withKids = r1All.filter(c => r1Kids.get(c) >= 1);
  const deadEnds = r1All.filter(c => r1Kids.get(c) === 0);
  shuffleArray(withKids);
  shuffleArray(deadEnds);
  const r1Selected = [...withKids, ...deadEnds].slice(0, r1Limit);

  for (let i = 0; i < r1Selected.length; i++) {
    const r1GraphId = r1Selected[i];
    const r1Local = `r1_${i}`;
    clusterNodes.push(makeNode(r1Local, r1GraphId, '1'));
    clusterEdges.push(makeEdge('root', r1Local, rootId, r1GraphId));

    // R2: max per R1
    const r2Candidates = getNeighbors(graphNodes, r1GraphId, usedIds);
    shuffleArray(r2Candidates);
    const r2Selected = r2Candidates.slice(0, r2Limit);

    for (let j = 0; j < r2Selected.length; j++) {
      const r2GraphId = r2Selected[j];
      const r2Local = `r2_${i}_${j}`;
      clusterNodes.push(makeNode(r2Local, r2GraphId, '2'));
      clusterEdges.push(makeEdge(r1Local, r2Local, r1GraphId, r2GraphId));
    }
  }

  // Enrich from cache
  const found = enrichFromCache(audioCache, clusterNodes);

  return {
    meta: {
      root_id: rootId,
      found,
      not_found: clusterNodes.length - found,
      totalR1: totalR1Available,
      r1Shown: r1Selected.length,
      expandLevel: 0,
    },
    nodes: clusterNodes,
    edges: clusterEdges,
  };
}

// ── Candidate computation ──

export function buildCandidates(graphNodes, audioCache) {
  const mcNodes = new Set(
    Object.keys(audioCache).filter(nid => audioCache[nid].source === 'mixcloud_set')
  );
  // Unplayable = no SC track and no set with a known offset. A 0:00 offset counts
  // as playable (the frontend nudges past the intro), so test against null, not falsy.
  const unplayable = new Set(
    Object.keys(audioCache).filter(nid => {
      const c = audioCache[nid];
      return !c.scTrackUrl && !(c.setUrl && c.setOffsetSec != null);
    })
  );
  const ids = Object.keys(graphNodes).filter(nid => {
    const edges = graphNodes[nid].edges || [];
    if (edges.length < 2) return false;
    if (mcNodes.has(nid)) return false;
    if (unplayable.has(nid)) return false;
    return !edges.some(e => mcNodes.has(e.node));
  });

  // Genre rebalancing weights
  const naturalCounts = {};
  for (const id of ids) {
    for (const g of (graphNodes[id].genres || [])) {
      if (g in genreWeightCaps) naturalCounts[g] = (naturalCounts[g] || 0) + 1;
    }
  }
  const n = ids.length;
  const weights = new Float64Array(n);
  const idxMap = new Map();
  for (let i = 0; i < n; i++) {
    let w = 1;
    for (const g of (graphNodes[ids[i]].genres || [])) {
      if (g in genreWeightCaps) {
        const ratio = (genreWeightCaps[g] / 100 * n) / (naturalCounts[g] || 1);
        if (ratio < w) w = ratio;
      }
    }
    weights[i] = w;
    idxMap.set(ids[i], i);
  }

  return { candidates: ids, candidateWeights: weights, idxMap };
}

// ── Filtering ──

function matchesSourceFilter(audioCache, nodeId, filter) {
  if (filter === 'none' || !filter) return true;
  const cached = audioCache[nodeId];
  if (!cached) return false;
  const hasScTrack = !!cached.scTrackUrl;
  if (filter === 'soundcloud') return hasScTrack;
  if (filter === 'soundcloud_set') return !hasScTrack && cached.source === 'soundcloud_set';
  if (filter === 'lotradio') return !hasScTrack && cached.setSource === 'soundcloud';
  return true;
}

export function getFilteredPool(graphNodes, audioCache, candidates, filters = {}, djNameMap = {}) {
  const { source, artists, djs, genres, title } = filters;

  let pool = source
    ? candidates.filter(id => matchesSourceFilter(audioCache, id, source))
    : [...candidates];

  if (title) {
    const titleLower = title.toLowerCase();
    pool = pool.filter(id => (graphNodes[id].title || '').toLowerCase() === titleLower);
  }

  // Artist/DJ name filtering
  if ((artists && artists.length > 0) || (djs && djs.length > 0)) {
    const matchIds = new Set();
    if (artists && artists.length > 0) {
      for (const id of Object.keys(graphNodes)) {
        const node = graphNodes[id];
        const nodeArtists = splitArtists(node.artist || '').map(a => a.toLowerCase());
        if (artists.some(a => nodeArtists.includes(a.toLowerCase()))) matchIds.add(id);
      }
    }
    if (djs && djs.length > 0) {
      const djsLower = djs.map(d => d.toLowerCase());
      for (const [id, node] of Object.entries(graphNodes)) {
        for (const edge of (node.edges || [])) {
          for (const ctx of (edge.contexts || [])) {
            const rawDj = (ctx.dj || '').trim();
            if (!rawDj) continue;
            // Expand show title to extracted DJ names via djNameMap
            const names = djNameMap[rawDj] || [rawDj];
            if (names.some(n => djsLower.includes(n.toLowerCase()))) {
              matchIds.add(id);
              matchIds.add(edge.node);
            }
          }
        }
      }
    }
    pool = pool.filter(id => matchIds.has(id));
    // If no overlap with candidates, fall back to the match set itself
    if (pool.length === 0) {
      pool = [...matchIds].filter(id => graphNodes[id] && matchesSourceFilter(audioCache, id, source));
    }
  }

  if (genres && genres.length > 0) {
    pool = pool.filter(id => {
      const nodeGenres = graphNodes[id].genres || [];
      return genres.some(g => nodeGenres.includes(g));
    });
  }

  return pool;
}

export function weightedPickFromPool(pool, candidateWeights, idxMap, hasArtistDjFilter = false) {
  if (!candidateWeights || pool.length === 0 || hasArtistDjFilter) {
    return pool[Math.floor(Math.random() * pool.length)];
  }
  let totalW = 0;
  for (const id of pool) {
    const idx = idxMap.get(id);
    totalW += idx !== undefined ? candidateWeights[idx] : 1;
  }
  let r = Math.random() * totalW;
  for (const id of pool) {
    const idx = idxMap.get(id);
    r -= idx !== undefined ? candidateWeights[idx] : 1;
    if (r <= 0) return id;
  }
  return pool[pool.length - 1];
}

// ── Index building ──

export function buildIndexes(graphNodes, candidates, djNameMap = {}) {
  const candidateSet = new Set(candidates);

  // Artist index
  const caseCounts = {};
  const artistIdx = {};
  for (const [id, node] of Object.entries(graphNodes)) {
    const artist = (node.artist || '').trim();
    if (!artist) continue;
    for (const name of splitArtists(artist)) {
      const key = name.toLowerCase();
      caseCounts[key] = caseCounts[key] || {};
      caseCounts[key][name] = (caseCounts[key][name] || 0) + 1;
      if (!artistIdx[key]) artistIdx[key] = { display: name, trackIds: [] };
      artistIdx[key].trackIds.push(id);
    }
  }
  for (const [key, variants] of Object.entries(caseCounts)) {
    let best = '', bestCount = 0;
    for (const [name, count] of Object.entries(variants)) {
      if (count > bestCount) { best = name; bestCount = count; }
    }
    if (artistIdx[key]) artistIdx[key].display = best;
  }
  const artistListAlpha = Object.values(artistIdx)
    .map(e => ({ display: e.display, trackCount: e.trackIds.length, clusterCount: e.trackIds.filter(id => candidateSet.has(id)).length }))
    .filter(e => e.clusterCount > 0)
    .sort((a, b) => b.trackCount - a.trackCount)
    .sort((a, b) => a.display.localeCompare(b.display));

  // DJ index
  const djIdx = {};
  for (const [id, node] of Object.entries(graphNodes)) {
    for (const edge of (node.edges || [])) {
      for (const ctx of (edge.contexts || [])) {
        const rawDj = (ctx.dj || '').trim();
        if (!rawDj) continue;
        const names = djNameMap[rawDj] || [rawDj];
        for (const name of names) {
          const key = name.toLowerCase();
          if (!djIdx[key]) djIdx[key] = { display: name, trackIds: new Set() };
          djIdx[key].trackIds.add(id);
          djIdx[key].trackIds.add(edge.node);
        }
      }
    }
  }
  const djListAlpha = Object.values(djIdx)
    .map(e => {
      const ids = [...e.trackIds];
      return { display: e.display, trackCount: ids.length, clusterCount: ids.filter(id => candidateSet.has(id)).length };
    })
    .filter(e => e.clusterCount > 0)
    .sort((a, b) => b.trackCount - a.trackCount)
    .sort((a, b) => a.display.localeCompare(b.display));

  // Track (song) index — keyed by (title, artist) so autocomplete can disambiguate
  const trackIdx = {};
  for (const [id, node] of Object.entries(graphNodes)) {
    if (!candidateSet.has(id)) continue;
    const title = (node.title || '').trim();
    const artist = (node.artist || '').trim();
    if (!title) continue;
    const key = `${title.toLowerCase()}\t${artist.toLowerCase()}`;
    if (!trackIdx[key]) trackIdx[key] = { display: title, artist, count: 0 };
    trackIdx[key].count++;
  }
  const trackListAlpha = Object.values(trackIdx)
    .sort((a, b) => a.display.localeCompare(b.display));

  return { artistListAlpha, djListAlpha, trackListAlpha };
}

export function buildGenreList(graphNodes) {
  const genreIndex = {};
  for (const [id, node] of Object.entries(graphNodes)) {
    for (const g of (node.genres || [])) {
      genreIndex[g] = (genreIndex[g] || 0) + 1;
    }
  }
  return Object.entries(genreIndex)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

// ── Crates generation ──

function cratesBfs(graphNodes, startKey, maxNodes) {
  const visited = new Set();
  const queue = [startKey];
  visited.add(startKey);
  while (queue.length && visited.size < maxNodes) {
    const key = queue.shift();
    const node = graphNodes[key];
    if (!node || !node.edges) continue;
    for (const edge of node.edges) {
      if (visited.size >= maxNodes) break;
      if (!visited.has(edge.node) && graphNodes[edge.node]) {
        visited.add(edge.node);
        queue.push(edge.node);
      }
    }
  }
  return [...visited];
}

function estimateClusterSize(graphNodes, seedKey) {
  const node = graphNodes[seedKey];
  if (!node || !node.edges) return 1;
  const used = new Set([seedKey]);
  const r1Ids = node.edges.map(e => e.node).filter(id => id in graphNodes && !used.has(id));
  r1Ids.forEach(id => used.add(id));
  let total = 1 + r1Ids.length;
  for (const r1Id of r1Ids) {
    const r1Node = graphNodes[r1Id];
    if (!r1Node || !r1Node.edges) continue;
    const r2 = r1Node.edges.map(e => e.node).filter(id => id in graphNodes && !used.has(id));
    const r2Count = Math.min(2, r2.length);
    total += r2Count;
    for (let i = 0; i < r2Count; i++) used.add(r2[i]);
  }
  return total;
}

export function generateCratesPage(graphNodes, audioCache, candidates, seed, page, count, filters = {}, djNameMap = {}) {
  let rngState = seed === 0 ? 1 : seed;
  function rng() {
    rngState = (rngState * 16807) % 2147483647;
    return (rngState - 1) / 2147483646;
  }

  // Build filtered pool for crates (4+ edges for seed nodes)
  let pool;
  if (filters.genres || filters.artists || filters.djs) {
    pool = getFilteredPool(graphNodes, audioCache, candidates, filters, djNameMap);
  } else {
    pool = [...candidates];
  }
  const seedPool = pool.filter(k => (graphNodes[k]?.edges?.length ?? 0) >= 4);

  // Deterministic shuffle
  for (let i = seedPool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [seedPool[i], seedPool[j]] = [seedPool[j], seedPool[i]];
  }

  // Fast-forward past earlier pages, rebuilding usedNodes
  const skip = page * count;
  let poolIdx = 0, produced = 0;
  const usedNodes = new Set();

  function buildCrateCluster(seedKey) {
    if (usedNodes.has(seedKey)) return null;
    const size = 15 + Math.floor(rng() * 40);
    const members = cratesBfs(graphNodes, seedKey, size);
    const overlap = members.filter(m => usedNodes.has(m)).length;
    if (overlap > members.length * 0.3) return null;

    const artworks = [], artKeys = [];
    for (const key of members) {
      const cached = audioCache[key];
      if (cached && cached.artUrl) { artworks.push(cached.artUrl); artKeys.push(key); }
    }
    const [artist, title] = seedKey.split(':::');
    const displayCount = estimateClusterSize(graphNodes, seedKey);
    return {
      seedKey,
      label: artist || 'unknown',
      title: title || '',
      artist: artist || '',
      count: displayCount,
      artworks,
      artKeys,
      memberKeys: members,
      weight: members.length,
    };
  }

  // Skip past earlier pages
  while (produced < skip && poolIdx < seedPool.length) {
    const c = buildCrateCluster(seedPool[poolIdx++]);
    if (c) { c.memberKeys.forEach(k => usedNodes.add(k)); produced++; }
  }

  // Collect this page
  const clusters = [];
  while (clusters.length < count && poolIdx < seedPool.length) {
    const c = buildCrateCluster(seedPool[poolIdx++]);
    if (c) { c.memberKeys.forEach(k => usedNodes.add(k)); clusters.push(c); }
  }

  return { clusters, hasMore: poolIdx < seedPool.length };
}

export function cratesTreemap(items, x, y, w, h) {
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
