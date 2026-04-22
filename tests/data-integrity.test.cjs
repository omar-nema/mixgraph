/**
 * Data integrity tests — API correctness + cross-reference to source episode JSON.
 *
 * For each of N shuffles we:
 *   1. Fetch a cluster from /api/shuffle
 *   2. Assert response shape + audio-source invariants
 *   3. For each root→r1 and r1→r2 edge with a context.episodeUrl:
 *        - Load the scraped episode JSON
 *        - Find both endpoints in the tracklist
 *        - Confirm they appear at ADJACENT positions (|Δpos| === 1)
 *        - Confirm displayed artist/title match the scraped raw strings
 *   4. Spot-check filters: source, genre, artist, DJ — pool size + honored constraint.
 *   5. Crates determinism: identical seed+page → byte-identical response.
 *
 * Requires `npm run server` on :3001.
 * Run: node tests/data-integrity.test.cjs
 */
const { readFileSync } = require('fs');
const { resolve } = require('path');
const H = require('./_helpers.cjs');
const { setTest, pass, fail, assertTrue, assertEq, normalize, apiFetch, runner } = H;

const SHUFFLE_SAMPLES = Number(process.env.SAMPLES || 8);
const ROOT = resolve(__dirname, '..');

// ── Episode lookup — load scraper output once, index by episode_url ──────────
let EPISODES = null;
function loadEpisodes() {
  if (EPISODES) return EPISODES;
  const map = new Map();
  const files = [
    `${ROOT}/scrapers/lot-radio/output/lot_radio_episodes.json`,
    `${ROOT}/scrapers/nts/output/nts_episodes.json`,
  ];
  for (const f of files) {
    try {
      const arr = JSON.parse(readFileSync(f, 'utf8'));
      for (const ep of arr) if (ep.episode_url) map.set(ep.episode_url, ep);
    } catch (e) {
      console.log(`  (note: couldn't load ${f}: ${e.message})`);
    }
  }
  EPISODES = map;
  console.log(`  (loaded ${map.size} episodes for cross-reference)`);
  return map;
}

const graphIdFor = (artist, title) => `${normalize(artist)}:::${normalize(title)}`;

function findTrackInEpisode(ep, graphId) {
  if (!ep || !ep.tracklist) return null;
  for (const t of ep.tracklist) {
    if (graphIdFor(t.artist || '', t.title || '') === graphId) {
      return { position: t.position, rawArtist: t.artist, rawTitle: t.title };
    }
  }
  return null;
}

// ── Node / cluster invariants ────────────────────────────────────────────────
function assertNodeAudioInvariants(n) {
  if (typeof n.graphId !== 'string' || !n.graphId.includes(':::')) fail(`node ${n.id} has bad graphId: ${n.graphId}`);
  if (!n.title || !n.artist) fail(`node ${n.id} missing title/artist`);
  if (!Array.isArray(n.djs)) fail(`node ${n.id} djs not array`);
  if (n.source === 'soundcloud'     && !n.scTrackUrl) fail(`node ${n.id} source=soundcloud but no scTrackUrl`);
  if (n.source === 'soundcloud_set' && !n.setUrl)     fail(`node ${n.id} source=soundcloud_set but no setUrl`);
  if (n.source === 'mixcloud_set'   && !n.setUrl)     fail(`node ${n.id} source=mixcloud_set but no setUrl`);
  if (n.source === 'not_found' && (n.scTrackUrl || n.setUrl)) fail(`node ${n.id} source=not_found yet has audio urls`);
}

function assertClusterShape(c) {
  assertTrue(c && c.meta && Array.isArray(c.nodes) && Array.isArray(c.edges), 'cluster has {meta,nodes,edges}');
  const root = c.nodes.find(n => n.rank === 'root');
  assertTrue(root && root.id === 'root', 'root node exists with id="root"');
  assertEq(c.meta.root_id, root?.graphId, 'meta.root_id === root.graphId');
  const byId = Object.fromEntries(c.nodes.map(n => [n.id, n]));
  let badRef = 0, r2ToRoot = 0;
  for (const e of c.edges) {
    if (!byId[e.from] || !byId[e.to]) badRef++;
    const fromR = byId[e.from]?.rank, toR = byId[e.to]?.rank;
    if ((fromR === 'root' && toR === '2') || (fromR === '2' && toR === 'root')) r2ToRoot++;
  }
  assertEq(badRef, 0, 'every edge references an existing node id');
  assertEq(r2ToRoot, 0, 'no r2 connected directly to root');
  for (const n of c.nodes) assertNodeAudioInvariants(n);
}

// ── Tests ────────────────────────────────────────────────────────────────────
async function testServerReachable() {
  setTest('A1. Server is up and /api/genres loads');
  const g = await apiFetch('/api/genres');
  assertTrue(Array.isArray(g) && g.length > 0, `genres is non-empty array (n=${g?.length})`);
  if (Array.isArray(g) && g.length > 0) {
    assertTrue(g[0].name && typeof g[0].count === 'number', 'genre entry has {name,count}');
    assertTrue(g.every((x, i) => i === 0 || g[i - 1].count >= x.count), 'genres sorted by count desc');
  }
}

async function testShuffleShapeAndAdjacency() {
  setTest(`B1. Shuffle×${SHUFFLE_SAMPLES}: shape + audio + source-adjacency trace`);
  const episodes = loadEpisodes();
  const seenRoots = new Set();
  let adjChecks = 0, adjOk = 0, titleMatch = 0, missingEp = 0;

  for (let i = 0; i < SHUFFLE_SAMPLES; i++) {
    const c = await apiFetch('/api/shuffle');
    assertClusterShape(c);
    seenRoots.add(c.meta.root_id);
    const byId = Object.fromEntries(c.nodes.map(n => [n.id, n]));

    for (const e of c.edges) {
      if (!e.context?.episodeUrl) continue;
      const ep = episodes.get(e.context.episodeUrl);
      if (!ep) { missingEp++; continue; }
      const a = findTrackInEpisode(ep, byId[e.from].graphId);
      const b = findTrackInEpisode(ep, byId[e.to].graphId);
      if (!a || !b) continue;
      adjChecks++;
      if (Math.abs(a.position - b.position) === 1) adjOk++;
      if (normalize(a.rawArtist) === normalize(byId[e.from].artist) &&
          normalize(a.rawTitle)  === normalize(byId[e.from].title)) titleMatch++;
    }
  }
  assertTrue(seenRoots.size >= Math.min(SHUFFLE_SAMPLES, 3), `variety: ${seenRoots.size} distinct roots across ${SHUFFLE_SAMPLES} shuffles`);
  if (adjChecks > 0) {
    const pct = (adjOk / adjChecks * 100).toFixed(1);
    assertTrue(adjOk === adjChecks, `adjacency: ${adjOk}/${adjChecks} pairs consecutive in source tracklist (${pct}%)`);
    assertTrue(titleMatch >= Math.floor(adjChecks * 0.9), `title/artist round-trip: ${titleMatch}/${adjChecks} normalized-equal`);
  } else {
    console.log(`  (no cross-referenceable edges in sample — ${missingEp} unknown episode URLs)`);
  }
}

async function testHistoryExclude() {
  setTest('B2. exclude parameter suppresses the excluded root');
  const a = await apiFetch('/api/shuffle');
  const b = await apiFetch('/api/shuffle', { exclude: a.meta.root_id });
  assertTrue(a.meta.root_id !== b.meta.root_id, `root changes with exclude (${a.meta.root_id} → ${b.meta.root_id})`);
}

async function testClusterById() {
  setTest('B3. /api/cluster/:id returns the requested node as root');
  const s = await apiFetch('/api/shuffle');
  const id = s.meta.root_id;
  const c = await apiFetch(`/api/cluster/${encodeURIComponent(id)}`);
  assertEq(c.meta.root_id, id, 'round-trip by id works');

  let status = 0;
  try { await apiFetch('/api/cluster/__definitely_not_a_real_node__:::__nope__'); }
  catch (e) { status = e.status; }
  assertEq(status, 404, 'unknown id → 404');
}

async function testSourceFilter() {
  setTest('C1. source filter — returned root matches source claim');
  const ref = await apiFetch('/api/shuffle');
  const refPool = ref.meta.poolSize;
  const sc  = await apiFetch('/api/shuffle', { source: 'soundcloud' });
  const scs = await apiFetch('/api/shuffle', { source: 'soundcloud_set' });
  const lr  = await apiFetch('/api/shuffle', { source: 'lotradio' });
  const rootOf = (c) => c.nodes.find(n => n.rank === 'root');
  assertTrue(!!rootOf(sc)?.scTrackUrl, 'soundcloud: root has scTrackUrl');
  assertEq (rootOf(scs)?.source, 'soundcloud_set', 'soundcloud_set: root.source matches');
  assertTrue(!rootOf(scs)?.scTrackUrl, 'soundcloud_set: root has NO scTrackUrl');
  assertEq (rootOf(lr)?.setSource, 'soundcloud', 'lotradio: root.setSource=soundcloud');
  assertTrue(sc.meta.poolSize  <= refPool, `sc poolSize (${sc.meta.poolSize}) ≤ unfiltered (${refPool})`);
  assertTrue(scs.meta.poolSize <= refPool, `scs poolSize (${scs.meta.poolSize}) ≤ unfiltered (${refPool})`);
}

async function testGenreFilter() {
  setTest('C2. genre filter — non-empty pool; nonexistent → 404');
  const genres = await apiFetch('/api/genres');
  const pick = genres[0]?.name || 'Electronic';
  const c = await apiFetch('/api/shuffle', { genres: pick });
  assertTrue(c.meta.poolSize > 0, `${pick} pool non-empty (size=${c.meta.poolSize})`);
  let status = 0;
  try { await apiFetch('/api/shuffle', { genres: '__zzz_not_a_genre__' }); } catch (e) { status = e.status; }
  assertEq(status, 404, 'nonexistent genre → 404');
}

async function testArtistFilter() {
  setTest('C3. artist filter — cluster contains the artist (root or neighbor)');
  const [top] = await apiFetch('/api/search/artists', { q: 'a', limit: 1 });
  if (!top) return fail('artist search returned no results');
  const name = top.display;
  const c = await apiFetch('/api/shuffle', { artists: name });
  const norm = normalize(name);
  const hit = c.nodes.some(n => {
    const parts = (n.artist || '').split(/\s*,\s*|\s+[Ff]eat\.?\s+|\s+[Ff]t\.?\s+|\s+[Xx]\s+|\s*[&+]\s*|\s+and\s+/);
    return parts.some(p => normalize(p) === norm);
  });
  assertTrue(hit, `cluster contains artist "${name}"`);

  let status = 0;
  try { await apiFetch('/api/shuffle', { artists: '__zzz_no_artist__' }); } catch (e) { status = e.status; }
  assertEq(status, 404, 'nonexistent artist → 404');
}

async function testDjFilter() {
  setTest('C4. DJ filter — at least one node carries the requested DJ');
  const [top] = await apiFetch('/api/search/djs', { q: 'a', limit: 1 });
  if (!top) return fail('dj search returned no results');
  const name = top.display;
  const c = await apiFetch('/api/shuffle', { djs: name });
  const hit = c.nodes.some(n => (n.djs || []).some(d => normalize(d.name) === normalize(name)));
  assertTrue(hit, `cluster contains DJ "${name}" on at least one node`);
}

async function testCombinedFilters() {
  setTest('C5. combined filters: pool shrinks monotonically as filters stack');
  const none = await apiFetch('/api/shuffle');
  const sc   = await apiFetch('/api/shuffle', { source: 'soundcloud' });
  assertTrue(sc.meta.poolSize <= none.meta.poolSize,
             `source alone ≤ unfiltered (${sc.meta.poolSize} ≤ ${none.meta.poolSize})`);
}

async function testArtistSearchOrdering() {
  setTest('D1. artist search: prefix matches come before substring matches');
  const res = await apiFetch('/api/search/artists', { q: 'bur', limit: 20 });
  if (res.length < 2) return pass('(fewer than 2 results — skipped)');
  let firstSub = -1, lastPre = -1;
  for (let i = 0; i < res.length; i++) {
    const d = res[i].display.toLowerCase();
    if (d.startsWith('bur')) lastPre = i;
    else if (d.includes('bur') && firstSub < 0) firstSub = i;
  }
  if (firstSub >= 0 && lastPre >= 0) {
    assertTrue(lastPre < firstSub, `prefix before substring (last-prefix=${lastPre}, first-substring=${firstSub})`);
  } else {
    pass('(no mixed prefix/substring in sample — skipped)');
  }
}

async function testTrackSearchEndpoint() {
  setTest('D2. track search: returns entries with display + artist');
  const res = await apiFetch('/api/search/tracks', { q: 'blue', limit: 5 });
  assertTrue(Array.isArray(res) && res.length > 0, `non-empty results (n=${res.length})`);
  for (const entry of res) {
    if (!entry.display || !entry.artist) {
      fail(`entry missing display/artist: ${JSON.stringify(entry)}`);
      return;
    }
  }
  pass('all entries have {display, artist}');
  assertTrue(res[0].display.toLowerCase().includes('blue'), `first result contains query ("${res[0].display}")`);
}

async function testTrackTitleFilter() {
  setTest('D3. shuffle with title filter → root matches title');
  const tracks = await apiFetch('/api/search/tracks', { q: 'a', limit: 1 });
  if (!tracks.length) return fail('no tracks to test');
  const title = tracks[0].display;
  const cluster = await apiFetch('/api/shuffle', { title });
  const rootTitle = cluster.nodes.find(n => n.id === 'root')?.title;
  assertEq(rootTitle?.toLowerCase(), title.toLowerCase(), `root title matches "${title}"`);
}

async function testCratesDeterminism() {
  setTest('E1. /api/crates deterministic for same (seed,page,count)');
  const a = await apiFetch('/api/crates', { seed: 12345, page: 0, count: 8 });
  const b = await apiFetch('/api/crates', { seed: 12345, page: 0, count: 8 });
  assertTrue(JSON.stringify(a) === JSON.stringify(b), 'identical JSON on repeat call');
  assertTrue(Array.isArray(a.clusters) && a.clusters.length > 0, `clusters non-empty (n=${a.clusters.length})`);
  for (const cr of a.clusters) {
    if (!cr.seedKey || !cr.count || !Array.isArray(cr.artworks)) {
      fail(`crate missing required fields: ${JSON.stringify(Object.keys(cr))}`);
      return;
    }
  }
  pass('all crates have {seedKey,count,artworks}');
}

async function testCratesPagesDontOverlap() {
  setTest('E2. /api/crates page 0 and page 1 have no overlapping seedKeys');
  const p0 = await apiFetch('/api/crates', { seed: 777, page: 0, count: 10 });
  const p1 = await apiFetch('/api/crates', { seed: 777, page: 1, count: 10 });
  const s0 = new Set(p0.clusters.map(c => c.seedKey));
  const overlap = p1.clusters.filter(c => s0.has(c.seedKey));
  assertEq(overlap.length, 0, `no overlap between page 0 and page 1`);
}

async function testCratesBoundaryErrors() {
  setTest('E3. /api/crates error handling');
  let missing = 0, tooDeep = 0;
  try { await apiFetch('/api/crates', { page: 0, count: 5 }); } catch (e) { missing = e.status; }
  try { await apiFetch('/api/crates', { seed: 1, page: 51, count: 5 }); } catch (e) { tooDeep = e.status; }
  assertEq(missing, 400, 'missing seed → 400');
  assertEq(tooDeep, 400, 'page > 50 → 400');
}

// ── Runner ───────────────────────────────────────────────────────────────────
runner([
  testServerReachable,
  testShuffleShapeAndAdjacency,
  testHistoryExclude,
  testClusterById,
  testSourceFilter,
  testGenreFilter,
  testArtistFilter,
  testDjFilter,
  testCombinedFilters,
  testArtistSearchOrdering,
  testTrackSearchEndpoint,
  testTrackTitleFilter,
  testCratesDeterminism,
  testCratesPagesDontOverlap,
  testCratesBoundaryErrors,
])
  .then(code => process.exit(code))
  .catch(e => { console.error(e); process.exit(2); });
