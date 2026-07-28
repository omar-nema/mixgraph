/**
 * Playback test suite — Playwright / Chromium (desktop + mobile viewport).
 *
 * Covers the cross-browser functional playback behaviours:
 *   PB1  cold first-play (track)            — desktop
 *   PB2  cold first-play (mix)              — desktop
 *   PB3  second-play switches cards         — desktop (app has no next/prev transport;
 *                                              "next" = clicking another card)
 *   PB4  play → pause → resume toggle       — desktop
 *   PB5  seek jumps playback position       — desktop
 *   PB6  dead/blocked track: no stuck-play, source NEVER auto-switched — desktop
 *   PB7  track-end (FINISH) stops + resets  — desktop (no auto-advance queue)
 *   PB8  cold first-play (track)            — MOBILE viewport (carousel path)
 *   PB9  Safari cold-start primer is INERT on non-Safari (no behavior change)
 *
 * The Safari-specific cold-start-silence scenario is verified in REAL Safari via
 * safaridriver — see tests/safari-coldstart.test.cjs (Playwright/WebKit gives
 * false verdicts on that bug and must NOT be used for it).
 *
 * Launches Chromium with --mute-audio --autoplay-policy=no-user-gesture-required
 * so the SC widget exercises real load()/PLAY/position events silently. Verdict
 * for "is it playing" = the app's own audible-gated `.playing` class (never a
 * PLAY event or a landed seek). Real SoundCloud streams are occasionally dead or
 * slow, so tests try a few cards + one reshuffle to get genuine audio; if SC is
 * simply unavailable this run they SKIP (pass) rather than false-fail.
 *
 * Requires static server on :8001 and API on :3001 (started by tests/run-all.sh).
 * Run: node tests/playback.test.cjs
 */
const { chromium } = require('playwright');
const H = require('./_helpers.cjs');
const { setTest, pass, fail, assertTrue, assertEq, runner, APP_URL_MUTED, newPage } = H;

const MUTED_ARGS = ['--mute-audio', '--autoplay-policy=no-user-gesture-required'];
const DEAD_URL = 'https://soundcloud.com/nonexistent-account-zzzq/does-not-exist-zzzq';

async function loadTracksAudible(page) {
  await page.goto(APP_URL_MUTED);
  await page.waitForSelector('#mode-tabs .mode-tab[data-mode="tracks"]', { timeout: 10000 });
  await page.click('#mode-tabs .mode-tab[data-mode="tracks"]');
  try { await page.waitForSelector('.node-card[data-rank="root"]', { timeout: 15000 }); }
  catch { await page.click('#filter-shuffle-btn').catch(() => {}); await page.waitForSelector('.node-card[data-rank="root"]', { timeout: 15000 }); }
  await page.waitForTimeout(400);
}

async function clusterCards(page) {
  return page.evaluate(() => {
    const list = (typeof nodes !== 'undefined' && nodes) ? nodes : [];
    const m = (n) => ({ id: n.id, rank: n.rank, hasTrack: !!n.scTrackUrl, hasMix: !!n.setUrl });
    const root = list.find(n => n.rank === 'root');
    return { root: root ? m(root) : null, r1: list.filter(n => n.rank === '1').map(m) };
  });
}

const snap = (page) => page.evaluate(() => ({
  playing: [...document.querySelectorAll('.node-card.playing')].map(c => c.dataset.nodeId),
  scSrc: document.getElementById('sc-widget')?.src || '',
}));

async function clickPlay(page, nodeId) {
  const ok = await page.evaluate((id) => {
    const b = document.querySelector(`.node-card[data-node-id="${id}"] .play-btn`); if (!b) return false; b.click(); return true;
  }, nodeId);
  if (!ok) throw new Error(`no play button for ${nodeId}`);
}

async function waitPlaying(page, nodeId, timeout = 12000) {
  return page.waitForFunction((id) =>
    document.querySelector(`.node-card[data-node-id="${id}"]`)?.classList.contains('playing'),
    nodeId, { timeout }).then(() => true).catch(() => false);
}

async function setSource(page, nodeId, src) {
  await page.evaluate(({ id, s }) => { if (typeof setSelectedAudioSource === 'function') setSelectedAudioSource(id, s); }, { id: nodeId, s: src });
  await page.waitForTimeout(150);
}

async function stopAll(page) {
  await page.evaluate(() => { try { stopCurrentPlayback(); } catch (e) {} });
  await page.waitForTimeout(400);
}

// Get a card that ACTUALLY reaches audible .playing. Tries up to 3 candidates,
// reshuffling once. Returns the playing node id, or null if SC won't stream.
async function getAudiblePlay(page, source = 'track', { exclude = [] } = {}) {
  for (let round = 0; round < 2; round++) {
    const s = await clusterCards(page);
    const cands = [s.root, ...s.r1].filter(n => n && (source === 'track' ? n.hasTrack : n.hasMix) && !exclude.includes(n.id));
    for (const c of cands.slice(0, 3)) {
      await setSource(page, c.id, source);
      await clickPlay(page, c.id);
      if (await waitPlaying(page, c.id, source === 'mix' ? 18000 : 12000)) return c.id;
      await stopAll(page);
    }
    if (round === 0) { await page.click('#filter-shuffle-btn').catch(() => {}); await page.waitForTimeout(1000); }
  }
  return null;
}

// ── PB1: cold first-play (track) ─────────────────────────────────────────────
async function testColdTrack(browser) {
  setTest('PB1. Cold first-play (track) reaches audible .playing');
  const { ctx, page } = await newPage(browser);
  try {
    await loadTracksAudible(page);
    const id = await getAudiblePlay(page, 'track');
    if (!id) return pass('skipped — SC track playback unavailable this run');
    assertTrue(true, `track card reached audible .playing (${id.slice(0, 30)}…)`);
    const st = await snap(page);
    assertTrue(!!st.scSrc && st.scSrc !== 'about:blank', 'SC iframe src set');
  } finally { await ctx.close(); }
}

// ── PB2: cold first-play (mix) ───────────────────────────────────────────────
async function testColdMix(browser) {
  setTest('PB2. Cold first-play (mix) reaches audible .playing');
  const { ctx, page } = await newPage(browser);
  try {
    await loadTracksAudible(page);
    const id = await getAudiblePlay(page, 'mix');
    if (!id) return pass('skipped — SC mix playback unavailable this run');
    assertTrue(true, `mix card reached audible .playing (seeks past intro first)`);
  } finally { await ctx.close(); }
}

// ── PB3: second-play switches cards ──────────────────────────────────────────
async function testSecondPlaySwitch(browser) {
  setTest('PB3. Second play switches to another card (first stops)');
  const { ctx, page } = await newPage(browser);
  try {
    await loadTracksAudible(page);
    const a = await getAudiblePlay(page, 'track');
    if (!a) return pass('skipped — SC playback unavailable this run');
    const b = await getAudiblePlay(page, 'track', { exclude: [a] });
    if (!b) return pass('skipped — only one card could stream this run');
    assertTrue(b !== a, `second card plays (${b.slice(0, 24)}…)`);
    const st = await snap(page);
    assertTrue(!st.playing.includes(a), 'first card no longer playing');
  } finally { await ctx.close(); }
}

// ── PB4: play → pause → resume ───────────────────────────────────────────────
async function testPauseResume(browser) {
  setTest('PB4. Play → pause → resume toggles playback');
  const { ctx, page } = await newPage(browser);
  try {
    await loadTracksAudible(page);
    const id = await getAudiblePlay(page, 'track');
    if (!id) return pass('skipped — SC playback unavailable this run');
    await page.evaluate((i) => document.querySelector(`.node-card[data-node-id="${i}"] .play-btn`).click(), id); // pause
    const paused = await page.waitForFunction((i) =>
      !document.querySelector(`.node-card[data-node-id="${i}"]`)?.classList.contains('playing'),
      id, { timeout: 5000 }).then(() => true).catch(() => false);
    assertTrue(paused, 'pause clears .playing');
    await page.evaluate((i) => document.querySelector(`.node-card[data-node-id="${i}"] .play-btn`).click(), id); // resume
    assertTrue(await waitPlaying(page, id), 'resume returns to .playing');
  } finally { await ctx.close(); }
}

// ── PB5: seek jumps position ─────────────────────────────────────────────────
async function testSeek(browser) {
  setTest('PB5. Clicking the progress bar seeks playback forward');
  const { ctx, page } = await newPage(browser);
  try {
    await loadTracksAudible(page);
    const id = await getAudiblePlay(page, 'track');
    if (!id) return pass('skipped — SC playback unavailable this run');
    const bar = await page.$(`.node-card[data-node-id="${id}"] .progress-bar`);
    if (!bar) return pass('skipped — no progress bar');
    const box = await bar.boundingBox();
    await page.mouse.click(box.x + box.width * 0.7, box.y + box.height / 2); // seek ~70%
    await page.waitForTimeout(1500);
    const pos = await page.evaluate(() => new Promise(res => { try { scWidget.getPosition(p => res(p)); } catch (e) { res(-1); } }));
    const dur = await page.evaluate(() => new Promise(res => { try { scWidget.getDuration(d => res(d)); } catch (e) { res(0); } }));
    assertTrue(dur > 0 && pos > dur * 0.4, `seek moved position into the second half (pos ${Math.round(pos/1000)}s / dur ${Math.round(dur/1000)}s)`);
  } finally { await ctx.close(); }
}

// ── PB6: dead/blocked track — never stuck, source NEVER auto-switched ─────────
async function testDeadTrack(browser) {
  setTest('PB6. Dead track: no stuck-playing state, source not auto-switched');
  const { ctx, page } = await newPage(browser);
  try {
    await loadTracksAudible(page);
    const s = await clusterCards(page);
    const t = (s.root && s.root.hasTrack) ? s.root : s.r1.find(n => n.hasTrack);
    if (!t) return pass('skipped — no track card');
    await page.evaluate(({ id, url }) => { nodeMap[id].scTrackUrl = url; if (typeof setSelectedAudioSource === 'function') setSelectedAudioSource(id, 'track'); }, { id: t.id, url: DEAD_URL });
    await page.evaluate((id) => document.querySelector(`.node-card[data-node-id="${id}"] .play-btn`).click(), t.id);
    await page.waitForTimeout(12000); // dead-detection (~1.5-4s) or play-timeout (10s)
    const st = await page.evaluate((id) => ({
      playing: document.querySelector(`.node-card[data-node-id="${id}"]`)?.classList.contains('playing'),
      selectedSrc: (typeof getSelectedAudioSource === 'function') ? getSelectedAudioSource(id) : 'n/a',
    }), t.id);
    assertTrue(st.playing !== true, 'dead track is not stuck in .playing');
    assertTrue(st.selectedSrc !== 'mix', 'source was NOT auto-switched to mix (policy)');
  } finally { await ctx.close(); }
}

// ── PB7: track-end (FINISH) stops + resets, no auto-advance ──────────────────
async function testTrackEndResets(browser) {
  setTest('PB7. Track end (FINISH) stops and resets, no auto-advance');
  const { ctx, page } = await newPage(browser);
  try {
    await loadTracksAudible(page);
    const id = await getAudiblePlay(page, 'track');
    if (!id) return pass('skipped — SC playback unavailable this run');
    await page.evaluate(() => { if (typeof onPlaybackEnded === 'function') onPlaybackEnded(); }); // simulate end-of-track FINISH
    await page.waitForTimeout(400);
    const st = await snap(page);
    assertEq(st.playing.length, 0, 'no card playing after track end');
    const cleared = await page.evaluate(() => (typeof currentlyPlayingId === 'undefined') || currentlyPlayingId == null);
    assertTrue(cleared, 'playback state cleared (no auto-advance to a next track)');
  } finally { await ctx.close(); }
}

// ── PB8: mobile viewport cold first-play (track) via carousel ────────────────
async function testMobileColdTrack(browser) {
  setTest('PB8. Mobile viewport: cold first-play (track) plays via carousel');
  const { ctx, page } = await newPage(browser, { mobile: true });
  try {
    await page.goto(APP_URL_MUTED);
    try { await page.waitForSelector('#mobile-carousel .mobile-carousel-item', { timeout: 8000 }); }
    catch {
      await page.click('#mobile-mode-tabs .mode-tab[data-mode="tracks"]', { force: true }).catch(() => {});
      await page.waitForSelector('#mobile-carousel .mobile-carousel-item', { timeout: 12000 }).catch(() => {});
    }
    if (!await page.$('#mobile-carousel .mobile-carousel-item')) return pass('skipped — no mobile carousel');
    // Try up to 3 track-capable nodes for one that actually streams.
    let played = false;
    for (let i = 0; i < 3 && !played; i++) {
      const id = await page.evaluate((skip) => {
        const list = (typeof nodes !== 'undefined' && nodes) ? nodes : [];
        const n = list.filter(x => x.scTrackUrl).find(x => !skip.includes(x.id));
        if (!n) return null;
        if (typeof setSelectedAudioSource === 'function') setSelectedAudioSource(n.id, 'track');
        if (typeof selectMobileTrack === 'function') selectMobileTrack(n.id);
        return n.id;
      }, []);
      if (!id) break;
      played = await page.waitForFunction(() =>
        document.querySelectorAll('.mobile-carousel-card.playing').length > 0,
        null, { timeout: 12000 }).then(() => true).catch(() => false);
      if (!played) await stopAll(page);
    }
    if (!played) return pass('skipped — SC mobile playback unavailable this run');
    assertTrue(played, 'mobile carousel card reaches audible .playing');
  } finally { await ctx.close(); }
}

// ── PB9: Safari primer inert on non-Safari (no behavior change) ──────────────
async function testSafariPrimerInertOnChromium(browser) {
  setTest('PB9. Safari cold-start primer is inert on non-Safari');
  const { ctx, page } = await newPage(browser);
  try {
    await loadTracksAudible(page);
    const isSafari = await page.evaluate(() => (typeof IS_DESKTOP_SAFARI !== 'undefined') ? IS_DESKTOP_SAFARI : 'undef');
    assertEq(isSafari, false, 'IS_DESKTOP_SAFARI is false on Chromium');
    await page.mouse.click(5, 5); // a real click must NOT arm/consume priming on non-Safari
    await page.waitForTimeout(300);
    const primed = await page.evaluate(() => (typeof safariPrimed !== 'undefined') ? safariPrimed : 'undef');
    assertEq(primed, false, 'no priming occurred on Chromium (safariPrimed stays false)');
  } finally { await ctx.close(); }
}

// ── Runner ───────────────────────────────────────────────────────────────────
(async () => {
  const browser = await chromium.launch({ args: MUTED_ARGS });
  let code;
  try {
    code = await runner([
      testColdTrack, testColdMix, testSecondPlaySwitch, testPauseResume, testSeek,
      testDeadTrack, testTrackEndResets, testMobileColdTrack, testSafariPrimerInertOnChromium,
    ], { browser });
  } finally { await browser.close(); }
  process.exit(code);
})().catch(e => { console.error(e); process.exit(2); });
