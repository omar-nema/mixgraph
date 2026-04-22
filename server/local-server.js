// Local Node server — loads graph data from disk, serves API endpoints
// Adapter for shared/graph-logic.js (provider-agnostic graph logic)

import express from 'express';
import cors from 'cors';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  selectCluster, buildCandidates, buildIndexes, buildGenreList,
  getFilteredPool, weightedPickFromPool, generateCratesPage,
} from '../shared/graph-logic.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../pipeline/output');

// ── Load data (synchronous, one-time at startup) ──
console.log('Loading graph data...');
const t0 = Date.now();
const graphNodes = JSON.parse(readFileSync(`${root}/combined_graph.json`, 'utf8')).nodes;
const audioCache = JSON.parse(readFileSync(`${root}/audio_cache.json`, 'utf8'));
const djNameMap  = JSON.parse(readFileSync(`${root}/dj_name_map.json`, 'utf8'));
console.log(`Loaded in ${Date.now() - t0}ms — ${Object.keys(graphNodes).length} nodes`);

// ── Pre-compute derived data ──
const { candidates, candidateWeights, idxMap } = buildCandidates(graphNodes, audioCache);
const { artistListAlpha, djListAlpha, trackListAlpha } = buildIndexes(graphNodes, candidates, djNameMap);
const genreList = buildGenreList(graphNodes);
const displayGenres = genreList.slice(0, 30);
console.log(`${candidates.length} candidates, ${artistListAlpha.length} artists, ${djListAlpha.length} DJs, ${trackListAlpha.length} tracks, ${genreList.length} genres`);

// ── Server ──
const app = express();
app.use(cors({ origin: '*' }));

// Helper: parse comma-separated query param
function csvParam(val) {
  if (!val) return [];
  return val.split(',').map(s => s.trim()).filter(Boolean);
}

// Search helper: prefix match then substring match
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

// GET /api/shuffle
app.get('/api/shuffle', (req, res) => {
  const filters = {
    source: req.query.source || undefined,
    genres: csvParam(req.query.genres),
    artists: csvParam(req.query.artists),
    djs: csvParam(req.query.djs),
    title: req.query.title || undefined,
  };
  // Clean up empty arrays
  if (filters.genres.length === 0) delete filters.genres;
  if (filters.artists.length === 0) delete filters.artists;
  if (filters.djs.length === 0) delete filters.djs;

  const exclude = new Set(csvParam(req.query.exclude));
  const r1 = parseInt(req.query.r1) || 4;
  const r2 = parseInt(req.query.r2) || 1;

  const pool = getFilteredPool(graphNodes, audioCache, candidates, filters, djNameMap);
  if (pool.length === 0) {
    return res.status(404).json({ error: 'No tracks match current filters' });
  }

  let unseen = pool.filter(id => !exclude.has(id));
  if (unseen.length === 0) unseen = pool;

  const hasArtistDjFilter = !!(filters.artists || filters.djs || filters.title);
  const rootId = weightedPickFromPool(unseen, candidateWeights, idxMap, hasArtistDjFilter);
  const cluster = selectCluster(graphNodes, audioCache, rootId, r1, r2, djNameMap);
  cluster.meta.poolSize = pool.length;

  res.json(cluster);
});

// GET /api/cluster/:id
app.get('/api/cluster/:id', (req, res) => {
  const id = decodeURIComponent(req.params.id);
  if (!graphNodes[id]) {
    return res.status(404).json({ error: `Node "${id}" not found` });
  }
  const r1 = parseInt(req.query.r1) || 4;
  const r2 = parseInt(req.query.r2) || 1;
  const expand = parseInt(req.query.expand) || 0;

  let r1Limit = r1, r2Limit = r2;
  if (expand === 1) { r1Limit = 8; }
  if (expand >= 2) { r1Limit = Infinity; r2Limit = Infinity; }

  const cluster = selectCluster(graphNodes, audioCache, id, r1Limit, r2Limit, djNameMap);
  if (!cluster) {
    return res.status(404).json({ error: `Node "${id}" not found` });
  }
  cluster.meta.expandLevel = expand;
  res.json(cluster);
});

// GET /api/search/artists
app.get('/api/search/artists', (req, res) => {
  const q = req.query.q || '';
  const limit = parseInt(req.query.limit) || 20;
  res.json(searchList(artistListAlpha, q, limit));
});

// GET /api/search/djs
app.get('/api/search/djs', (req, res) => {
  const q = req.query.q || '';
  const limit = parseInt(req.query.limit) || 20;
  res.json(searchList(djListAlpha, q, limit));
});

// GET /api/search/tracks
app.get('/api/search/tracks', (req, res) => {
  const q = req.query.q || '';
  const limit = parseInt(req.query.limit) || 20;
  res.json(searchList(trackListAlpha, q, limit));
});

// GET /api/genres
app.get('/api/genres', (req, res) => {
  res.json(displayGenres);
});

// GET /api/crates
app.get('/api/crates', (req, res) => {
  const seed = parseInt(req.query.seed);
  if (isNaN(seed)) {
    return res.status(400).json({ error: 'seed parameter required' });
  }
  const page = parseInt(req.query.page) || 0;
  const count = Math.min(parseInt(req.query.count) || 12, 24);

  const filters = {
    genres: csvParam(req.query.genres),
    artists: csvParam(req.query.artists),
    djs: csvParam(req.query.djs),
  };
  if (filters.genres.length === 0) delete filters.genres;
  if (filters.artists.length === 0) delete filters.artists;
  if (filters.djs.length === 0) delete filters.djs;

  if (page > 50) {
    return res.status(400).json({ error: 'Max page depth is 50' });
  }

  const result = generateCratesPage(graphNodes, audioCache, candidates, seed, page, count, filters, djNameMap);
  res.json(result);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\nAPI server running at http://localhost:${PORT}`);
  console.log('Endpoints: /api/shuffle, /api/cluster/:id, /api/search/artists, /api/search/djs, /api/search/tracks, /api/genres, /api/crates');
});
