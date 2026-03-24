// Cloudflare Worker adapter for b2b API
// Reads graph nodes from KV on demand — never loads full graph into memory.
// Pre-computed index blobs (candidates, genres, artist-index, dj-index, dj-name-map)
// are cached in-memory after first read.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

function csvParam(val) {
  if (!val) return [];
  return val.split(',').map(s => s.trim()).filter(Boolean);
}

function searchList(list, q, limit) {
  if (!q) return list.slice(0, limit);
  const lower = q.toLowerCase();
  const starts = [], contains = [];
  for (const item of list) {
    const name = item.display.toLowerCase();
    if (name.startsWith(lower)) starts.push(item);
    else if (name.includes(lower)) contains.push(item);
    if (starts.length + contains.length >= limit) break;
  }
  return [...starts, ...contains].slice(0, limit);
}

// ── KV-based cluster selection ──
// BFS over KV — fetches nodes on demand instead of holding full graph in memory

async function getNode(kv, id) {
  return kv.get(`node:${id}`, 'json');
}

// Module-level cache — persists within a Worker isolate lifetime
let _djNameMap = null;
async function getDjNameMap(kv) {
  if (!_djNameMap) _djNameMap = await kv.get('dj-name-map', 'json') || {};
  return _djNameMap;
}

// Expand raw show title via djNameMap so pills match the extracted names in c.d
function collectDjsFromNode(node, djNameMap = {}) {
  if (!node || !node.edges) return [];
  const seen = new Set();
  const djs = [];
  for (const edge of node.edges) {
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

function getEdgeContextFromNode(node, toId) {
  if (!node) return null;
  for (const edge of node.edges) {
    if (edge.node === toId && edge.contexts && edge.contexts.length > 0) {
      const ctx = edge.contexts[0];
      return { dj: ctx.dj || '', episodeUrl: ctx.episode_url || '', date: ctx.date || '' };
    }
  }
  return null;
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function enrichNodeFromKV(kvNode, graphId, djNameMap = {}) {
  const n = {
    graphId,
    title: kvNode.title,
    artist: kvNode.artist,
    djs: collectDjsFromNode(kvNode, djNameMap),
    source: kvNode.source || 'not_found',
    scTrackUrl: kvNode.scTrackUrl || null,
    artUrl: kvNode.artUrl || null,
    setUrl: kvNode.setUrl || null,
    setSource: kvNode.setSource || null,
    setOffsetSec: kvNode.setOffsetSec || null,
    setDj: kvNode.setDj || null,
  };
  return n;
}

async function selectClusterFromKV(kv, rootId, r1Limit = 4, r2Limit = 1) {
  const [rootKV, djNameMap] = await Promise.all([getNode(kv, rootId), getDjNameMap(kv)]);
  if (!rootKV) return null;

  const clusterNodes = [];
  const clusterEdges = [];
  const usedIds = new Set([rootId]);

  // Root
  const rootNode = enrichNodeFromKV(rootKV, rootId, djNameMap);
  rootNode.id = 'root';
  rootNode.rank = 'root';
  clusterNodes.push(rootNode);

  // R1 neighbors
  const r1All = (rootKV.edges || []).map(e => e.node).filter(id => !usedIds.has(id));
  const totalR1 = r1All.length;

  // Fetch all R1 candidates in parallel to check which have children
  const r1KVs = await Promise.all(r1All.map(id => getNode(kv, id)));
  const r1WithKids = [];
  const r1DeadEnds = [];
  for (let i = 0; i < r1All.length; i++) {
    if (!r1KVs[i]) continue;
    // Skip unplayable nodes (no SC track and no set with offset)
    if (!r1KVs[i].scTrackUrl && !r1KVs[i].setUrl) continue;
    const childCount = (r1KVs[i].edges || []).filter(e => !usedIds.has(e.node) && e.node !== rootId).length;
    if (childCount >= 1) r1WithKids.push({ id: r1All[i], kv: r1KVs[i] });
    else r1DeadEnds.push({ id: r1All[i], kv: r1KVs[i] });
  }
  shuffleArray(r1WithKids);
  shuffleArray(r1DeadEnds);
  const r1Selected = [...r1WithKids, ...r1DeadEnds].slice(0, r1Limit);

  // Process R1 + fetch R2 in parallel
  const r2Fetches = [];
  for (let i = 0; i < r1Selected.length; i++) {
    const { id: r1Id, kv: r1KV } = r1Selected[i];
    usedIds.add(r1Id);
    const r1Node = enrichNodeFromKV(r1KV, r1Id, djNameMap);
    r1Node.id = `r1_${i}`;
    r1Node.rank = '1';
    clusterNodes.push(r1Node);

    const ctx = getEdgeContextFromNode(rootKV, r1Id);
    const edge = { from: 'root', to: `r1_${i}` };
    if (ctx) edge.context = ctx;
    clusterEdges.push(edge);

    // Queue R2 fetches
    const r2Candidates = (r1KV.edges || []).map(e => e.node).filter(id => !usedIds.has(id));
    shuffleArray(r2Candidates);
    const r2Picks = r2Candidates.slice(0, r2Limit);
    for (let j = 0; j < r2Picks.length; j++) {
      usedIds.add(r2Picks[j]);
      r2Fetches.push({ r1Idx: i, r2Idx: j, r2Id: r2Picks[j], r1Id, r1KV });
    }
  }

  // Fetch all R2 nodes in parallel
  const r2KVs = await Promise.all(r2Fetches.map(f => getNode(kv, f.r2Id)));
  for (let k = 0; k < r2Fetches.length; k++) {
    const { r1Idx, r2Idx, r2Id, r1KV } = r2Fetches[k];
    if (!r2KVs[k]) continue;
    if (!r2KVs[k].scTrackUrl && !r2KVs[k].setUrl) continue;
    const r2Node = enrichNodeFromKV(r2KVs[k], r2Id, djNameMap);
    r2Node.id = `r2_${r1Idx}_${r2Idx}`;
    r2Node.rank = '2';
    clusterNodes.push(r2Node);

    const ctx = getEdgeContextFromNode(r1KV, r2Id);
    const edge = { from: `r1_${r1Idx}`, to: `r2_${r1Idx}_${r2Idx}` };
    if (ctx) edge.context = ctx;
    clusterEdges.push(edge);
  }

  const found = clusterNodes.filter(n => n.source && n.source !== 'not_found').length;

  return {
    meta: {
      root_id: rootId,
      found,
      not_found: clusterNodes.length - found,
      totalR1: totalR1,
      r1Shown: r1Selected.length,
      expandLevel: 0,
    },
    nodes: clusterNodes,
    edges: clusterEdges,
  };
}

// ── Worker entrypoint ──

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const q = url.searchParams;

    try {
      // GET /api/genres
      if (url.pathname === '/api/genres') {
        const genres = await env.GRAPH_KV.get('genres', 'json');
        return jsonResponse(genres);
      }

      // GET /api/search/artists
      if (url.pathname === '/api/search/artists') {
        const index = await env.GRAPH_KV.get('artist-index', 'json');
        const results = searchList(index, q.get('q') || '', parseInt(q.get('limit')) || 20);
        return jsonResponse(results);
      }

      // GET /api/search/djs
      if (url.pathname === '/api/search/djs') {
        const index = await env.GRAPH_KV.get('dj-index', 'json');
        const results = searchList(index, q.get('q') || '', parseInt(q.get('limit')) || 20);
        return jsonResponse(results);
      }

      // GET /api/shuffle
      if (url.pathname === '/api/shuffle') {
        const allCandidates = await env.GRAPH_KV.get('candidates', 'json');

        // Apply filters — all filtering uses the enriched candidates blob (no KV reads)
        const genres = csvParam(q.get('genres'));
        const artists = csvParam(q.get('artists'));
        const djs = csvParam(q.get('djs'));
        const source = q.get('source');
        const exclude = new Set(csvParam(q.get('exclude')));

        let pool = allCandidates;
        if (genres.length > 0 || artists.length > 0 || djs.length > 0 || (source && source !== 'none')) {
          pool = allCandidates.filter(c => {
            if (source && source !== 'none') {
              if (source === 'soundcloud' && !c.st) return false;
              if (source === 'soundcloud_set' && (c.st || c.s !== 'soundcloud_set')) return false;
              if (source === 'lotradio' && (c.st || c.ss !== 'soundcloud')) return false;
            }
            if (genres.length > 0 && !genres.some(g => c.g.includes(g))) return false;
            if (artists.length > 0 && !artists.some(a => c.a.includes(a.toLowerCase()))) return false;
            if (djs.length > 0) {
              const djsLower = djs.map(d => d.toLowerCase());
              if (!c.d.some(d => djsLower.includes(d))) return false;
            }
            return true;
          });
        }

        if (pool.length === 0) {
          return jsonResponse({ error: 'No tracks match current filters' }, 404);
        }

        // Exclude recently seen
        let unseen = pool.filter(c => !exclude.has(c.id));
        if (unseen.length === 0) unseen = pool;

        // Weighted random pick
        const hasArtistDjFilter = artists.length > 0 || djs.length > 0;
        let picked;
        if (hasArtistDjFilter) {
          picked = unseen[Math.floor(Math.random() * unseen.length)];
        } else {
          let totalW = 0;
          for (const c of unseen) totalW += c.w;
          let r = Math.random() * totalW;
          picked = unseen[unseen.length - 1];
          for (const c of unseen) {
            r -= c.w;
            if (r <= 0) { picked = c; break; }
          }
        }

        const r1 = parseInt(q.get('r1')) || 4;
        const r2 = parseInt(q.get('r2')) || 1;
        const cluster = await selectClusterFromKV(env.GRAPH_KV, picked.id, r1, r2);
        if (!cluster) {
          return jsonResponse({ error: 'Failed to build cluster' }, 500);
        }
        cluster.meta.poolSize = pool.length;
        return jsonResponse(cluster);
      }

      // GET /api/cluster/:id
      const clusterMatch = url.pathname.match(/^\/api\/cluster\/(.+)$/);
      if (clusterMatch) {
        const id = decodeURIComponent(clusterMatch[1]);
        const r1 = parseInt(q.get('r1')) || 4;
        const r2 = parseInt(q.get('r2')) || 1;
        const expand = parseInt(q.get('expand')) || 0;

        let r1Limit = r1, r2Limit = r2;
        if (expand === 1) r1Limit = 8;
        if (expand >= 2) { r1Limit = 100; r2Limit = 100; }

        const cluster = await selectClusterFromKV(env.GRAPH_KV, id, r1Limit, r2Limit);
        if (!cluster) {
          return jsonResponse({ error: `Node "${id}" not found` }, 404);
        }
        cluster.meta.expandLevel = expand;
        return jsonResponse(cluster);
      }

      // GET /api/crates
      if (url.pathname === '/api/crates') {
        const seed = parseInt(q.get('seed'));
        if (isNaN(seed)) return jsonResponse({ error: 'seed parameter required' }, 400);
        const page = parseInt(q.get('page')) || 0;
        const count = Math.min(parseInt(q.get('count')) || 12, 24);
        if (page > 50) return jsonResponse({ error: 'Max page depth is 50' }, 400);

        const allCandidates = await env.GRAPH_KV.get('candidates', 'json');

        // LCG for deterministic shuffle
        let rngState = seed === 0 ? 1 : seed;
        function rng() {
          rngState = (rngState * 16807) % 2147483647;
          return (rngState - 1) / 2147483646;
        }

        // Apply filters + require 4+ edges for crates seeds (no KV reads needed)
        const genres = csvParam(q.get('genres'));
        const artists = csvParam(q.get('artists'));
        const djs = csvParam(q.get('djs'));

        const seedPool = allCandidates
          .filter(c => {
            if (c.e < 4) return false;
            if (genres.length > 0 && !genres.some(g => c.g.includes(g))) return false;
            if (artists.length > 0 && !artists.some(a => c.a.includes(a.toLowerCase()))) return false;
            if (djs.length > 0) {
              const djsLower = djs.map(d => d.toLowerCase());
              if (!c.d.some(d => djsLower.includes(d))) return false;
            }
            return true;
          })
          .map(c => c.id);


        // Deterministic shuffle
        const pool = [...seedPool];
        for (let i = pool.length - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          [pool[i], pool[j]] = [pool[j], pool[i]];
        }

        // Fix 3: direct page slicing — jump straight to this page's starting index.
        // No O(page) fast-forward loop; usedNodes tracks only within this request.
        const startIdx = page * count;
        const usedNodes = new Set();

        // Fix 2: level-by-level batched BFS — one Promise.all per frontier level
        // instead of one sequential KV read per node.
        async function buildCrateCluster(seedKey) {
          if (usedNodes.has(seedKey)) return null;
          const size = 15 + Math.floor(rng() * 40);

          // BFS: fetch each frontier level in parallel
          const visited = new Set([seedKey]);
          let frontier = [seedKey];
          while (frontier.length > 0 && visited.size < size) {
            const frontierNodes = await Promise.all(
              frontier.map(id => getNode(env.GRAPH_KV, id))
            );
            const next = [];
            for (let fi = 0; fi < frontier.length; fi++) {
              const node = frontierNodes[fi];
              if (!node || !node.edges) continue;
              for (const edge of node.edges) {
                if (visited.size >= size) break;
                if (!visited.has(edge.node)) {
                  visited.add(edge.node);
                  next.push(edge.node);
                }
              }
            }
            frontier = next;
          }

          const members = [...visited];
          const overlap = members.filter(m => usedNodes.has(m)).length;
          if (overlap > members.length * 0.3) return null;

          // Fetch all member nodes in parallel for artwork
          const memberNodes = await Promise.all(members.map(id => getNode(env.GRAPH_KV, id)));
          const artworks = [], artKeys = [];
          for (let i = 0; i < members.length; i++) {
            if (memberNodes[i] && memberNodes[i].artUrl) {
              artworks.push(memberNodes[i].artUrl);
              artKeys.push(members[i]);
            }
          }

          const seedNode = memberNodes[0];
          const [artist, title] = seedKey.split(':::');
          let displayCount = 1;
          if (seedNode && seedNode.edges) {
            const r1 = seedNode.edges.length;
            displayCount = 1 + r1 + Math.min(2, r1) * 2;
          }

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

        // Collect this page's clusters starting from the page's slice of the pool
        const clusters = [];
        let poolIdx = startIdx;
        while (clusters.length < count && poolIdx < pool.length) {
          const c = await buildCrateCluster(pool[poolIdx++]);
          if (c) { c.memberKeys.forEach(k => usedNodes.add(k)); clusters.push(c); }
        }

        return jsonResponse({ clusters, hasMore: poolIdx < pool.length });
      }

      // GET /api/crates-index — pre-computed seed metadata for client-side crates
      if (url.pathname === '/api/crates-index') {
        const raw = await env.GRAPH_KV.get('crates-index', 'text');
        if (!raw) return jsonResponse({ error: 'crates-index not found — rebuild KV' }, 404);
        return new Response(raw, {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
          },
        });
      }

      return jsonResponse({ error: 'Not found' }, 404);
    } catch (err) {
      console.error('Worker error:', err);
      return jsonResponse({ error: err.message }, 500);
    }
  },
};
