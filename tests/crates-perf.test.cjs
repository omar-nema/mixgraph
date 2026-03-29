/**
 * Crates mode perf regression tests
 * Covers: rAF pan throttling, DOM pruning, mount/unmount cycles, touch events, view transitions
 * Run: node tests/crates-perf.test.cjs
 */
const { chromium } = require('playwright');

const BASE = 'http://localhost:8001/?noplay';
const MOBILE_VIEWPORT = { width: 375, height: 812 };
const DESKTOP_VIEWPORT = { width: 1280, height: 800 };

// External domains that generate benign CORS/network errors — ignore these
const IGNORE_PATTERNS = ['cloudflareinsights', 'cdn-cgi/rum', 'ERR_FAILED', '404 ()'];

function isAppError(msg) {
  const text = msg.text();
  return !IGNORE_PATTERNS.some(s => text.includes(s));
}

// Desktop uses #mode-tabs, mobile uses #mobile-mode-tabs
async function openCratesView(page, mobile = false) {
  const selector = mobile
    ? '#mobile-mode-tabs .mode-tab[data-mode="crates"]'
    : '#mode-tabs .mode-tab[data-mode="crates"]';
  await page.click(selector, { force: true });
  await page.waitForSelector('#crates-loading.hidden', { timeout: 12000 });
}

async function openTracksView(page, mobile = false) {
  const selector = mobile
    ? '#mobile-mode-tabs .mode-tab[data-mode="tracks"]'
    : '#mode-tabs .mode-tab[data-mode="tracks"]';
  await page.click(selector, { force: true });
}

async function collectConsoleErrors(page, fn) {
  const errors = [];
  const handler = msg => { if (msg.type() === 'error' && isAppError(msg)) errors.push(msg.text()); };
  page.on('console', handler);
  await fn();
  page.off('console', handler);
  return errors;
}

// ─── Desktop tests ────────────────────────────────────────────────────────────

async function testDesktopDragPan(browser) {
  console.log('\n[TEST] Desktop: mouse drag pan');
  const ctx = await browser.newContext({ viewport: DESKTOP_VIEWPORT });
  const page = await ctx.newPage();
  const errors = await collectConsoleErrors(page, async () => {
    await page.goto(BASE);
    await openCratesView(page);

    const box = await page.locator('#crates-view').boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // Drag right then left
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 300, cy, { steps: 20 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    await page.mouse.move(cx + 300, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy, { steps: 20 });
    await page.mouse.up();
    await page.waitForTimeout(200);
  });
  await ctx.close();
  if (errors.length) { console.error('  FAIL:', errors); return false; }
  console.log('  PASS');
  return true;
}

async function testDesktopWheelPan(browser) {
  console.log('\n[TEST] Desktop: wheel pan');
  const ctx = await browser.newContext({ viewport: DESKTOP_VIEWPORT });
  const page = await ctx.newPage();
  const errors = await collectConsoleErrors(page, async () => {
    await page.goto(BASE);
    await openCratesView(page);

    // Scroll right and down
    for (let i = 0; i < 20; i++) await page.mouse.wheel(150, 100);
    await page.waitForTimeout(400);
    // Scroll back
    for (let i = 0; i < 20; i++) await page.mouse.wheel(-150, -100);
    await page.waitForTimeout(400);
  });
  await ctx.close();
  if (errors.length) { console.error('  FAIL:', errors); return false; }
  console.log('  PASS');
  return true;
}

async function testMousedownAfterWheel(browser) {
  // Bug 2: panStartX = panX captures stale value when rAF is pending.
  // Scenario: wheel sets targetPanX=-500 (rAF pending), mousedown before rAF fires,
  // then drag 100px. Without fix: targetPanX = 0+100 = 100 (snaps back toward origin).
  // With fix: targetPanX = -500+100 = -400 (stays near wheel position).
  console.log('\n[TEST] Desktop: mousedown immediately after wheel (stale panX bug check)');
  const ctx = await browser.newContext({ viewport: DESKTOP_VIEWPORT });
  const page = await ctx.newPage();
  let snapDetected = false;
  const errors = await collectConsoleErrors(page, async () => {
    await page.goto(BASE);
    await openCratesView(page);

    const box = await page.locator('#crates-view').boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);

    // Wheel a large amount to the right: targetPanX = -500
    await page.mouse.wheel(500, 0);

    // Immediately mousedown (before rAF fires, panX is still 0 but targetPanX is -500)
    await page.mouse.down();

    // Drag 100px to the right — this should make targetPanX = (panStart) + 100
    // With fix (panStart = targetPanX = -500): final = -400
    // Without fix (panStart = panX = 0): final = 100 (wrong — snaps back toward origin)
    await page.mouse.move(cx + 100, cy, { steps: 8 });
    await page.waitForTimeout(100); // let rAF fire

    const finalPan = await page.evaluate(() => {
      const t = document.getElementById('crates-surface').style.transform;
      const m = t.match(/translate3d\(([^,]+)px/);
      return m ? parseFloat(m[1]) : 0;
    });
    await page.mouse.up();

    console.log(`  Final panX after wheel(-500) + drag(+100): ${finalPan.toFixed(1)}px`);
    console.log(`  Expected ≈ -400 (fix) or ≈ 100 (bug)`);

    // If panX is near +100 it means panStart was captured as 0 (stale panX bug)
    // If panX is near -400 it means panStart was correctly captured as -500 (targetPanX)
    if (finalPan > -100) {
      snapDetected = true;
      console.warn(`  BUG 2 CONFIRMED: panX=${finalPan.toFixed(0)} — snap back to origin (panStartX used stale panX=0)`);
    }

    await page.waitForTimeout(200);
  });
  await ctx.close();
  if (errors.length) { console.error('  FAIL (errors):', errors); return false; }
  if (snapDetected) { console.log('  FAIL: Bug 2 — stale panX on mousedown'); return false; }
  console.log('  PASS');
  return true;
}

async function testRapidTabSwitching(browser) {
  console.log('\n[TEST] Desktop: rapid Tracks↔Crates switching (6 times)');
  const ctx = await browser.newContext({ viewport: DESKTOP_VIEWPORT });
  const page = await ctx.newPage();
  const errors = await collectConsoleErrors(page, async () => {
    await page.goto(BASE);
    await openCratesView(page);
    await page.waitForTimeout(300);

    for (let i = 0; i < 6; i++) {
      await openTracksView(page);
      await page.waitForTimeout(80);
      await openCratesView(page);
      await page.waitForTimeout(80);
    }
    await page.waitForTimeout(500);
  });
  await ctx.close();
  if (errors.length) { console.error('  FAIL:', errors); return false; }
  console.log('  PASS');
  return true;
}

async function testCratesWheelFarThenBack(browser) {
  console.log('\n[TEST] Desktop: pan far (DOM pruning) then pan back (remount)');
  const ctx = await browser.newContext({ viewport: DESKTOP_VIEWPORT });
  const page = await ctx.newPage();
  const errors = await collectConsoleErrors(page, async () => {
    await page.goto(BASE);
    await openCratesView(page);

    // Scroll far right (force ±5 DOM pruning of early pages)
    for (let i = 0; i < 80; i++) await page.mouse.wheel(200, 0);
    await page.waitForTimeout(600);

    const farCount = await page.evaluate(() =>
      document.querySelectorAll('#crates-surface .crate-page').length
    );
    console.log(`  Mounted pages after far pan: ${farCount}`);

    // Pan back left — pruned pages should remount
    for (let i = 0; i < 80; i++) await page.mouse.wheel(-200, 0);
    await page.waitForTimeout(600);

    const backCount = await page.evaluate(() =>
      document.querySelectorAll('#crates-surface .crate-page').length
    );
    console.log(`  Mounted pages after return: ${backCount}`);
  });
  await ctx.close();
  if (errors.length) { console.error('  FAIL:', errors); return false; }
  console.log('  PASS');
  return true;
}

async function testClickStackThenBackToCrates(browser) {
  console.log('\n[TEST] Desktop: click crate stack → Tracks, then back to Crates');
  const ctx = await browser.newContext({ viewport: DESKTOP_VIEWPORT });
  const page = await ctx.newPage();
  const errors = await collectConsoleErrors(page, async () => {
    await page.goto(BASE);
    await openCratesView(page);
    await page.waitForTimeout(500);

    // Pan a bit first
    await page.mouse.wheel(300, 100);
    await page.waitForTimeout(200);

    // Click a stack
    const stacks = await page.locator('.crate-stack').all();
    if (stacks.length > 0) {
      await stacks[0].click({ force: true });
      // Wait for crates-view to get .hidden class (transition complete ~800ms + 150ms)
      await page.waitForFunction(
        () => document.getElementById('crates-view').classList.contains('hidden'),
        { timeout: 5000 }
      );
      await page.waitForTimeout(500);
    } else {
      console.log('  (no stacks found, skipping click)');
    }

    // Back to Crates
    await openCratesView(page);
    await page.waitForTimeout(300);

    // Pan should still work
    await page.mouse.wheel(200, 0);
    await page.waitForTimeout(200);
  });
  await ctx.close();
  if (errors.length) { console.error('  FAIL:', errors); return false; }
  console.log('  PASS');
  return true;
}

async function testNullPageElGuard(browser) {
  console.log('\n[TEST] Desktop: unmounted pages remount without art errors');
  const ctx = await browser.newContext({ viewport: DESKTOP_VIEWPORT });
  const page = await ctx.newPage();
  const errors = await collectConsoleErrors(page, async () => {
    await page.goto(BASE);
    await openCratesView(page);

    // Pan right 7+ viewports to trigger ±5 DOM pruning
    for (let i = 0; i < 80; i++) await page.mouse.wheel(180, 0);
    await page.waitForTimeout(600);

    const pruned = await page.evaluate(() =>
      document.querySelectorAll('#crates-surface .crate-page').length
    );
    console.log(`  Mounted DOM pages after far scroll: ${pruned}`);

    // Pan back — pruned pages should remount cleanly with art
    for (let i = 0; i < 80; i++) await page.mouse.wheel(-180, 0);
    await page.waitForTimeout(800);

    const remounted = await page.evaluate(() =>
      document.querySelectorAll('#crates-surface .crate-page').length
    );
    console.log(`  Mounted DOM pages after return: ${remounted}`);

    // Check no images are in detached pages (guard verification)
    const detachedImgs = await page.evaluate(() => {
      // Count img elements that are NOT in the live DOM
      // (This is a proxy — we trust the browser to handle detached DOM without errors)
      return document.querySelectorAll('#crates-surface img').length;
    });
    console.log(`  Images in mounted pages: ${detachedImgs}`);
  });
  await ctx.close();
  if (errors.length) { console.error('  FAIL:', errors); return false; }
  console.log('  PASS');
  return true;
}

// ─── Mobile helpers ───────────────────────────────────────────────────────────

async function simulateTouch(page, type, touches) {
  await page.evaluate(({ type, touches }) => {
    const el = document.getElementById('crates-view');
    const touchList = touches.map(t => new Touch({
      identifier: t.id,
      target: el,
      clientX: t.x,
      clientY: t.y,
      radiusX: 1, radiusY: 1, rotationAngle: 0, force: 1
    }));
    const event = new TouchEvent(type, {
      cancelable: true,
      bubbles: true,
      touches: type === 'touchend' ? [] : touchList,
      changedTouches: touchList,
      targetTouches: type === 'touchend' ? [] : touchList,
    });
    el.dispatchEvent(event);
  }, { type, touches });
}

async function fling(page, fromX, fromY, dx, steps = 6) {
  await simulateTouch(page, 'touchstart', [{ id: 1, x: fromX, y: fromY }]);
  for (let s = 1; s <= steps; s++) {
    await simulateTouch(page, 'touchmove', [{ id: 1, x: fromX + dx * (s / steps), y: fromY }]);
  }
  await simulateTouch(page, 'touchend', []);
}

// ─── Mobile tests ─────────────────────────────────────────────────────────────

async function testMobileRapidPan(browser) {
  console.log('\n[TEST] Mobile: rapid touch panning in all directions');
  const ctx = await browser.newContext({ viewport: MOBILE_VIEWPORT, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = await collectConsoleErrors(page, async () => {
    await page.goto(BASE);
    await openCratesView(page, true);

    const cx = MOBILE_VIEWPORT.width / 2, cy = MOBILE_VIEWPORT.height / 2;
    for (const [dx, dy] of [[200,0],[-200,0],[0,200],[0,-200]]) {
      await simulateTouch(page, 'touchstart', [{ id: 1, x: cx, y: cy }]);
      for (let s = 1; s <= 15; s++) {
        await simulateTouch(page, 'touchmove', [{ id: 1, x: cx + dx*(s/15), y: cy + dy*(s/15) }]);
      }
      await simulateTouch(page, 'touchend', []);
      await page.waitForTimeout(200);
    }
  });
  await ctx.close();
  if (errors.length) { console.error('  FAIL:', errors); return false; }
  console.log('  PASS');
  return true;
}

async function testMobileFlingThenImmediateTap(browser) {
  console.log('\n[TEST] Mobile: fling then immediate tap (crash scenario)');
  const ctx = await browser.newContext({ viewport: MOBILE_VIEWPORT, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = await collectConsoleErrors(page, async () => {
    await page.goto(BASE);
    await openCratesView(page, true);

    const cx = 187, cy = 406;

    // Fast fling (high velocity)
    await fling(page, cx, cy, 300, 5);

    // Immediately tap (before momentum decays) — should not crash
    await page.waitForTimeout(20);
    await simulateTouch(page, 'touchstart', [{ id: 1, x: cx, y: cy }]);
    await simulateTouch(page, 'touchend', []);
    await page.waitForTimeout(300);
  });
  await ctx.close();
  if (errors.length) { console.error('  FAIL:', errors); return false; }
  console.log('  PASS');
  return true;
}

async function testMobileFlingReversal(browser) {
  console.log('\n[TEST] Mobile: fling → fling in opposite direction (momentum reversal)');
  const ctx = await browser.newContext({ viewport: MOBILE_VIEWPORT, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = await collectConsoleErrors(page, async () => {
    await page.goto(BASE);
    await openCratesView(page, true);

    const cx = 187, cy = 406;

    // Fling right
    await fling(page, cx, cy, 300, 5);
    await page.waitForTimeout(50); // momentum running

    // Fling left while momentum is running
    await fling(page, cx + 300, cy, -300, 5);
    await page.waitForTimeout(500);

    const transform = await page.evaluate(() =>
      document.getElementById('crates-surface').style.transform
    );
    console.log(`  Transform after reversal: ${transform}`);
  });
  await ctx.close();
  if (errors.length) { console.error('  FAIL:', errors); return false; }
  console.log('  PASS');
  return true;
}

async function testMobilePinchDuringMomentum(browser) {
  // Bug 1: pinch during momentum doesn't cancel momentumId — position drifts wildly
  console.log('\n[TEST] Mobile: pinch-to-zoom during momentum (Bug 1 — momentum not canceled)');
  const ctx = await browser.newContext({ viewport: MOBILE_VIEWPORT, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  let panDrift = false;
  const errors = await collectConsoleErrors(page, async () => {
    await page.goto(BASE);
    await openCratesView(page, true);

    const cx = 187, cy = 406;

    // Fling right to start momentum
    await fling(page, cx, cy, 300, 6);
    await page.waitForTimeout(30); // momentum running

    // Capture position right after fling
    const panAtFling = await page.evaluate(() => {
      const t = document.getElementById('crates-surface').style.transform;
      const m = t.match(/translate3d\(([^,]+)px/);
      return m ? parseFloat(m[1]) : 0;
    });

    // Start a pinch (2-finger touchstart) while momentum is running
    await page.evaluate(({ cx, cy }) => {
      const el = document.getElementById('crates-view');
      const t1 = new Touch({ identifier: 1, target: el, clientX: cx - 60, clientY: cy, radiusX: 1, radiusY: 1, rotationAngle: 0, force: 1 });
      const t2 = new Touch({ identifier: 2, target: el, clientX: cx + 60, clientY: cy, radiusX: 1, radiusY: 1, rotationAngle: 0, force: 1 });
      el.dispatchEvent(new TouchEvent('touchstart', {
        cancelable: true, bubbles: true,
        touches: [t1, t2], changedTouches: [t1, t2], targetTouches: [t1, t2]
      }));
    }, { cx, cy });

    // Pinch open (spread fingers)
    for (let s = 1; s <= 8; s++) {
      await page.evaluate(({ cx, cy, s }) => {
        const el = document.getElementById('crates-view');
        const spread = 60 + s * 15;
        const t1 = new Touch({ identifier: 1, target: el, clientX: cx - spread, clientY: cy, radiusX: 1, radiusY: 1, rotationAngle: 0, force: 1 });
        const t2 = new Touch({ identifier: 2, target: el, clientX: cx + spread, clientY: cy, radiusX: 1, radiusY: 1, rotationAngle: 0, force: 1 });
        el.dispatchEvent(new TouchEvent('touchmove', {
          cancelable: true, bubbles: true,
          touches: [t1, t2], changedTouches: [t1, t2], targetTouches: [t1, t2]
        }));
      }, { cx, cy, s });
      await page.waitForTimeout(16);
    }

    // Lift fingers
    await page.evaluate(() => {
      const el = document.getElementById('crates-view');
      el.dispatchEvent(new TouchEvent('touchend', {
        cancelable: true, bubbles: true,
        touches: [], changedTouches: [], targetTouches: []
      }));
    });

    // Wait for any remaining momentum to settle
    await page.waitForTimeout(500);

    const transform = await page.evaluate(() =>
      document.getElementById('crates-surface').style.transform
    );
    console.log(`  Transform after pinch-during-momentum: ${transform}`);

    // Check: if momentum ran during pinch, the translateX will be enormous
    const panX = parseFloat(transform.match(/translate3d\(([^,]+)px/)?.[1] ?? 0);
    const panDeltaFromFling = Math.abs(panX - panAtFling);
    console.log(`  Pan at fling end: ${panAtFling.toFixed(0)}px, pan after pinch: ${panX.toFixed(0)}px, drift: ${panDeltaFromFling.toFixed(0)}px`);

    // With Bug 1 unfixed, momentum keeps running during pinch — panX drifts enormously (>2000px in test)
    // With fix, momentum is canceled on 2-finger touchstart — panX should be roughly stable during pinch
    if (panDeltaFromFling > 2000) {
      panDrift = true;
      console.warn(`  BUG 1 CONFIRMED: ${panDeltaFromFling.toFixed(0)}px drift during pinch (momentum not canceled)`);
    }
  });
  await ctx.close();
  if (errors.length) { console.error('  FAIL (errors):', errors); return false; }
  if (panDrift) { console.log('  FAIL: Bug 1 — momentum continues during pinch'); return false; }
  console.log('  PASS');
  return true;
}

async function testMobileFarPanMountUnmountRemount(browser) {
  console.log('\n[TEST] Mobile: pan far → pan back (mount/unmount/remount cycle)');
  const ctx = await browser.newContext({ viewport: MOBILE_VIEWPORT, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = await collectConsoleErrors(page, async () => {
    await page.goto(BASE);
    await openCratesView(page, true);

    const cx = 187, cy = 406;

    // Fling many times to the right (move many pages)
    for (let round = 0; round < 8; round++) {
      await fling(page, cx, cy, 320, 8);
      await page.waitForTimeout(500);
    }

    const farPages = await page.evaluate(() =>
      document.querySelectorAll('#crates-surface .crate-page').length
    );
    console.log(`  Mounted DOM pages after far pan: ${farPages}`);

    // Fling all the way back
    for (let round = 0; round < 8; round++) {
      await fling(page, cx, cy, -320, 8);
      await page.waitForTimeout(500);
    }

    const backPages = await page.evaluate(() =>
      document.querySelectorAll('#crates-surface .crate-page').length
    );
    console.log(`  Mounted DOM pages after return: ${backPages}`);
  });
  await ctx.close();
  if (errors.length) { console.error('  FAIL:', errors); return false; }
  console.log('  PASS');
  return true;
}

async function testMobileRapidTabSwitching(browser) {
  console.log('\n[TEST] Mobile: rapid Tracks↔Crates switching (6 times)');
  const ctx = await browser.newContext({ viewport: MOBILE_VIEWPORT, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = await collectConsoleErrors(page, async () => {
    await page.goto(BASE);
    await openCratesView(page, true);
    await page.waitForTimeout(300);

    for (let i = 0; i < 6; i++) {
      await openTracksView(page, true);
      await page.waitForTimeout(60);
      await openCratesView(page, true);
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(500);
  });
  await ctx.close();
  if (errors.length) { console.error('  FAIL:', errors); return false; }
  console.log('  PASS');
  return true;
}

async function testMobileFlingDuringTabSwitch(browser) {
  // Bug 4: momentumStep not canceled when switching away from Crates
  console.log('\n[TEST] Mobile: fling then switch to Tracks (momentum leak check — Bug 4)');
  const ctx = await browser.newContext({ viewport: MOBILE_VIEWPORT, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  let momentumLeak = false;
  const errors = await collectConsoleErrors(page, async () => {
    await page.goto(BASE);
    await openCratesView(page, true);

    const cx = 187, cy = 406;

    // Hard fling
    await fling(page, cx, cy, 360, 6);

    // Immediately switch to Tracks while momentum is running
    await page.waitForTimeout(20);
    await openTracksView(page, true);
    await page.waitForTimeout(300);

    // Check that surface transform is no longer changing
    const t1 = await page.evaluate(() => document.getElementById('crates-surface').style.transform);
    await page.waitForTimeout(200);
    const t2 = await page.evaluate(() => document.getElementById('crates-surface').style.transform);

    if (t1 !== t2) {
      momentumLeak = true;
      console.warn(`  BUG 4 CONFIRMED: surface changing while crates hidden:\n    before: ${t1}\n    after:  ${t2}`);
    } else {
      console.log(`  No momentum leak (transform stable: ${t1.substring(0, 50)}...)`);
    }
  });
  await ctx.close();
  if (errors.length) { console.error('  FAIL (errors):', errors); return false; }
  if (momentumLeak) { console.log('  FAIL: Bug 4 — momentum leaks after tab switch'); return false; }
  console.log('  PASS');
  return true;
}

async function testTouchstartCapturesCorrectPanStart(browser) {
  // Bug 3: touchPanStartX = panX (stale) instead of targetPanX.
  // Scenario: fling sets targetPanX=240 (rAF pending), touchstart before rAF fires,
  // then drag 50px. Without fix: targetPanX = 0+50 = 50 (snaps back toward origin).
  // With fix: targetPanX = 240+50 = 290 (stays near fling position).
  console.log('\n[TEST] Mobile: new touch after fling uses correct pan start (Bug 3 check)');
  const ctx = await browser.newContext({ viewport: MOBILE_VIEWPORT, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  let snapDetected = false;
  const errors = await collectConsoleErrors(page, async () => {
    await page.goto(BASE);
    await openCratesView(page, true);

    const cx = 187, cy = 406;

    // Fling right to set targetPanX=240 (rAF pending, panX still 0 or less)
    await fling(page, cx, cy, 240, 6);

    // Read targetPanX before touchstart (via a hack — evaluate after rAF settles 1 tick)
    // We want to know what targetPanX is so we can compare after the drag
    const targetPanAtFling = await page.evaluate(() => {
      const t = document.getElementById('crates-surface').style.transform;
      const m = t.match(/translate3d\(([^,]+)px/);
      return m ? parseFloat(m[1]) : 0;
    });

    // Wait for momentum to fully settle so we have a stable reference point
    await page.waitForTimeout(600);
    const settledPan = await page.evaluate(() => {
      const t = document.getElementById('crates-surface').style.transform;
      const m = t.match(/translate3d\(([^,]+)px/);
      return m ? parseFloat(m[1]) : 0;
    });
    console.log(`  Pan after fling settles: ${settledPan.toFixed(1)}px`);

    // Now do a second fling to advance the position further
    await fling(page, cx, cy, 240, 6);

    // Read targetPanX just after this fling (before rAF fires)
    // This is the scenario: targetPanX is ahead of rendered panX
    const panAfterSecondFling = await page.evaluate(() => {
      const t = document.getElementById('crates-surface').style.transform;
      const m = t.match(/translate3d\(([^,]+)px/);
      return m ? parseFloat(m[1]) : 0;
    });

    // Start a new touch IMMEDIATELY — this is the stale panX window
    await simulateTouch(page, 'touchstart', [{ id: 1, x: cx, y: cy }]);

    // Drag 50px (> DRAG_THRESHOLD=5) to trigger the position update
    for (let s = 1; s <= 5; s++) {
      await simulateTouch(page, 'touchmove', [{ id: 1, x: cx + 10 * s, y: cy }]);
    }

    await page.waitForTimeout(100); // let rAF fire

    const panAfterDrag = await page.evaluate(() => {
      const t = document.getElementById('crates-surface').style.transform;
      const m = t.match(/translate3d\(([^,]+)px/);
      return m ? parseFloat(m[1]) : 0;
    });
    await simulateTouch(page, 'touchend', []);

    console.log(`  Pan after 2nd fling (pre-rAF): ${panAfterSecondFling.toFixed(1)}px`);
    console.log(`  Pan after 50px drag: ${panAfterDrag.toFixed(1)}px`);
    console.log(`  Drag moved pan by: ${(panAfterDrag - panAfterSecondFling).toFixed(1)}px`);

    // With fix: drag from correct touchPanStartX=targetPanX → final ≈ targetPanX + 50
    // Without fix: drag from stale panX → final may be near panX+50 (much less than targetPanX+50)
    // We check that the pan moved forward (positive direction) relative to the pre-rAF position
    // If it snapped backward substantially, that's Bug 3.
    const snapBack = panAfterDrag < panAfterSecondFling - 100;
    if (snapBack) {
      snapDetected = true;
      console.warn(`  BUG 3 CONFIRMED: pan snapped from ${panAfterSecondFling.toFixed(0)} back to ${panAfterDrag.toFixed(0)}`);
    }

    await page.waitForTimeout(200);
  });
  await ctx.close();
  if (errors.length) { console.error('  FAIL (errors):', errors); return false; }
  if (snapDetected) { console.log('  FAIL: Bug 3 — stale panX on touchstart causes snap-back'); return false; }
  console.log('  PASS');
  return true;
}

async function testPinchStartScaleUsesStaleCrateScale(browser) {
  // Bug 5: pinchStartScale = crateScale (stale) instead of targetScale
  console.log('\n[TEST] Mobile: second pinch uses correct startScale (Bug 5 check)');
  const ctx = await browser.newContext({ viewport: MOBILE_VIEWPORT, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  let scaleSnapDetected = false;
  const errors = await collectConsoleErrors(page, async () => {
    await page.goto(BASE);
    await openCratesView(page, true);

    const cx = 187, cy = 406;

    // First pinch — scale from 0.75 to ~1.5
    await page.evaluate(({ cx, cy }) => {
      const el = document.getElementById('crates-view');
      const t1 = new Touch({ identifier: 1, target: el, clientX: cx - 40, clientY: cy, radiusX: 1, radiusY: 1, rotationAngle: 0, force: 1 });
      const t2 = new Touch({ identifier: 2, target: el, clientX: cx + 40, clientY: cy, radiusX: 1, radiusY: 1, rotationAngle: 0, force: 1 });
      el.dispatchEvent(new TouchEvent('touchstart', {
        cancelable: true, bubbles: true,
        touches: [t1, t2], changedTouches: [t1, t2], targetTouches: [t1, t2]
      }));
    }, { cx, cy });

    // Pinch out a lot
    for (let s = 1; s <= 8; s++) {
      await page.evaluate(({ cx, cy, s }) => {
        const el = document.getElementById('crates-view');
        const spread = 40 + s * 12;
        const t1 = new Touch({ identifier: 1, target: el, clientX: cx - spread, clientY: cy, radiusX: 1, radiusY: 1, rotationAngle: 0, force: 1 });
        const t2 = new Touch({ identifier: 2, target: el, clientX: cx + spread, clientY: cy, radiusX: 1, radiusY: 1, rotationAngle: 0, force: 1 });
        el.dispatchEvent(new TouchEvent('touchmove', {
          cancelable: true, bubbles: true,
          touches: [t1, t2], changedTouches: [t1, t2], targetTouches: [t1, t2]
        }));
      }, { cx, cy, s });
      await page.waitForTimeout(16);
    }

    await page.evaluate(() => {
      const el = document.getElementById('crates-view');
      el.dispatchEvent(new TouchEvent('touchend', { cancelable: true, bubbles: true, touches: [], changedTouches: [], targetTouches: [] }));
    });

    // Get the scale after first pinch (targetScale is set, crateScale may lag)
    const scaleBefore = await page.evaluate(() => {
      const t = document.getElementById('crates-surface').style.transform;
      const m = t.match(/scale3d\(([^,]+)/);
      return m ? parseFloat(m[1]) : 1;
    });
    console.log(`  Scale after first pinch: ${scaleBefore.toFixed(3)}`);

    // Immediately start second pinch (crateScale may not equal targetScale yet)
    await page.evaluate(({ cx, cy }) => {
      const el = document.getElementById('crates-view');
      const t1 = new Touch({ identifier: 1, target: el, clientX: cx - 40, clientY: cy, radiusX: 1, radiusY: 1, rotationAngle: 0, force: 1 });
      const t2 = new Touch({ identifier: 2, target: el, clientX: cx + 40, clientY: cy, radiusX: 1, radiusY: 1, rotationAngle: 0, force: 1 });
      el.dispatchEvent(new TouchEvent('touchstart', {
        cancelable: true, bubbles: true,
        touches: [t1, t2], changedTouches: [t1, t2], targetTouches: [t1, t2]
      }));
    }, { cx, cy });

    // Just move 1px — should keep same scale, not snap
    await page.evaluate(({ cx, cy }) => {
      const el = document.getElementById('crates-view');
      const t1 = new Touch({ identifier: 1, target: el, clientX: cx - 41, clientY: cy, radiusX: 1, radiusY: 1, rotationAngle: 0, force: 1 });
      const t2 = new Touch({ identifier: 2, target: el, clientX: cx + 41, clientY: cy, radiusX: 1, radiusY: 1, rotationAngle: 0, force: 1 });
      el.dispatchEvent(new TouchEvent('touchmove', {
        cancelable: true, bubbles: true,
        touches: [t1, t2], changedTouches: [t1, t2], targetTouches: [t1, t2]
      }));
    }, { cx, cy });

    await page.waitForTimeout(50);

    const scaleAfter = await page.evaluate(() => {
      const t = document.getElementById('crates-surface').style.transform;
      const m = t.match(/scale3d\(([^,]+)/);
      return m ? parseFloat(m[1]) : 1;
    });
    console.log(`  Scale after 2nd pinch tiny move: ${scaleAfter.toFixed(3)}`);

    const scaleDelta = Math.abs(scaleAfter - scaleBefore);
    if (scaleDelta > 0.1) {
      scaleSnapDetected = true;
      console.warn(`  BUG 5 CONFIRMED: scale snapped by ${scaleDelta.toFixed(3)} on 2nd pinch start (pinchStartScale = crateScale uses stale value)`);
    }

    await page.evaluate(() => {
      const el = document.getElementById('crates-view');
      el.dispatchEvent(new TouchEvent('touchend', { cancelable: true, bubbles: true, touches: [], changedTouches: [], targetTouches: [] }));
    });
    await page.waitForTimeout(200);
  });
  await ctx.close();
  if (errors.length) { console.error('  FAIL (errors):', errors); return false; }
  if (scaleSnapDetected) { console.log('  FAIL: Bug 5 — pinchStartScale uses stale crateScale'); return false; }
  console.log('  PASS');
  return true;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  const browser = await chromium.launch({ headless: true });
  const results = [];

  const run = async (fn) => {
    try {
      const pass = await fn(browser);
      results.push({ name: fn.name, pass });
    } catch (e) {
      console.error(`  EXCEPTION in ${fn.name}:`, e.message);
      results.push({ name: fn.name, pass: false, error: e.message });
    }
  };

  // Desktop
  await run(testDesktopDragPan);
  await run(testDesktopWheelPan);
  await run(testMousedownAfterWheel);
  await run(testRapidTabSwitching);
  await run(testCratesWheelFarThenBack);
  await run(testClickStackThenBackToCrates);
  await run(testNullPageElGuard);

  // Mobile
  await run(testMobileRapidPan);
  await run(testMobileFlingThenImmediateTap);
  await run(testMobileFlingReversal);
  await run(testMobilePinchDuringMomentum);
  await run(testMobileFarPanMountUnmountRemount);
  await run(testMobileRapidTabSwitching);
  await run(testMobileFlingDuringTabSwitch);
  await run(testTouchstartCapturesCorrectPanStart);
  await run(testPinchStartScaleUsesStaleCrateScale);

  await browser.close();

  console.log('\n══════════════════════════════════════');
  console.log('RESULTS:');
  let passed = 0, failed = 0;
  results.forEach(r => {
    const icon = r.pass ? '✓' : '✗';
    console.log(`  ${icon} ${r.name}${r.error ? ': ' + r.error.split('\n')[0] : ''}`);
    r.pass ? passed++ : failed++;
  });
  console.log(`\n${passed} passed, ${failed} failed out of ${results.length} total`);
  process.exit(failed > 0 ? 1 : 0);
})();
