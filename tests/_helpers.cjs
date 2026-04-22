/**
 * Shared test helpers — assertions, runner, Playwright plumbing.
 *
 * Used by: data-integrity.test.cjs, ui-flows.test.cjs, filters.test.cjs
 * Filename starts with _ so it isn't picked up as a test by any runner.
 *
 *   const H = require('./_helpers.cjs');
 *   H.assertEq(a, b, 'label');
 *   const { ctx, page } = await H.newPage(browser);
 *   await H.loadTracks(page);
 *   await H.runner(tests);
 */

// ── Config ───────────────────────────────────────────────────────────────────
const API_BASE       = process.env.API || 'http://localhost:3001';
const STATIC_BASE    = process.env.STATIC || 'http://localhost:8001';
const APP_URL_SILENT = `${STATIC_BASE}/?api=${API_BASE}&noplay`;
const APP_URL_MUTED  = `${STATIC_BASE}/?api=${API_BASE}`; // pair with --mute-audio
const DESKTOP_VIEWPORT = { width: 1280, height: 860 };
const MOBILE_VIEWPORT  = { width: 390,  height: 844 };

// Benign external errors we ignore (analytics, cached 404s, Worker-only endpoints
// that local server doesn't implement).
const IGNORE_PATTERNS = [
  'cloudflareinsights', 'cdn-cgi', 'ERR_FAILED',
  '404 ()', '404 (Not Found)', 'crates-index',
];
const isAppError = (text) => !IGNORE_PATTERNS.some(s => text.includes(s));

// ── Assertion plumbing ───────────────────────────────────────────────────────
const results = [];
let currentTest = '';
const setTest = (name) => { currentTest = name; console.log(`\n[${name}]`); };
const pass = (msg) => { results.push({ t: currentTest, ok: true,  msg }); console.log(`  ✓ ${msg}`); };
const fail = (msg) => { results.push({ t: currentTest, ok: false, msg }); console.log(`  ✗ ${msg}`); };
const assertTrue = (cond, label) => (cond ? pass(label) : fail(label));
const assertEq = (actual, expected, label) => {
  if (actual === expected) pass(`${label} (= ${JSON.stringify(actual)})`);
  else fail(`${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
};

// Run an array of test functions (each receiving `browser` or no arg).
// Returns the exit code (0 = all pass, 1 = any fail). Caller is responsible
// for calling process.exit — this lets the caller run teardown first.
async function runner(tests, { browser } = {}) {
  for (const t of tests) {
    try { await (browser ? t(browser) : t()); }
    catch (e) { fail(`THREW: ${e.message}`); }
  }
  const ok  = results.filter(r => r.ok).length;
  const bad = results.filter(r => !r.ok);
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`${ok} passed, ${bad.length} failed`);
  if (bad.length) {
    console.log('\nFailures:');
    for (const f of bad) console.log(`  ✗ [${f.t}] ${f.msg}`);
    return 1;
  }
  return 0;
}

// ── Normalization — mirrors pipeline/utils.py ────────────────────────────────
function normalize(text) {
  if (!text) return '';
  return text.normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/_/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── API client (no Playwright dependency) ────────────────────────────────────
async function apiFetch(path, params = {}) {
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') url.searchParams.set(k, v);
  }
  const r = await fetch(url);
  if (!r.ok) {
    let body = {};
    try { body = await r.json(); } catch {}
    const err = new Error(body.error || `HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

// Probe: /api/crates-index is Worker-only. Use to skip Dig tests locally.
let _digSupported = null;
async function digSupported() {
  if (_digSupported !== null) return _digSupported;
  try {
    const r = await fetch(`${API_BASE}/api/crates-index?v=3`);
    _digSupported = r.ok;
  } catch { _digSupported = false; }
  return _digSupported;
}

// ── Playwright helpers (loaded lazily so this module is safe for API-only tests) ──
async function newPage(browser, opts = {}) {
  const mobile = !!opts.mobile;
  const ctx = await browser.newContext({
    viewport: mobile ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT,
    hasTouch: mobile,
    isMobile: mobile,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console',   m => { if (m.type() === 'error' && isAppError(m.text())) errors.push('[console] ' + m.text()); });
  page._errors = errors; // tests can read this for a "no console errors" assertion
  return { ctx, page };
}

async function loadTracks(page, base = APP_URL_SILENT) {
  await page.goto(base);
  await page.waitForSelector('#mode-tabs .mode-tab[data-mode="tracks"]', { timeout: 10000 });
  await page.click('#mode-tabs .mode-tab[data-mode="tracks"]');
  // Retry once if the first shuffle doesn't land within 15s (flaky under load).
  try {
    await page.waitForSelector('.node-card[data-rank="root"]', { timeout: 15000 });
  } catch {
    await page.click('#filter-shuffle-btn').catch(() => {});
    await page.waitForSelector('.node-card[data-rank="root"]', { timeout: 15000 });
  }
  await page.waitForTimeout(400);
}

async function loadDig(page, base = APP_URL_SILENT) {
  await page.goto(base);
  await page.waitForSelector('#mode-tabs .mode-tab[data-mode="crates"]', { timeout: 10000 });
  await page.waitForSelector('#crates-view .crate-stack', { timeout: 20000 });
  await page.waitForTimeout(400);
}

// Snapshot of current cluster state. Merged superset of what ui-flows and
// filters used to collect separately.
function clusterSnapshot(page) {
  return page.evaluate(() => {
    const list = (typeof nodes !== 'undefined' && nodes) ? nodes : [];
    const root = list.find(n => n.rank === 'root') || list[0];
    const chips = (sel) => [...document.querySelectorAll(sel)].map(e => e.textContent.replace('×', '').trim());
    return {
      clusterId:   document.getElementById('cluster-id')?.textContent || '',
      rootArtist:  (root?.artist || '').trim(),
      rootTitle:   (root?.title  || '').trim(),
      rootGraphId:  root?.graphId || '',
      rootSource:   root?.source  || '',
      rootScTrackUrl: root?.scTrackUrl || '',
      rootDjs:     (root?.djs || []).map(d => d.name),
      nodes: list.map(n => ({
        id: n.id, rank: n.rank, artist: n.artist, title: n.title,
        graphId: n.graphId, source: n.source,
        genres: n.genres || [],
        djs: (n.djs || []).map(d => d.name),
        hasAudio: !!(n.scTrackUrl || n.setUrl),
        scTrackUrl: n.scTrackUrl || '',
        setUrl: n.setUrl || '',
      })),
      // Chip / pill surfaces
      clusterArtistPills: chips('#artist-cluster-pills .cluster-pill'),
      clusterDjPills:     chips('#dj-cluster-pills .cluster-pill'),
      findChips:          chips('#find-chips-input .find-chip'),
      djChips:            chips('#dj-chips-input .find-chip'),
      genreChips:         chips('#genre-chips-input .find-chip'),
      searchBarChips:     chips('#filter-search-chips .find-chip'),
      pillArtistActive: document.getElementById('pill-artist')?.classList.contains('active') || false,
      pillDjActive:     document.getElementById('pill-dj')   ?.classList.contains('active') || false,
      pillGenreActive:  document.getElementById('pill-genre')?.classList.contains('active') || false,
      genreFiltersFlat:    (typeof genreFilters      !== 'undefined' && genreFilters)      ? [...genreFilters] : [],
      searchFiltersState:  (typeof searchFilters     !== 'undefined' && searchFilters)     ? searchFilters.map(f => f.display) : [],
      djSearchFiltersState:(typeof djSearchFilters   !== 'undefined' && djSearchFilters)   ? djSearchFilters.map(f => f.display) : [],
    };
  });
}

// Add an artist filter via the unified search bar. `type` = 'artist' | 'dj'.
async function addViaSearchBar(page, name, type = 'artist') {
  await page.click('#filter-search');
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.type('#filter-search', name, { delay: 35 });
  await page.waitForSelector('#filter-search-ac.open .ac-item', { timeout: 8000 });
  const clicked = await page.evaluate(({ n, t }) => {
    const items = [...document.querySelectorAll('#filter-search-ac .ac-item')];
    const exact = items.find(el =>
      el.querySelector('.ac-type')?.textContent.trim() === t &&
      el.querySelector('.ac-name')?.textContent.trim().toLowerCase() === n.toLowerCase());
    const fallback = items.find(el => el.querySelector('.ac-type')?.textContent.trim() === t);
    const match = exact || fallback;
    if (match) { match.click(); return true; }
    return false;
  }, { n: name, t: type });
  if (!clicked) throw new Error(`no ${type} autocomplete match for "${name}"`);
  await page.waitForTimeout(800);
}

// Open the genre popover and click the first `.genre-pill` chip. Returns the genre name.
async function addGenreViaPopover(page) {
  await page.click('#pill-genre');
  await page.waitForSelector('#genre-popover.open', { timeout: 5000 });
  const chose = await page.evaluate(() => {
    const chip = document.querySelector('.genre-pill');
    if (!chip) return null;
    const name = chip.dataset.genre || chip.textContent.trim();
    chip.click();
    return name;
  });
  await page.waitForTimeout(300);
  await page.click('body', { position: { x: 5, y: 5 } });
  await page.waitForTimeout(800);
  return chose;
}

async function clearSearchBar(page) {
  const visible = await page.evaluate(() => {
    const btn = document.getElementById('filter-search-clear');
    if (btn && btn.style.display !== 'none') { btn.click(); return true; }
    return false;
  });
  if (visible) await page.waitForTimeout(400);
}

module.exports = {
  // config
  API_BASE, STATIC_BASE, APP_URL_SILENT, APP_URL_MUTED,
  DESKTOP_VIEWPORT, MOBILE_VIEWPORT, IGNORE_PATTERNS,
  // assertions / runner
  setTest, pass, fail, assertTrue, assertEq, runner,
  isAppError,
  // data / api
  normalize, apiFetch, digSupported,
  // playwright
  newPage, loadTracks, loadDig, clusterSnapshot,
  addViaSearchBar, addGenreViaPopover, clearSearchBar,
};
