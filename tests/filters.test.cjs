/**
 * Filter behavior tests — chip surfaces, reshuffle rules, popover/mobile.
 *
 * Covers:
 *   A. "Don't kick me out" reshuffle rule
 *   B. Chip surface synchronization across all surfaces
 *   C. Genre parent/child consistency
 *   D. Cluster-pill toggles
 *   E. Clear-all paths
 *   F. Mobile Dig filter popover (backdrop close + Escape)
 *
 * Distinct from ui-flows.test.cjs: this file tests chip/popover mechanics
 * (surface sync, no-reshuffle semantics). ui-flows tests "does filter produce
 * matching cluster contents". data-integrity tests API-level filter semantics.
 *
 * Requires static server on :8001 and API on :3001.
 * Run: node tests/filters.test.cjs
 */
const { chromium } = require('playwright');
const H = require('./_helpers.cjs');
const {
  setTest, pass, fail, assertTrue, assertEq, runner,
  APP_URL_SILENT, API_BASE,
  newPage, loadTracks, clusterSnapshot, addViaSearchBar, clearSearchBar,
} = H;

// ── Test-specific helpers ────────────────────────────────────────────────────
async function pickArtistNotInCluster(page, state) {
  const onScreen = new Set([
    ...state.clusterArtistPills.map(s => s.toLowerCase()),
    state.rootArtist.toLowerCase(),
  ]);
  const candidates = ['Four Tet', 'Burial', 'Aphex Twin', 'Radiohead', 'Bjork', 'Kanye West', 'Drake'];
  for (const c of candidates) {
    if (onScreen.has(c.toLowerCase())) continue;
    const resp = await page.evaluate(async ({ api, q }) => {
      const r = await fetch(`${api}/api/search/artists?q=${encodeURIComponent(q)}&limit=5`);
      return r.ok ? r.json() : [];
    }, { api: API_BASE, q: c });
    if (Array.isArray(resp) && resp.some(a => a.display?.toLowerCase() === c.toLowerCase())) return c;
  }
  return null;
}

async function toggleClusterArtistPill(page, name) {
  const ok = await page.evaluate((n) => {
    const pill = [...document.querySelectorAll('#artist-cluster-pills .cluster-pill')].find(p => p.textContent.trim() === n);
    if (pill) { pill.click(); return true; }
    return false;
  }, name);
  if (!ok) throw new Error(`cluster pill "${name}" not found`);
  await page.waitForTimeout(500);
}

// ── A. Reshuffle rule ────────────────────────────────────────────────────────
async function testStayOnRootMatchingArtist(browser) {
  setTest('A1. Add artist filter matching on-screen node → no reshuffle');
  const { ctx, page } = await newPage(browser);
  try {
    await loadTracks(page);
    const before = await clusterSnapshot(page);
    const target = before.clusterArtistPills[0];
    if (!target) return fail('no cluster artist pill');
    await addViaSearchBar(page, target, 'artist');
    const after = await clusterSnapshot(page);
    assertEq(after.clusterId, before.clusterId, 'clusterId unchanged');
    assertTrue(after.findChips.includes(target) || after.searchBarChips.includes(target), `chip for "${target}"`);
    assertTrue(after.pillArtistActive, 'pill-artist.active');
    assertEq(page._errors.length, 0, `no console errors (got ${page._errors.length})`);
  } finally { await ctx.close(); }
}

async function testReshuffleOffScreenArtist(browser) {
  setTest('A2. Add artist filter NOT in cluster → exactly one reshuffle');
  const { ctx, page } = await newPage(browser);
  try {
    await loadTracks(page);
    const shuffleCalls = [];
    page.on('request', req => {
      if (req.url().includes('/api/shuffle')) shuffleCalls.push(new URL(req.url()).search);
    });
    const before = await clusterSnapshot(page);
    const target = await pickArtistNotInCluster(page, before);
    if (!target) return fail('no candidate artist not in cluster');
    const baseCalls = shuffleCalls.length;
    await addViaSearchBar(page, target, 'artist');
    await page.waitForTimeout(1200);
    const after = await clusterSnapshot(page);
    const newCalls = shuffleCalls.length - baseCalls;
    assertTrue(after.clusterId !== before.clusterId, `clusterId changed (${before.clusterId} → ${after.clusterId})`);
    assertTrue(after.pillArtistActive, 'pill-artist.active');
    assertEq(newCalls, 1, `exactly one /api/shuffle call`);
  } finally { await ctx.close(); }
}

async function testRemoveFilterNoReshuffle(browser) {
  setTest('A3. Removing a filter never reshuffles');
  const { ctx, page } = await newPage(browser);
  try {
    await loadTracks(page);
    const before = await clusterSnapshot(page);
    const target = before.clusterArtistPills[0];
    if (!target) return fail('no cluster artist pill');
    await addViaSearchBar(page, target, 'artist');
    const mid = await clusterSnapshot(page);
    assertEq(mid.clusterId, before.clusterId, 'cluster stable after add');
    await clearSearchBar(page);
    const after = await clusterSnapshot(page);
    assertEq(after.clusterId, mid.clusterId, 'cluster unchanged after remove');
    assertEq(after.pillArtistActive, false, 'pill-artist inactive');
  } finally { await ctx.close(); }
}

// ── B. Chip surface sync ─────────────────────────────────────────────────────
async function testChipSurfaceSync(browser) {
  setTest('B1. Adding artist syncs all chip surfaces + pills');
  const { ctx, page } = await newPage(browser);
  try {
    await loadTracks(page);
    const before = await clusterSnapshot(page);
    const target = before.clusterArtistPills[0];
    if (!target) return fail('no cluster artist pill');
    await addViaSearchBar(page, target, 'artist');
    const after = await clusterSnapshot(page);
    assertTrue(after.findChips.includes(target), 'category chip row has the artist');
    assertTrue(after.searchBarChips.includes(target), 'unified search bar chips has the artist');
    assertTrue(after.pillArtistActive, 'pill-artist.active is true');
  } finally { await ctx.close(); }
}

async function testGenrePopoverAddDoesNotMirrorSearchBar(browser) {
  setTest('B2. Adding genre from popover shows in tray, NOT the search bar');
  const { ctx, page } = await newPage(browser);
  try {
    await loadTracks(page);
    await page.click('#pill-genre');
    await page.waitForSelector('#genre-popover.open', { timeout: 5000 });
    await page.click('#genre-search');
    await page.waitForTimeout(500);
    const chose = await page.evaluate(() => {
      const items = [...document.querySelectorAll('#genre-ac .ac-item')];
      const item = items.find(el => !el.querySelector('.ac-parent')) || items[0];
      if (!item) return null;
      const name = item.querySelector('.ac-name')?.textContent.trim();
      item.click();
      return name;
    });
    if (!chose) return fail('no genre autocomplete items');
    await page.waitForTimeout(400);
    await page.click('body', { position: { x: 10, y: 10 } });
    await page.waitForTimeout(600);
    const s = await clusterSnapshot(page);
    // New behavior: popover selections live in the popover tray only — they must
    // NOT mirror into the unified search bar.
    assertTrue(s.genreChips.some(c => c.toLowerCase() === chose.toLowerCase()), `genre tray has "${chose}"`);
    assertEq(s.searchBarChips.length, 0, 'search bar stays empty for popover-added genre');
    assertTrue(s.pillGenreActive, 'pill-genre.active');
  } finally { await ctx.close(); }
}

async function testSearchBarGenreMirrorsToTray(browser) {
  setTest('B2b. Selecting a genre from the search bar shows in BOTH search bar and genre tray');
  const { ctx, page } = await newPage(browser);
  try {
    await loadTracks(page);
    // Add a genre via the unified search bar
    await page.click('#filter-search');
    await page.type('#filter-search', 'house', { delay: 35 });
    await page.waitForSelector('#filter-search-ac.open .ac-item', { timeout: 8000 });
    const chose = await page.evaluate(() => {
      const items = [...document.querySelectorAll('#filter-search-ac .ac-item')];
      const item = items.find(el => el.querySelector('.ac-type')?.textContent.trim() === 'genre');
      if (!item) return null;
      const name = item.querySelector('.ac-name')?.textContent.trim();
      item.click();
      return name;
    });
    if (!chose) return fail('no genre in search-bar autocomplete');
    await page.waitForTimeout(600);
    const s = await clusterSnapshot(page);
    assertTrue(s.searchBarChips.some(c => c.toLowerCase() === chose.toLowerCase()), `search bar has "${chose}"`);
    assertTrue(s.genreChips.some(c => c.toLowerCase() === chose.toLowerCase()), `genre tray mirrors "${chose}"`);
    assertTrue(s.pillGenreActive, 'pill-genre.active');
  } finally { await ctx.close(); }
}

async function testPopoverClearSyncsSearchBar(browser) {
  setTest('B3. Popover × clear button syncs unified search bar');
  const { ctx, page } = await newPage(browser);
  try {
    await loadTracks(page);
    const before = await clusterSnapshot(page);
    const target = before.clusterArtistPills[0];
    if (!target) return fail('no cluster artist pill');
    await addViaSearchBar(page, target, 'artist');
    await page.click('#pill-artist');
    await page.waitForSelector('#artist-popover.open', { timeout: 5000 });
    await page.click('#artist-clear-btn');
    await page.waitForTimeout(400);
    await page.click('body', { position: { x: 10, y: 10 } });
    await page.waitForTimeout(500);
    const after = await clusterSnapshot(page);
    assertEq(after.findChips.length, 0, 'category chip row empty');
    assertEq(after.searchBarChips.length, 0, 'unified search bar chips empty');
    assertEq(after.pillArtistActive, false, 'pill-artist.active is false');
  } finally { await ctx.close(); }
}

// ── C. Genre parent/child ────────────────────────────────────────────────────
async function testGenreParentChildConsistency(browser) {
  setTest('C1. Genre parent chip → toggle child off → chips reflect actual filters');
  const { ctx, page } = await newPage(browser);
  try {
    await loadTracks(page);
    await page.click('#pill-genre');
    await page.waitForSelector('#genre-popover.open', { timeout: 5000 });
    await page.click('#genre-search');
    await page.type('#genre-search', 'Jazz', { delay: 40 });
    await page.waitForTimeout(500);
    const parentName = await page.evaluate(() => {
      const item = [...document.querySelectorAll('#genre-ac .ac-item')].find(el => {
        const n = el.querySelector('.ac-name')?.textContent.trim();
        return !!el.querySelector('.ac-parent') && n?.toLowerCase() === 'jazz';
      });
      if (!item) return null;
      const n = item.querySelector('.ac-name').textContent.trim();
      item.click();
      return n;
    });
    if (!parentName) return fail('Jazz parent not found in autocomplete');
    await page.waitForTimeout(300);
    await page.click('body', { position: { x: 10, y: 10 } });
    await page.waitForTimeout(500);

    const afterParent = await clusterSnapshot(page);
    assertTrue(afterParent.genreChips.includes('Jazz'), 'Jazz parent chip present');
    assertTrue(afterParent.genreFiltersFlat.length > 1, `genreFilters expanded (${afterParent.genreFiltersFlat.length})`);

    const childName = afterParent.genreFiltersFlat.includes('Bebop') ? 'Bebop' : afterParent.genreFiltersFlat[0];
    await page.click('#pill-genre');
    await page.waitForSelector('#genre-popover.open', { timeout: 5000 });
    await page.click('#genre-search');
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.waitForTimeout(200);
    const toggled = await page.evaluate((child) => {
      const pill = [...document.querySelectorAll('.genre-pill')].find(p => p.dataset.genre === child);
      if (!pill) return false;
      pill.click();
      return true;
    }, childName);
    if (!toggled) console.log(`  (note: no .genre-pill for "${childName}"; skipping toggle subcheck)`);
    await page.click('body', { position: { x: 10, y: 10 } });
    await page.waitForTimeout(500);

    const afterToggle = await clusterSnapshot(page);
    const parentStillPresent = afterToggle.genreChips.includes('Jazz');
    const hasLeftoverJazzChildren = afterToggle.genreFiltersFlat.some(n => afterParent.genreFiltersFlat.includes(n));
    assertTrue(parentStillPresent === hasLeftoverJazzChildren,
               `chips match filter state (parentChip=${parentStillPresent}, leftoverChildren=${hasLeftoverJazzChildren})`);
  } finally { await ctx.close(); }
}

// ── D. Cluster-pill toggles ──────────────────────────────────────────────────
async function testClusterPillNoReshuffle(browser) {
  setTest('D1. Toggle cluster-artist pill for on-screen artist → no reshuffle');
  const { ctx, page } = await newPage(browser);
  try {
    await loadTracks(page);
    const before = await clusterSnapshot(page);
    const target = before.clusterArtistPills.find(p => p.toLowerCase() !== before.rootArtist.toLowerCase());
    if (!target) return fail('no non-root cluster-artist pill available');
    await toggleClusterArtistPill(page, target);
    const after = await clusterSnapshot(page);
    assertEq(after.clusterId, before.clusterId, 'clusterId unchanged');
    assertTrue(await page.evaluate((t) => {
      const p = [...document.querySelectorAll('#artist-cluster-pills .cluster-pill')].find(el => el.textContent.trim() === t);
      return p?.classList.contains('added') || false;
    }, target), `pill "${target}" shows .added`);
  } finally { await ctx.close(); }
}

// ── E. Clear-all ─────────────────────────────────────────────────────────────
async function testClearAll(browser) {
  setTest('E1. Clear via search-bar × empties all chip surfaces');
  const { ctx, page } = await newPage(browser);
  try {
    await loadTracks(page);
    const before = await clusterSnapshot(page);
    const target = before.clusterArtistPills[0];
    if (!target) return fail('no cluster artist pill');
    await addViaSearchBar(page, target, 'artist');
    assertTrue((await clusterSnapshot(page)).searchBarChips.length > 0, 'chip added before clear');
    await clearSearchBar(page);
    const after = await clusterSnapshot(page);
    assertEq(after.searchBarChips.length, 0, 'search bar cleared');
    assertEq(after.findChips.length, 0, 'category chips cleared');
    assertEq(after.pillArtistActive, false, 'pill-artist inactive');
  } finally { await ctx.close(); }
}

// ── F. Mobile Dig popover ────────────────────────────────────────────────────
async function testMobileDigFilterClose(browser) {
  setTest('F1. Mobile Dig: filter popover closes via backdrop');
  const { ctx, page } = await newPage(browser, { mobile: true });
  try {
    await page.goto(APP_URL_SILENT);
    await page.waitForTimeout(2500);
    if (!(await page.evaluate(() => document.body.classList.contains('crates-mode')))) {
      await page.click('#mobile-mode-tabs .mode-tab[data-mode="crates"]');
      await page.waitForTimeout(500);
    }
    await page.click('#mobile-filter-toggle');
    await page.waitForTimeout(200);
    await page.click('#mobile-bar-genre');
    await page.waitForTimeout(300);
    const open = await page.evaluate(() => ({
      genre: document.getElementById('genre-popover')?.classList.contains('open') || false,
      backdrop: document.getElementById('popover-backdrop')?.classList.contains('open') || false,
      semi: document.getElementById('mobile-bar-genre')?.classList.contains('semi-open') || false,
    }));
    assertTrue(open.genre && open.backdrop && open.semi, 'popover opened');
    const box = await page.evaluate(() => {
      const r = document.getElementById('popover-backdrop').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    await page.mouse.click(box.x + box.w / 2, box.y + box.h - 40);
    await page.waitForTimeout(400);
    const closed = await page.evaluate(() => ({
      genre: document.getElementById('genre-popover')?.classList.contains('open') || false,
      backdrop: document.getElementById('popover-backdrop')?.classList.contains('open') || false,
      semi: document.getElementById('mobile-bar-genre')?.classList.contains('semi-open') || false,
    }));
    assertEq(closed.genre, false, 'popover closed');
    assertEq(closed.backdrop, false, 'backdrop closed');
    assertEq(closed.semi, false, 'pill semi-open cleared');
  } finally { await ctx.close(); }
}

async function testMobileEscapeClearsSemiOpen(browser) {
  setTest('F2. Mobile popover closes on Escape, pill semi-open cleared');
  const { ctx, page } = await newPage(browser, { mobile: true });
  try {
    await page.goto(APP_URL_SILENT);
    await page.waitForTimeout(2500);
    await page.click('#mobile-filter-toggle');
    await page.waitForTimeout(200);
    await page.click('#mobile-bar-genre');
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const s = await page.evaluate(() => ({
      genre: document.getElementById('genre-popover')?.classList.contains('open') || false,
      semi: document.getElementById('mobile-bar-genre')?.classList.contains('semi-open') || false,
    }));
    assertEq(s.genre, false, 'popover closed by Escape');
    assertEq(s.semi, false, 'pill semi-open cleared');
  } finally { await ctx.close(); }
}

// ── Runner ───────────────────────────────────────────────────────────────────
(async () => {
  const browser = await chromium.launch();
  let code;
  try {
    code = await runner([
      testStayOnRootMatchingArtist,
      testReshuffleOffScreenArtist,
      testRemoveFilterNoReshuffle,
      testChipSurfaceSync,
      testGenrePopoverAddDoesNotMirrorSearchBar,
      testSearchBarGenreMirrorsToTray,
      testPopoverClearSyncsSearchBar,
      testGenreParentChildConsistency,
      testClusterPillNoReshuffle,
      testClearAll,
      testMobileDigFilterClose,
      testMobileEscapeClearsSemiOpen,
    ], { browser });
  } finally {
    await browser.close();
  }
  process.exit(code);
})().catch(e => { console.error(e); process.exit(2); });
