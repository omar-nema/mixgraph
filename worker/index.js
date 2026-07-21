// Cloudflare Worker adapter for b2b API
// Reads graph nodes from KV on demand — never loads full graph into memory.
// Pre-computed index blobs (candidates, genres, artist-index, dj-index, dj-name-map)
// are cached in-memory after first read.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

// Lightweight User-Agent parser for telemetry (device type, OS, browser).
// Not exhaustive — just enough to segment traffic in Grafana.
function parseUA(ua) {
  ua = ua || '';
  // Device type
  let device = 'desktop';
  if (/\b(iPad|Tablet)\b/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) device = 'tablet';
  else if (/Mobi|iPhone|iPod|Android.*Mobile|Windows Phone/i.test(ua)) device = 'mobile';
  // OS
  let os = 'other';
  if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS';
  else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Linux/i.test(ua)) os = 'Linux';
  // Browser (order matters: Edge/Chrome UAs also contain "Safari")
  let browser = 'other';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/i.test(ua)) browser = 'Opera';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Chrome\/|CriOS/i.test(ua)) browser = 'Chrome';
  else if (/Safari\//i.test(ua)) browser = 'Safari';
  return { device, os, browser };
}

// Reduce a referrer URL to an acquisition source. Known platforms get a clean
// label; anything else falls back to the bare hostname; empty = 'direct'.
function classifyReferrer(ref) {
  if (!ref) return 'direct';
  let host;
  try { host = new URL(ref).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return 'other'; }
  if (/(^|\.)reddit\.com$|(^|\.)redd\.it$/.test(host)) return 'reddit';
  if (/(^|\.)(twitter\.com|x\.com|t\.co)$/.test(host)) return 'twitter';
  if (/(^|\.)instagram\.com$|(^|\.)l\.instagram\.com$/.test(host)) return 'instagram';
  if (/(^|\.)(facebook\.com|fb\.com|l\.facebook\.com|lm\.facebook\.com)$/.test(host)) return 'facebook';
  if (/(^|\.)(youtube\.com|youtu\.be)$/.test(host)) return 'youtube';
  if (/(^|\.)(tiktok\.com)$/.test(host)) return 'tiktok';
  if (/(^|\.)(google\.|bing\.com|duckduckgo\.com|search\.brave\.com)/.test(host)) return 'search';
  if (/(^|\.)(news\.ycombinator\.com|hn\.algolia\.com)$/.test(host)) return 'hackernews';
  if (/(^|\.)(t\.me|telegram\.org)$/.test(host)) return 'telegram';
  return host; // unrecognized — keep the raw hostname for drill-down
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
      // All distinct DJ set names this adjacency appears in (dedup, keep order)
      const seen = new Set();
      const djSets = [];
      for (const c of edge.contexts) {
        const name = (c.dj || '').trim();
        if (name && !seen.has(name)) { seen.add(name); djSets.push(name); }
      }
      return { dj: ctx.dj || '', episodeUrl: ctx.episode_url || '', date: ctx.date || '', djSets };
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
    setOffsetSec: kvNode.setOffsetSec ?? null, // keep 0 (real 0:00 offset)
    setDj: kvNode.setDj || null,
    genres: kvNode.genres || [],
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

function clusterMeetsMinimum(cluster) {
  if (!cluster) return false;
  const r1Count = cluster.nodes.filter(n => n.rank === '1').length;
  const r2Count = cluster.nodes.filter(n => n.rank === '2').length;
  return r1Count >= 2 && r2Count >= 2;
}

// ── Candidate filtering in D1 (shared by shuffle, crates, crates-index) ──
// Builds parameterised WHERE clauses mirroring the old in-JS blob filter:
//   source / title(exact) / genre(any-of) / dj(any-of) / artist(substring)
//   + optional minEdges (crates requires 4+ edges).
function candidateFilterClauses({ genres = [], artists = [], djs = [], title = '', source, minEdges } = {}) {
  const clauses = [];
  const binds = [];
  if (minEdges != null) clauses.push(`e >= ${Number(minEdges)}`);
  if (source && source !== 'none') {
    if (source === 'soundcloud') clauses.push('st = 1');
    else if (source === 'soundcloud_set') clauses.push("st = 0 AND s = 'soundcloud_set'");
    else if (source === 'lotradio') clauses.push("st = 0 AND ss = 'soundcloud'");
  }
  if (title) { clauses.push('t = ?'); binds.push(title.toLowerCase()); }
  if (genres.length > 0) {
    clauses.push('EXISTS (SELECT 1 FROM json_each(candidates.g) je WHERE je.value IN (SELECT value FROM json_each(?)))');
    binds.push(JSON.stringify(genres));
  }
  if (djs.length > 0) {
    clauses.push('EXISTS (SELECT 1 FROM json_each(candidates.d) je WHERE je.value IN (SELECT value FROM json_each(?)))');
    binds.push(JSON.stringify(djs.map(d => d.toLowerCase())));
  }
  if (artists.length > 0) {
    clauses.push("EXISTS (SELECT 1 FROM json_each(?) qa WHERE candidates.a LIKE '%' || qa.value || '%')");
    binds.push(JSON.stringify(artists.map(a => a.toLowerCase())));
  }
  return { clauses, binds };
}

// ── Seed selection from D1 (for /api/shuffle) ──
// Filtering + weighted random pick happen in SQL; graph traversal still uses KV.
//   - poolSize = matches BEFORE the exclude set (like the old pool.length)
//   - weighted A-Res pick by `w`, unless an artist/dj/title filter is active → uniform
//   - returns up to `limit` seeds in pick order, so the caller's re-roll loop can
//     walk them without extra round-trips (matches "pick, skip if thin" behaviour)
async function selectSeedsFromD1(db, filters, exclude, hasArtistDjFilter, limit) {
  const { clauses: where, binds } = candidateFilterClauses(filters);

  // Fast path: no filters + weighted pick → O(log n) cumulative-weight index seeks
  // instead of a full-table A-Res scan. Covers the common "just shuffle" case
  // (~5 rows read vs ~300K). Filtered/uniform picks fall through to the scan path.
  if (where.length === 0 && !hasArtistDjFilter) {
    const metaRows = (await db.prepare(
      "SELECT k, v FROM meta WHERE k IN ('total_count','total_weight')"
    ).all()).results || [];
    const meta = Object.fromEntries(metaRows.map(r => [r.k, r.v]));
    const poolSize = meta.total_count || 0;
    const totalW = meta.total_weight || 0;
    if (!poolSize || !totalW) return { seeds: [], poolSize: 0 };

    const excludeArr = [...exclude];
    const runSeeks = async (withExclude) => {
      const thresholds = Array.from({ length: limit }, () => Math.random() * totalW);
      const valuesSql = thresholds.map(() => '(?)').join(',');
      const body = withExclude && excludeArr.length
        ? 'SELECT id FROM candidates WHERE cw > r.x AND id NOT IN (SELECT value FROM json_each(?)) ORDER BY cw LIMIT 1'
        : 'SELECT id FROM candidates WHERE cw > r.x ORDER BY cw LIMIT 1';
      const sql = `WITH r(x) AS (VALUES ${valuesSql}) SELECT (${body}) AS id FROM r`;
      const b = withExclude && excludeArr.length ? [...thresholds, JSON.stringify(excludeArr)] : thresholds;
      const rows = (await db.prepare(sql).bind(...b).all()).results || [];
      return [...new Set(rows.map(r => r.id).filter(Boolean))];
    };

    let seeds = await runSeeks(true);
    if (seeds.length === 0 && excludeArr.length) seeds = await runSeeks(false); // exclude wiped the pool
    return { seeds, poolSize };
  }

  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  // poolSize = matches before exclude (mirrors the old pool.length)
  const countRow = await db.prepare(`SELECT COUNT(*) AS n FROM candidates ${whereSql}`).bind(...binds).first();
  const poolSize = countRow ? countRow.n : 0;
  if (poolSize === 0) return { seeds: [], poolSize: 0 };

  const orderBy = hasArtistDjFilter
    ? 'random()'                                              // uniform pick
    : 'pow(abs(random()) / 9.223372036854776e18, 1.0 / w) DESC'; // A-Res weighted pick

  const excludeArr = [...exclude];
  const buildSeedQuery = (withExclude) => {
    const clauses = [...where];
    const b = [...binds];
    if (withExclude && excludeArr.length) {
      clauses.push('id NOT IN (SELECT value FROM json_each(?))');
      b.push(JSON.stringify(excludeArr));
    }
    const w = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    return { sql: `SELECT id FROM candidates ${w} ORDER BY ${orderBy} LIMIT ${limit}`, b };
  };

  // Try honouring the exclude set; if it removes everything, fall back to the
  // full pool (matches the old `if (unseen.length === 0) unseen = pool`).
  let { sql, b } = buildSeedQuery(true);
  let rows = (await db.prepare(sql).bind(...b).all()).results || [];
  if (rows.length === 0) {
    ({ sql, b } = buildSeedQuery(false));
    rows = (await db.prepare(sql).bind(...b).all()).results || [];
  }
  return { seeds: rows.map(r => r.id), poolSize };
}

// Crates seed pool (for /api/crates): matching candidate ids with 4+ edges, in a
// stable order so the deterministic per-seed shuffle + pagination stay consistent
// across page requests.
async function cratesSeedIdsFromD1(db, filters) {
  const { clauses, binds } = candidateFilterClauses({ ...filters, minEdges: 4 });
  const whereSql = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const rows = (await db.prepare(`SELECT id FROM candidates ${whereSql} ORDER BY id`).bind(...binds).all()).results || [];
  return rows.map(r => r.id);
}

// Crates-index full-filter path (for /api/crates-index): matching candidates with
// no edge threshold, returning the fields the caller needs downstream
// (genres for bucketing, artist/djs for output).
async function cratesMatchesFromD1(db, filters) {
  const { clauses, binds } = candidateFilterClauses(filters);
  const whereSql = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const rows = (await db.prepare(`SELECT id, g, a, d FROM candidates ${whereSql}`).bind(...binds).all()).results || [];
  return rows.map(r => ({ id: r.id, g: JSON.parse(r.g || '[]'), a: r.a, d: JSON.parse(r.d || '[]') }));
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

      // GET /api/search/tracks
      if (url.pathname === '/api/search/tracks') {
        const index = await env.GRAPH_KV.get('track-index', 'json');
        const results = searchList(index || [], q.get('q') || '', parseInt(q.get('limit')) || 20);
        return jsonResponse(results);
      }

      // GET /api/shuffle
      if (url.pathname === '/api/shuffle') {
        // Seed selection runs in D1 (filter + weighted pick); graph traversal
        // still runs on KV via selectClusterFromKV below.
        const filters = {
          genres: csvParam(q.get('genres')),
          artists: csvParam(q.get('artists')),
          djs: csvParam(q.get('djs')),
          title: q.get('title') || '',
          source: q.get('source'),
        };
        const exclude = new Set(csvParam(q.get('exclude')));
        const r1 = parseInt(q.get('r1')) || 4;
        const r2 = parseInt(q.get('r2')) || 1;
        const hasArtistDjFilter = filters.artists.length > 0 || filters.djs.length > 0 || !!filters.title;

        // Fetch up to maxAttempts seeds in pick order so the re-roll loop below
        // can walk them without extra D1 round-trips.
        const maxAttempts = 5;
        const { seeds, poolSize } = await selectSeedsFromD1(
          env.CANDIDATES_DB, filters, exclude, hasArtistDjFilter, maxAttempts
        );

        if (poolSize === 0) {
          return jsonResponse({ error: 'No tracks match current filters' }, 404);
        }

        // Re-roll through the pre-fetched (weighted-ordered) seeds if a cluster
        // is too thin (< 2 R1 or < 2 R2).
        let cluster = null;
        let attempts = 0;
        for (const seedId of seeds) {
          attempts++;
          cluster = await selectClusterFromKV(env.GRAPH_KV, seedId, r1, r2);
          if (clusterMeetsMinimum(cluster)) break;
        }

        if (!cluster) {
          return jsonResponse({ error: 'Failed to build cluster' }, 500);
        }
        cluster.meta.poolSize = poolSize;
        cluster.meta.attempts = attempts;
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

        // LCG for deterministic shuffle
        let rngState = seed === 0 ? 1 : seed;
        function rng() {
          rngState = (rngState * 16807) % 2147483647;
          return (rngState - 1) / 2147483646;
        }

        // Seed pool (4+ edges + filters) comes from D1 instead of the 20MB blob.
        const genres = csvParam(q.get('genres'));
        const artists = csvParam(q.get('artists'));
        const djs = csvParam(q.get('djs'));
        const seedPool = await cratesSeedIdsFromD1(env.CANDIDATES_DB, { genres, artists, djs });


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
        const genres = csvParam(q.get('genres'));
        const artists = csvParam(q.get('artists'));
        const djs = csvParam(q.get('djs'));
        const hasFilters = genres.length > 0 || artists.length > 0 || djs.length > 0;

        if (!hasFilters) {
          // No filters — return cached static blob
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

        // Filters active — need the index for every path.
        const index = await env.GRAPH_KV.get('crates-index', 'json');
        if (!index) return jsonResponse({ error: 'crates-index not found — rebuild KV' }, 404);

        // Fast path: genre-only filter where every selected genre is well-covered by
        // the index (≥ MIN seeds each). Serve seed-direct matches straight from the
        // index — no 20MB candidates read, no live KV node fetches. Per-genre (not
        // pooled) so a big genre can't drag a small one onto the fast path.
        const CRATES_FAST_PATH_MIN = 750;
        if (genres.length > 0 && artists.length === 0 && djs.length === 0) {
          const gcount = {};
          for (const g of genres) gcount[g] = 0;
          for (const c of index) {
            for (const g of (c.g || [])) if (g in gcount) gcount[g]++;
          }
          if (genres.every(g => gcount[g] >= CRATES_FAST_PATH_MIN)) {
            return jsonResponse(index.filter(c => genres.some(g => (c.g || []).includes(g))));
          }
        }

        // Full path — match against all candidates via D1 (no edge threshold).
        const matches = await cratesMatchesFromD1(env.CANDIDATES_DB, { genres, artists, djs });
        const matchIds = new Set();
        const matchCandidates = {};
        for (const c of matches) {
          matchIds.add(c.id);
          matchCandidates[c.id] = c;
        }

        // Start with crates-index entries where seed or neighbor matches
        const indexIds = new Set();
        const filtered = index.filter(c => {
          const hit = matchIds.has(c.id) || (c.n || []).some(n => matchIds.has(n));
          if (hit) indexIds.add(c.id);
          return hit;
        });

        // Add entries for matching candidates not already in the index. Fetch their
        // nodes live for artwork + neighbors, capped to avoid worker timeout. With
        // multiple genres, distribute the budget round-robin so a large genre can't
        // starve a small one out of the supplement.
        const EXTRA_BUDGET = 100;
        const nonIndexed = Object.keys(matchCandidates).filter(id => !indexIds.has(id));
        let extraIds;
        if (genres.length > 1) {
          const buckets = genres.map(g => nonIndexed.filter(id => (matchCandidates[id].g || []).includes(g)));
          const picked = new Set();
          extraIds = [];
          let progress = true;
          while (extraIds.length < EXTRA_BUDGET && progress) {
            progress = false;
            for (const bucket of buckets) {
              while (bucket.length) {
                const id = bucket.shift();
                if (!picked.has(id)) { picked.add(id); extraIds.push(id); progress = true; break; }
              }
              if (extraIds.length >= EXTRA_BUDGET) break;
            }
          }
        } else {
          extraIds = nonIndexed.slice(0, EXTRA_BUDGET);
        }
        if (extraIds.length > 0) {
          // Batch in chunks of 20 to avoid KV fan-out limits
          const nodes = [];
          for (let b = 0; b < extraIds.length; b += 20) {
            const chunk = extraIds.slice(b, b + 20);
            const batch = await Promise.all(chunk.map(id => getNode(env.GRAPH_KV, id)));
            nodes.push(...batch);
          }
          for (let i = 0; i < extraIds.length; i++) {
            const id = extraIds[i], c = matchCandidates[id], node = nodes[i];
            const [artist, title] = id.split(':::');
            const neighbors = node?.edges?.map(e => e.node) || [];
            const artworks = node?.artUrl ? [node.artUrl] : [];
            // Also grab neighbor artwork
            if (neighbors.length > 0) {
              const nNodes = await Promise.all(neighbors.slice(0, 8).map(n => getNode(env.GRAPH_KV, n)));
              for (const nn of nNodes) {
                if (nn?.artUrl) artworks.push(nn.artUrl);
              }
            }
            const cnt = Math.max(5, 1 + neighbors.length * 2);
            filtered.push({
              id, artworks, n: neighbors,
              count: cnt, weight: cnt,
              g: c.g || [], a: c.a || artist, d: c.d || [],
            });
          }
        }

        return jsonResponse(filtered);
      }

      // POST /api/event — telemetry via Analytics Engine
      if (request.method === 'POST' && url.pathname === '/api/event') {
        const { event, uid, layout, w, ref, utm, sid } = await request.json();
        const validEvents = ['shuffle', 'play', 'crates', 'filter_genre', 'filter_artist', 'filter_dj'];
        if (!validEvents.includes(event)) {
          return jsonResponse({ error: 'Invalid event' }, 400);
        }
        const cf = request.cf || {};
        const { device, os, browser } = parseUA(request.headers.get('user-agent'));
        // Acquisition source: explicit utm_source wins, else classify the client's
        // initial document.referrer. (The request's own Referer header is just our
        // origin — the beacon fires from our page — so it's useless for this.)
        const source = (utm ? String(utm).toLowerCase().slice(0, 64) : classifyReferrer(ref)).slice(0, 128);
        const layoutStr = layout === 'mobile' || layout === 'desktop' ? layout : '';
        env.EVENTS.writeDataPoint({
          blobs: [event, cf.country || '', cf.city || '', uid || '', device, os, browser, source, layoutStr, String(sid || '').slice(0, 64)],
          doubles: [parseFloat(cf.latitude) || 0, parseFloat(cf.longitude) || 0, parseInt(w) || 0],
          indexes: [event],
        });
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      return jsonResponse({ error: 'Not found' }, 404);
    } catch (err) {
      console.error('Worker error:', err);
      return jsonResponse({ error: err.message }, 500);
    }
  },
};
