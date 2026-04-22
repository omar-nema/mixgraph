/**
 * UI flow tests — Playwright.
 *
 * Covers:
 *   S1–S3. Shuffle mode navigation + deep-link
 *   P1.    Playback across multiple tracks (root, r1[0], r1[1])
 *   F1–F3. Artist / DJ / genre filters narrow rendered cluster
 *   D1–D3. Dig (crates) mode: render, tile-click, filter
 *
 * Note: Source filter is validated in data-integrity.test.cjs (C1) — it's a pure
 * API concern. We don't re-test it here.
 *
 * Playback test launches Chromium with --mute-audio so the SC widget exercises
 * real load()/PLAY events silently.
 *
 * Requires static server on :8001 and API on :3001.
 * Run: node tests/ui-flows.test.cjs
 */
const { chromium } = require('playwright');
const H = require('./_helpers.cjs');
const {
  setTest, pass, fail, assertTrue, assertEq, runner,
  APP_URL_SILENT, APP_URL_MUTED, normalize, digSupported, isAppError,
  newPage, loadTracks, loadDig, clusterSnapshot,
  addViaSearchBar, addGenreViaPopover,
} = H;

// ── S: Shuffle navigation ────────────────────────────────────────────────────
async function testShuffleDifferentRoots(browser) {
  setTest('S1. Shuffle button produces distinct roots across 3 clicks');
  const { ctx, page } = await newPage(browser);
  try {
    await loadTracks(page);
    const first = await clusterSnapshot(page);
    const seen = new Set([first.rootGraphId]);
    for (let i = 0; i < 3; i++) {
      await page.click('#filter-shuffle-btn');
      await page.waitForTimeout(900);
      seen.add((await clusterSnapshot(page)).rootGraphId);
    }
    assertTrue(seen.size >= 3, `distinct roots: ${seen.size}/4`);
    assertEq(page._errors.filter(isAppError).length, 0, 'no console/page errors');
  } finally { await ctx.close(); }
}

async function testShuffleClusterShape(browser) {
  setTest('S2. Cluster renders: root + r1 + .connection-path edges');
  const { ctx, page } = await newPage(browser);
  try {
    await loadTracks(page);
    const s = await page.evaluate(() => ({
      hasRoot: !!document.querySelector('.node-card[data-rank="root"]'),
      r1Count: document.querySelectorAll('.node-card[data-rank="1"]').length,
      edgeCount: document.querySelectorAll('.connection-path').length,
    }));
    assertTrue(s.hasRoot, 'root card rendered');
    assertTrue(s.r1Count >= 1, `at least 1 r1 rendered (${s.r1Count})`);
    assertTrue(s.edgeCount >= s.r1Count, `edges rendered (${s.edgeCount} for ${s.r1Count} r1)`);
  } finally { await ctx.close(); }
}

async function testShuffleDeepLink(browser) {
  setTest('S3. URL hash deep-link loads that track as root');
  const { ctx, page } = await newPage(browser);
  try {
    const pick = await page.evaluate(async (api) => {
      const r = await fetch(`${api}/api/shuffle`);
      return (await r.json()).meta.root_id;
    }, H.API_BASE);
    await page.goto(`${APP_URL_SILENT}#${encodeURIComponent(pick)}`);
    await page.waitForSelector('.node-card[data-rank="root"]', { timeout: 15000 });
    await page.waitForTimeout(400);
    assertEq((await clusterSnapshot(page)).rootGraphId, pick, 'hash → root.graphId matches');
  } finally { await ctx.close(); }
}

// ── P: Playback ──────────────────────────────────────────────────────────────
async function ensurePlayableCluster(page, maxTries = 8) {
  for (let i = 0; i < maxTries; i++) {
    const s = await clusterSnapshot(page);
    const root = s.nodes.find(n => n.rank === 'root');
    const r1 = s.nodes.filter(n => n.rank === '1' && n.hasAudio);
    if (root?.hasAudio && r1.length >= 2) return { root, r1 };
    await page.click('#filter-shuffle-btn');
    await page.waitForTimeout(900);
  }
  return null;
}

async function snapshotPlayback(page) {
  return page.evaluate(() => ({
    playing: [...document.querySelectorAll('.node-card.playing')].map(c => c.dataset.nodeId),
    loading: [...document.querySelectorAll('.node-card.loading')].map(c => c.dataset.nodeId),
    scSrc: document.getElementById('sc-widget')?.src || '',
  }));
}

async function clickPlayOn(page, nodeId) {
  const ok = await page.evaluate((id) => {
    const btn = document.querySelector(`.node-card[data-node-id="${id}"] .play-btn`);
    if (!btn) return false;
    btn.click();
    return true;
  }, nodeId);
  if (!ok) throw new Error(`no play button for ${nodeId}`);
  // Poll up to 5s for target to enter .loading/.playing AND any previous .playing to clear
  await page.waitForFunction((id) => {
    const target = document.querySelector(`.node-card[data-node-id="${id}"]`);
    const targetActive = target?.classList.contains('loading') || target?.classList.contains('playing');
    const otherPlaying = [...document.querySelectorAll('.node-card.playing')].some(c => c !== target);
    return targetActive && !otherPlaying;
  }, nodeId, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);
}

async function testPlaybackMultipleTracks(browser) {
  setTest('P1. Play → switch across root + 2 r1 cards; iframe src tracks selection');
  const muted = await chromium.launch({ args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
  try {
    const { ctx, page } = await newPage(muted);
    try {
      await loadTracks(page, APP_URL_MUTED);
      const sel = await ensurePlayableCluster(page);
      if (!sel) return fail('no cluster with playable root+2 r1 within retry budget');

      await clickPlayOn(page, 'root');
      let st = await snapshotPlayback(page);
      assertTrue(st.playing.includes('root') || st.loading.includes('root'), 'root enters playing/loading');
      const rootSrc = st.scSrc;
      assertTrue(!!rootSrc && rootSrc !== 'about:blank', `SC iframe src set (${rootSrc.slice(0, 60)}…)`);

      await clickPlayOn(page, sel.r1[0].id);
      st = await snapshotPlayback(page);
      assertTrue(!st.playing.includes('root'), 'root no longer playing');
      assertTrue(st.playing.includes(sel.r1[0].id) || st.loading.includes(sel.r1[0].id), `r1[0] active`);
      assertTrue(st.scSrc !== rootSrc, 'SC iframe src changed for r1[0]');

      const r1aSrc = st.scSrc;
      await clickPlayOn(page, sel.r1[1].id);
      st = await snapshotPlayback(page);
      assertTrue(!st.playing.includes(sel.r1[0].id), 'r1[0] no longer playing');
      assertTrue(st.playing.includes(sel.r1[1].id) || st.loading.includes(sel.r1[1].id), 'r1[1] active');
      assertTrue(st.scSrc !== r1aSrc, 'SC iframe src changed for r1[1]');

      await page.click('#filter-shuffle-btn');
      await page.waitForTimeout(1200);
      assertEq((await snapshotPlayback(page)).playing.length, 0, 'no card playing after shuffle');
    } finally { await ctx.close(); }
  } finally { await muted.close(); }
}

// ── F: Filter UI → rendered cluster ──────────────────────────────────────────
async function testFilterArtist(browser) {
  setTest('F1. Artist filter via search bar → cluster contains that artist');
  const { ctx, page } = await newPage(browser);
  try {
    await loadTracks(page);
    const name = await page.evaluate(async (api) => {
      const r = await fetch(`${api}/api/search/artists?q=a&limit=1`);
      return (await r.json())[0]?.display;
    }, H.API_BASE);
    if (!name) return fail('no artists available');
    await addViaSearchBar(page, name, 'artist');
    const s = await clusterSnapshot(page);
    const norm = normalize(name);
    const hit = s.nodes.some(n => {
      const parts = (n.artist || '').split(/\s*,\s*|\s+[Ff]eat\.?\s+|\s+[Ff]t\.?\s+|\s+[Xx]\s+|\s*[&+]\s*|\s+and\s+/);
      return parts.some(p => normalize(p) === norm);
    });
    assertTrue(hit, `cluster contains "${name}"`);
  } finally { await ctx.close(); }
}

async function testFilterDj(browser) {
  setTest('F2. DJ filter via search bar → cluster node carries that DJ');
  const { ctx, page } = await newPage(browser);
  try {
    await loadTracks(page);
    const name = await page.evaluate(async (api) => {
      const r = await fetch(`${api}/api/search/djs?q=a&limit=1`);
      return (await r.json())[0]?.display;
    }, H.API_BASE);
    if (!name) return fail('no DJs available');
    await addViaSearchBar(page, name, 'dj');
    const s = await clusterSnapshot(page);
    assertTrue(s.nodes.some(n => (n.djs || []).some(d => normalize(d) === normalize(name))),
               `cluster contains DJ "${name}"`);
  } finally { await ctx.close(); }
}

async function testFilterGenre(browser) {
  setTest('F3. Genre filter via popover → cluster renders, pill activates');
  const { ctx, page } = await newPage(browser);
  try {
    await loadTracks(page);
    const chose = await addGenreViaPopover(page);
    if (!chose) return fail('could not pick a genre');
    const s = await clusterSnapshot(page);
    assertTrue(s.nodes.length >= 1, `cluster rendered after genre filter "${chose}"`);
    assertTrue(await page.evaluate(() => document.getElementById('pill-genre')?.classList.contains('active')),
               'pill-genre.active');
  } finally { await ctx.close(); }
}

// ── T: Song (track) search ───────────────────────────────────────────────────
async function testSongSearchRootMatches(browser) {
  setTest('T1. Song search via search bar → cluster root title matches');
  const { ctx, page } = await newPage(browser);
  try {
    await loadTracks(page);
    const track = await page.evaluate(async (api) => {
      const r = await fetch(`${api}/api/search/tracks?q=a&limit=1`);
      return (await r.json())[0];
    }, H.API_BASE);
    if (!track) return fail('no tracks available');
    await addViaSearchBar(page, track.display, 'song');
    const s = await clusterSnapshot(page);
    assertEq(normalize(s.rootTitle), normalize(track.display), `root title matches "${track.display}"`);
  } finally { await ctx.close(); }
}

async function testSongSearchFilterPersists(browser) {
  setTest('T2. Song search + shuffle → filter persists, root still matches');
  const { ctx, page } = await newPage(browser);
  try {
    await loadTracks(page);
    const track = await page.evaluate(async (api) => {
      const r = await fetch(`${api}/api/search/tracks?q=a&limit=1`);
      return (await r.json())[0];
    }, H.API_BASE);
    if (!track) return fail('no tracks available');
    await addViaSearchBar(page, track.display, 'song');
    const s1 = await clusterSnapshot(page);
    assertEq(normalize(s1.rootTitle), normalize(track.display), 'root matches after search');
    await page.click('#filter-shuffle-btn');
    await page.waitForTimeout(1500);
    const s2 = await clusterSnapshot(page);
    assertEq(normalize(s2.rootTitle), normalize(track.display), 'root still matches after shuffle');
  } finally { await ctx.close(); }
}

// ── D: Dig (crates) mode ─────────────────────────────────────────────────────
async function testDigTilesRender(browser) {
  setTest('D1. Dig: tiles render without filters');
  if (!(await digSupported())) { console.log('  (skipped — /api/crates-index Worker-only)'); return; }
  const { ctx, page } = await newPage(browser);
  try {
    await loadDig(page);
    const info = await page.evaluate(() => {
      const stacks = document.querySelectorAll('#crates-view .crate-stack');
      return {
        count: stacks.length,
        withItems: [...stacks].filter(s => s._b2bItem?.seedKey).length,
        sampleCount: stacks[0]?._b2bItem?.count || 0,
      };
    });
    assertTrue(info.count >= 6, `≥6 crate tiles rendered (${info.count})`);
    assertEq(info.withItems, info.count, 'all tiles have _b2bItem data');
    assertTrue(info.sampleCount > 0, `sample tile has count > 0 (${info.sampleCount})`);
  } finally { await ctx.close(); }
}

async function testDigClickLoadsCluster(browser) {
  setTest('D2. Dig tile click → Shuffle view with that seed as root');
  if (!(await digSupported())) { console.log('  (skipped — Worker-only)'); return; }
  const { ctx, page } = await newPage(browser);
  try {
    await loadDig(page);
    const seed = await page.evaluate(() => {
      const s = document.querySelector('#crates-view .crate-stack');
      const key = s?._b2bItem?.seedKey;
      if (s && key) { s.click(); return key; }
      return null;
    });
    if (!seed) return fail('no crate-stack to click');
    await page.waitForSelector('.node-card[data-rank="root"]', { timeout: 15000 });
    await page.waitForTimeout(800);
    assertEq((await clusterSnapshot(page)).rootGraphId, seed, 'cluster root matches seedKey');
    assertTrue(await page.evaluate(() => !document.body.classList.contains('crates-mode')),
               'switched to tracks mode');
  } finally { await ctx.close(); }
}

async function testDigWithGenreFilter(browser) {
  setTest('D3. Dig + genre filter: tiles re-render, all still have count > 0');
  if (!(await digSupported())) { console.log('  (skipped — Worker-only)'); return; }
  const { ctx, page } = await newPage(browser);
  try {
    await loadDig(page);
    const before = await page.evaluate(() =>
      [...document.querySelectorAll('#crates-view .crate-stack')].map(s => s._b2bItem?.seedKey));
    await addGenreViaPopover(page);
    await page.waitForTimeout(2000);
    await page.waitForSelector('#crates-view .crate-stack', { timeout: 10000 });
    const after = await page.evaluate(() => {
      const stacks = [...document.querySelectorAll('#crates-view .crate-stack')];
      return {
        keys: stacks.map(s => s._b2bItem?.seedKey),
        counts: stacks.map(s => s._b2bItem?.count || 0),
      };
    });
    assertTrue(after.keys.length >= 3, `filtered tiles render (${after.keys.length})`);
    assertTrue(after.counts.every(c => c > 0), 'every filtered tile has count > 0');
    assertTrue(after.keys.filter(k => !before.includes(k)).length >= 1, 'filter changed the tile set');
  } finally { await ctx.close(); }
}

// ── Runner ───────────────────────────────────────────────────────────────────
(async () => {
  const browser = await chromium.launch();
  let code;
  try {
    code = await runner([
      testShuffleDifferentRoots,
      testShuffleClusterShape,
      testShuffleDeepLink,
      testPlaybackMultipleTracks,
      testFilterArtist,
      testFilterDj,
      testFilterGenre,
      testSongSearchRootMatches,
      testSongSearchFilterPersists,
      testDigTilesRender,
      testDigClickLoadsCluster,
      testDigWithGenreFilter,
    ], { browser });
  } finally {
    await browser.close();
  }
  process.exit(code);
})().catch(e => { console.error(e); process.exit(2); });
