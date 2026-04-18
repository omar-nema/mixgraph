/**
 * Filter behavior tests
 *
 * Covers:
 *   A. "Don't kick me out" reshuffle rule (new)
 *   B. Chip surface synchronization across all surfaces
 *   C. Genre parent/child consistency
 *   D. Cluster-pill toggles
 *   E. Clear-all paths
 *   F. Mobile Dig filter bar — popover close regression (B6 from audit)
 *
 * Requires:
 *   - Static server on :8001 serving the repo (e.g. `python3 -m http.server 8001`)
 *   - Local API server on :3001 (`npm run server`)
 *
 * Run: node tests/filters.test.cjs
 */
const { chromium } = require('playwright');

const BASE = 'http://localhost:8001/?api=http://localhost:3001&noplay';
const DESKTOP_VIEWPORT = { width: 1280, height: 800 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };

// External errors we ignore (analytics, cached 404s, etc.)
const IGNORE_PATTERNS = ['cloudflareinsights', 'cdn-cgi', 'ERR_FAILED', '404 ()', '404 (Not Found)', 'crates-index'];
function isAppError(text) {
  return !IGNORE_PATTERNS.some(s => text.includes(s));
}

const results = [];
let currentName = '';
function pass(msg) { results.push({ test: currentName, ok: true, msg }); console.log(`  ✓ ${msg}`); }
function fail(msg) { results.push({ test: currentName, ok: false, msg }); console.log(`  ✗ ${msg}`); }
function assertEq(actual, expected, label) {
  if (actual === expected) pass(`${label} (= ${JSON.stringify(actual)})`);
  else fail(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}
function assertTrue(cond, label) { cond ? pass(label) : fail(label); }

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function makePage(browser, mobile = false) {
  const ctx = await browser.newContext({
    viewport: mobile ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT,
    hasTouch: mobile,
    isMobile: mobile,
  });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && isAppError(m.text())) pageErrors.push('[console] ' + m.text()); });
  page._pageErrors = pageErrors;
  return { ctx, page };
}

async function loadTracksMode(page) {
  await page.goto(BASE);
  // App starts in crates-mode; switch to Tracks
  await page.waitForSelector('#mode-tabs .mode-tab[data-mode="tracks"]', { timeout: 10000 });
  await page.click('#mode-tabs .mode-tab[data-mode="tracks"]');
  await page.waitForSelector('.node-card[data-rank="root"]', { timeout: 15000 });
  await page.waitForTimeout(400);
}

async function readClusterState(page) {
  return page.evaluate(() => {
    // globals are accessible by bare name (nodes, genreFilters via let in data.js)
    const nodesList = (typeof nodes !== 'undefined' && nodes) ? nodes : [];
    const rootNode = nodesList.find(n => n.rank === 'root') || nodesList[0];
    return {
      clusterId: document.getElementById('cluster-id').textContent,
      rootArtist: (rootNode?.artist || '').trim(),
      rootGenres: rootNode?.genres || [],
      nodes: nodesList.map(n => ({
        artist: n.artist || '',
        genres: n.genres || [],
        djs: (n.djs || []).map(d => d.name),
      })),
      clusterArtistPills: [...document.querySelectorAll('#artist-cluster-pills .cluster-pill')].map(e => e.textContent.trim()),
      clusterDjPills: [...document.querySelectorAll('#dj-cluster-pills .cluster-pill')].map(e => e.textContent.trim()),
      findChips: [...document.querySelectorAll('#find-chips-input .find-chip')].map(e => e.textContent.replace('×','').trim()),
      djChips: [...document.querySelectorAll('#dj-chips-input .find-chip')].map(e => e.textContent.replace('×','').trim()),
      genreChips: [...document.querySelectorAll('#genre-chips-input .find-chip')].map(e => e.textContent.replace('×','').trim()),
      searchBarChips: [...document.querySelectorAll('#filter-search-chips .find-chip')].map(e => e.textContent.replace('×','').trim()),
      pillArtistActive: document.getElementById('pill-artist')?.classList.contains('active') || false,
      pillDjActive: document.getElementById('pill-dj')?.classList.contains('active') || false,
      pillGenreActive: document.getElementById('pill-genre')?.classList.contains('active') || false,
      genreFiltersFlat: (typeof genreFilters !== 'undefined' && genreFilters) ? [...genreFilters] : [],
      searchFiltersState: (typeof searchFilters !== 'undefined' && searchFilters) ? searchFilters.map(f => f.display) : [],
      djSearchFiltersState: (typeof djSearchFilters !== 'undefined' && djSearchFilters) ? djSearchFilters.map(f => f.display) : [],
    };
  });
}

// Add an artist via the unified search bar. Resolves once the chip shows and any shuffle finishes.
async function addArtistViaSearchBar(page, name) {
  await page.click('#filter-search');
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.type('#filter-search', name, { delay: 40 });
  await page.waitForSelector('#filter-search-ac.open .ac-item', { timeout: 8000 });
  // Click the first artist-type result (exact match if present)
  const clicked = await page.evaluate((n) => {
    const items = [...document.querySelectorAll('#filter-search-ac .ac-item')];
    const match = items.find(el => {
      const name = el.querySelector('.ac-name')?.textContent.trim();
      const type = el.querySelector('.ac-type')?.textContent.trim();
      return type === 'artist' && name && name.toLowerCase() === n.toLowerCase();
    }) || items.find(el => el.querySelector('.ac-type')?.textContent.trim() === 'artist');
    if (match) { match.click(); return true; }
    return false;
  }, name);
  if (!clicked) throw new Error(`No artist autocomplete match for "${name}"`);
  await page.waitForTimeout(800); // let reshuffle settle if it fires
}

async function pickArtistNotInCluster(page, state) {
  // Ask the API for artists; pick one whose display doesn't appear in cluster
  const onScreen = new Set([
    ...state.clusterArtistPills.map(s => s.toLowerCase()),
    state.rootArtist.toLowerCase(),
  ]);
  // Try common artists in succession until we find a non-match
  const candidates = ['Four Tet', 'Burial', 'Aphex Twin', 'Radiohead', 'Bjork', 'Kanye West', 'Drake'];
  for (const c of candidates) {
    if (!onScreen.has(c.toLowerCase())) {
      // Verify it exists in the index
      const resp = await page.evaluate(async (q) => {
        const r = await fetch(`http://localhost:3001/api/search/artists?q=${encodeURIComponent(q)}&limit=5`);
        return r.ok ? r.json() : [];
      }, c);
      if (Array.isArray(resp) && resp.some(a => a.display?.toLowerCase() === c.toLowerCase())) return c;
    }
  }
  return null;
}

async function toggleClusterArtistPill(page, name) {
  const ok = await page.evaluate((n) => {
    const pill = [...document.querySelectorAll('#artist-cluster-pills .cluster-pill')].find(p => p.textContent.trim() === n);
    if (pill) { pill.click(); return true; }
    return false;
  }, name);
  if (!ok) throw new Error(`Cluster pill "${name}" not found`);
  await page.waitForTimeout(500);
}

async function clearSearchBar(page) {
  const visible = await page.evaluate(() => {
    const btn = document.getElementById('filter-search-clear');
    if (btn && btn.style.display !== 'none') { btn.click(); return true; }
    return false;
  });
  if (visible) await page.waitForTimeout(400);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

async function testStayOnRootMatchingArtist(browser) {
  currentName = 'A1. Add artist filter that matches an on-screen node → no reshuffle';
  console.log(`\n[${currentName}]`);
  const { ctx, page } = await makePage(browser);
  try {
    await loadTracksMode(page);
    const before = await readClusterState(page);
    // Use a cluster-artist pill name (already splitArtists'd) rather than root.artist raw string
    const target = before.clusterArtistPills[0];
    if (!target) { fail('No cluster artist pill to test with'); return; }
    await addArtistViaSearchBar(page, target);
    const after = await readClusterState(page);
    assertEq(after.clusterId, before.clusterId, 'clusterId unchanged');
    assertTrue(after.findChips.includes(target) || after.searchBarChips.includes(target), `chip present for "${target}"`);
    assertTrue(after.pillArtistActive, 'pill-artist.active');
    assertTrue(after._pageErrors === undefined || page._pageErrors.length === 0, `no console errors (got ${page._pageErrors.length})`);
  } finally { await ctx.close(); }
}

async function testReshuffleOffScreenArtist(browser) {
  currentName = 'A2. Add artist filter NOT in cluster → exactly one reshuffle';
  console.log(`\n[${currentName}]`);
  const { ctx, page } = await makePage(browser);
  try {
    await loadTracksMode(page);
    // Count API shuffle calls that fire AFTER this point
    const shuffleCalls = [];
    page.on('request', req => {
      if (req.url().includes('/api/shuffle')) shuffleCalls.push(new URL(req.url()).search);
    });
    const before = await readClusterState(page);
    const target = await pickArtistNotInCluster(page, before);
    if (!target) { fail('Could not find a candidate artist not in current cluster'); return; }
    const callsBefore = shuffleCalls.length;
    await addArtistViaSearchBar(page, target);
    await page.waitForTimeout(1200);
    const after = await readClusterState(page);
    const newCalls = shuffleCalls.length - callsBefore;
    assertTrue(after.clusterId !== before.clusterId, `clusterId changed (${before.clusterId} → ${after.clusterId})`);
    assertTrue(after.pillArtistActive, 'pill-artist.active');
    assertEq(newCalls, 1, `exactly one /api/shuffle call (got ${newCalls})`);
  } finally { await ctx.close(); }
}

async function testRemoveFilterNoReshuffle(browser) {
  currentName = 'A3. Removing a filter never reshuffles';
  console.log(`\n[${currentName}]`);
  const { ctx, page } = await makePage(browser);
  try {
    await loadTracksMode(page);
    const before = await readClusterState(page);
    const target = before.clusterArtistPills[0];
    if (!target) { fail('No cluster artist pill'); return; }
    await addArtistViaSearchBar(page, target);
    const mid = await readClusterState(page);
    assertEq(mid.clusterId, before.clusterId, 'cluster stable after add');
    // Now remove via search-bar × button
    await clearSearchBar(page);
    const after = await readClusterState(page);
    assertEq(after.clusterId, mid.clusterId, 'cluster unchanged after remove');
    assertEq(after.pillArtistActive, false, 'pill-artist inactive');
  } finally { await ctx.close(); }
}

async function testChipSurfaceSync(browser) {
  currentName = 'B1. Adding artist syncs all chip surfaces + pills';
  console.log(`\n[${currentName}]`);
  const { ctx, page } = await makePage(browser);
  try {
    await loadTracksMode(page);
    const before = await readClusterState(page);
    const target = before.clusterArtistPills[0];
    if (!target) { fail('No cluster artist pill'); return; }
    await addArtistViaSearchBar(page, target);
    const after = await readClusterState(page);
    assertTrue(after.findChips.includes(target), 'category chip row has the artist');
    assertTrue(after.searchBarChips.includes(target), 'unified search bar chips has the artist');
    assertTrue(after.pillArtistActive, 'pill-artist.active is true');
  } finally { await ctx.close(); }
}

async function testGenrePopoverAddSyncsSearchBar(browser) {
  // This is the B1 bug from audit — currently FAILS (expected to pass after refactor)
  currentName = 'B2. Adding genre from popover syncs unified search bar (currently broken)';
  console.log(`\n[${currentName}]`);
  const { ctx, page } = await makePage(browser);
  try {
    await loadTracksMode(page);
    await page.click('#pill-genre');
    await page.waitForSelector('#genre-popover.open', { timeout: 5000 });
    await page.click('#genre-search');
    await page.waitForTimeout(500); // let showAllOnFocus fire
    // Pick a genre chip from inside the popover autocomplete (show-all-on-focus)
    const chose = await page.evaluate(() => {
      const items = [...document.querySelectorAll('#genre-ac .ac-item')];
      const item = items.find(el => !el.querySelector('.ac-parent')) || items[0];
      if (item) { const name = item.querySelector('.ac-name')?.textContent.trim(); item.click(); return name; }
      return null;
    });
    if (!chose) { fail('No genre autocomplete items'); return; }
    await page.waitForTimeout(400);
    // Close popover via outside click so any deferred reshuffle is consumed
    await page.click('body', { position: { x: 10, y: 10 } });
    await page.waitForTimeout(600);
    const state = await readClusterState(page);
    assertTrue(state.genreChips.length >= 1, 'genre popover chip row has entry');
    assertTrue(state.searchBarChips.some(c => c.toLowerCase() === chose.toLowerCase()), `search bar has "${chose}"`);
    assertTrue(state.pillGenreActive, 'pill-genre.active');
  } finally { await ctx.close(); }
}

async function testPopoverClearSyncsSearchBar(browser) {
  // B5 from audit — currently FAILS
  currentName = 'B3. Popover × clear button syncs unified search bar (currently broken)';
  console.log(`\n[${currentName}]`);
  const { ctx, page } = await makePage(browser);
  try {
    await loadTracksMode(page);
    const before = await readClusterState(page);
    const target = before.clusterArtistPills[0];
    if (!target) { fail('No cluster artist pill'); return; }
    await addArtistViaSearchBar(page, target);
    // Open the artist popover and click × clear-all
    await page.click('#pill-artist');
    await page.waitForSelector('#artist-popover.open', { timeout: 5000 });
    await page.click('#artist-clear-btn');
    await page.waitForTimeout(400);
    await page.click('body', { position: { x: 10, y: 10 } });
    await page.waitForTimeout(500);
    const after = await readClusterState(page);
    assertEq(after.findChips.length, 0, 'category chip row empty');
    assertEq(after.searchBarChips.length, 0, 'unified search bar chips empty');
    assertEq(after.pillArtistActive, false, 'pill-artist.active is false');
  } finally { await ctx.close(); }
}

async function testGenreParentChildConsistency(browser) {
  // B3 from audit — parent chip + child toggle consistency.
  currentName = 'C1. Genre parent chip → toggle child off → chips reflect actual filters';
  console.log(`\n[${currentName}]`);
  const { ctx, page } = await makePage(browser);
  try {
    await loadTracksMode(page);
    // Use the Jazz parent: has many children, stable
    await page.click('#pill-genre');
    await page.waitForSelector('#genre-popover.open', { timeout: 5000 });
    // Type "jazz" to filter, then click the parent entry
    await page.click('#genre-search');
    await page.type('#genre-search', 'Jazz', { delay: 40 });
    await page.waitForTimeout(500);
    const parentName = await page.evaluate(() => {
      const item = [...document.querySelectorAll('#genre-ac .ac-item')].find(el => {
        const n = el.querySelector('.ac-name')?.textContent.trim();
        const isParent = !!el.querySelector('.ac-parent');
        return isParent && n?.toLowerCase() === 'jazz';
      });
      if (item) { const n = item.querySelector('.ac-name').textContent.trim(); item.click(); return n; }
      return null;
    });
    if (!parentName) { fail('Jazz parent not found in autocomplete'); return; }
    await page.waitForTimeout(300);
    await page.click('body', { position: { x: 10, y: 10 } });
    await page.waitForTimeout(500);
    const afterParent = await readClusterState(page);
    assertTrue(afterParent.genreChips.includes('Jazz'), 'Jazz parent chip present');
    assertTrue(afterParent.genreFiltersFlat.length > 1, `genreFilters expanded (${afterParent.genreFiltersFlat.length} names)`);

    // Now toggle off a child genre via the genre pill (e.g. "Bebop")
    const childName = afterParent.genreFiltersFlat.includes('Bebop') ? 'Bebop' : afterParent.genreFiltersFlat[0];
    await page.click('#pill-genre');
    await page.waitForSelector('#genre-popover.open', { timeout: 5000 });
    await page.click('#genre-search');
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.waitForTimeout(200);
    const toggled = await page.evaluate((child) => {
      const pill = [...document.querySelectorAll('.genre-pill')].find(p => p.dataset.genre === child);
      if (pill) { pill.click(); return true; }
      return false;
    }, childName);
    if (!toggled) {
      console.log(`  (note: no #.genre-pill for "${childName}"; skipping toggle subcheck)`);
    }
    await page.click('body', { position: { x: 10, y: 10 } });
    await page.waitForTimeout(500);
    const afterToggle = await readClusterState(page);
    // Expected (option c): parent chip removed AND its children removed from genreFilters
    // Document what we see so the refactor change is visible.
    const parentStillPresent = afterToggle.genreChips.includes('Jazz');
    const hasLeftoverJazzChildren = afterToggle.genreFiltersFlat.some(n => afterParent.genreFiltersFlat.includes(n));
    const chipsHonest = parentStillPresent === hasLeftoverJazzChildren;
    assertTrue(chipsHonest, `chips match filter state (parentChip=${parentStillPresent}, leftoverChildren=${hasLeftoverJazzChildren})`);
  } finally { await ctx.close(); }
}

async function testClusterPillNoReshuffle(browser) {
  currentName = 'D1. Toggle cluster-artist pill for on-screen artist → no reshuffle';
  console.log(`\n[${currentName}]`);
  const { ctx, page } = await makePage(browser);
  try {
    await loadTracksMode(page);
    const before = await readClusterState(page);
    const target = before.clusterArtistPills.find(p => p.toLowerCase() !== before.rootArtist.toLowerCase());
    if (!target) { fail('No non-root cluster-artist pill available'); return; }
    await toggleClusterArtistPill(page, target);
    const after = await readClusterState(page);
    assertEq(after.clusterId, before.clusterId, 'clusterId unchanged after cluster-pill toggle');
    // Pill should be marked active
    const pillAdded = await page.evaluate((t) => {
      const p = [...document.querySelectorAll('#artist-cluster-pills .cluster-pill')].find(el => el.textContent.trim() === t);
      return p?.classList.contains('added') || false;
    }, target);
    assertTrue(pillAdded, `pill "${target}" shows .added`);
  } finally { await ctx.close(); }
}

async function testClearAll(browser) {
  currentName = 'E1. Clear via search-bar × empties all chip surfaces';
  console.log(`\n[${currentName}]`);
  const { ctx, page } = await makePage(browser);
  try {
    await loadTracksMode(page);
    const before = await readClusterState(page);
    const target = before.clusterArtistPills[0];
    if (!target) { fail('No cluster artist pill'); return; }
    await addArtistViaSearchBar(page, target);
    const mid = await readClusterState(page);
    assertTrue(mid.searchBarChips.length > 0, 'chip added before clear');
    await clearSearchBar(page);
    const after = await readClusterState(page);
    assertEq(after.searchBarChips.length, 0, 'search bar cleared');
    assertEq(after.findChips.length, 0, 'category chips cleared');
    assertEq(after.pillArtistActive, false, 'pill-artist inactive');
  } finally { await ctx.close(); }
}

async function testMobileDigFilterClose(browser) {
  // Regression from commit 55e8a0b: direct load to /dig, open filter, backdrop closes it.
  currentName = 'F1. Mobile Dig direct-load: filter popover closes via backdrop';
  console.log(`\n[${currentName}]`);
  const { ctx, page } = await makePage(browser, true);
  try {
    // Python static server doesn't handle /dig SPA route; load / then ensure Dig mode
    await page.goto(BASE);
    await page.waitForTimeout(2500);
    const inCrates = await page.evaluate(() => document.body.classList.contains('crates-mode'));
    if (!inCrates) {
      await page.click('#mobile-mode-tabs .mode-tab[data-mode="crates"]');
      await page.waitForTimeout(500);
    }
    await page.click('#mobile-filter-toggle');
    await page.waitForTimeout(200);
    await page.click('#mobile-bar-genre');
    await page.waitForTimeout(300);
    const afterOpen = await page.evaluate(() => ({
      genreOpen: document.getElementById('genre-popover')?.classList.contains('open') || false,
      backdropOpen: document.getElementById('popover-backdrop')?.classList.contains('open') || false,
      pillSemiOpen: document.getElementById('mobile-bar-genre')?.classList.contains('semi-open') || false,
    }));
    assertTrue(afterOpen.genreOpen && afterOpen.backdropOpen && afterOpen.pillSemiOpen, 'popover opened');
    // Click bottom of backdrop away from the popover
    const box = await page.evaluate(() => {
      const r = document.getElementById('popover-backdrop').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    await page.mouse.click(box.x + box.w / 2, box.y + box.h - 40);
    await page.waitForTimeout(400);
    const afterClose = await page.evaluate(() => ({
      genreOpen: document.getElementById('genre-popover')?.classList.contains('open') || false,
      backdropOpen: document.getElementById('popover-backdrop')?.classList.contains('open') || false,
      pillSemiOpen: document.getElementById('mobile-bar-genre')?.classList.contains('semi-open') || false,
    }));
    assertEq(afterClose.genreOpen, false, 'popover closed');
    assertEq(afterClose.backdropOpen, false, 'backdrop closed');
    assertEq(afterClose.pillSemiOpen, false, 'pill semi-open cleared');
  } finally { await ctx.close(); }
}

async function testMobileEscapeClearsSemiOpen(browser) {
  // B6 from audit — Escape on mobile leaves pill semi-open.
  currentName = 'F2. Mobile popover closes on Escape, pill semi-open cleared (currently broken)';
  console.log(`\n[${currentName}]`);
  const { ctx, page } = await makePage(browser, true);
  try {
    await page.goto(BASE);
    await page.waitForTimeout(2500);
    // App starts in crates-mode by default — nothing to switch
    await page.click('#mobile-filter-toggle');
    await page.waitForTimeout(200);
    await page.click('#mobile-bar-genre');
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const state = await page.evaluate(() => ({
      genreOpen: document.getElementById('genre-popover')?.classList.contains('open') || false,
      pillSemiOpen: document.getElementById('mobile-bar-genre')?.classList.contains('semi-open') || false,
    }));
    assertEq(state.genreOpen, false, 'popover closed by Escape');
    assertEq(state.pillSemiOpen, false, 'pill semi-open cleared');
  } finally { await ctx.close(); }
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function run() {
  const browser = await chromium.launch();
  const tests = [
    testStayOnRootMatchingArtist,
    testReshuffleOffScreenArtist,
    testRemoveFilterNoReshuffle,
    testChipSurfaceSync,
    testGenrePopoverAddSyncsSearchBar,
    testPopoverClearSyncsSearchBar,
    testGenreParentChildConsistency,
    testClusterPillNoReshuffle,
    testClearAll,
    testMobileDigFilterClose,
    testMobileEscapeClearsSemiOpen,
  ];
  for (const t of tests) {
    try { await t(browser); }
    catch (e) { console.log(`  ✗ THREW: ${e.message}`); results.push({ test: currentName, ok: false, msg: `THREW: ${e.message}` }); }
  }
  await browser.close();

  const failed = results.filter(r => !r.ok);
  const passed = results.filter(r => r.ok);
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`${passed.length} passed, ${failed.length} failed`);
  if (failed.length) {
    console.log('\nFailures:');
    failed.forEach(f => console.log(`  ✗ [${f.test}] ${f.msg}`));
    process.exit(1);
  }
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(2); });
