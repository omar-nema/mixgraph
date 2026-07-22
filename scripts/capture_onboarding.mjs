// Regenerate the onboarding screenshots into img/.
// 8 assets: {dig,shuffle} x {desktop,mobile} x {light,dark}.
// Run the static dev server first (python3 scripts/serve.py), then:
//   node scripts/capture_onboarding.mjs
import { chromium } from 'playwright';

const OUT = new URL('../img/', import.meta.url).pathname;
const BASE = 'http://localhost:8000';
const browser = await chromium.launch();

// suffix: '' for light, '-dark' for dark
async function shot(file, { path, waitSel, scheme, viewport, mobile = false, clipH = null, extraWait = 3800 }) {
  // Desktop shots display ~540px wide, so 1x (1400px) is already >2x density — keep them light.
  // Mobile crops stay 2x for retina phones.
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, colorScheme: scheme });
  const page = await ctx.newPage();
  await page.goto(`${BASE}${path}?noplay`, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  try { await page.waitForSelector(waitSel, { timeout: 20000 }); } catch {}
  await page.evaluate(() => document.querySelectorAll('.helper-toast').forEach(t => t.remove()));
  await page.waitForTimeout(extraWait);
  const opts = { path: `${OUT}${file}`, type: 'jpeg', quality: 82 };
  if (clipH) opts.clip = { x: 0, y: 0, width: viewport.width, height: clipH };
  await page.screenshot(opts);
  console.log('saved img/' + file);
  await ctx.close();
}

for (const [scheme, sfx] of [['light', ''], ['dark', '-dark']]) {
  // Desktop — full graph / grid
  await shot(`onboard-dig${sfx}.jpg`,     { path: '/dig',     waitSel: '#crates-surface > *', scheme, viewport: { width: 1400, height: 900 } });
  await shot(`onboard-shuffle${sfx}.jpg`, { path: '/shuffle', waitSel: '#nodes-layer > *',     scheme, viewport: { width: 1400, height: 900 }, extraWait: 4500 });
  // Mobile — dig cropped to a couple rows; shuffle full height so the SoundCloud player is in frame
  await shot(`onboard-dig-mobile${sfx}.jpg`,     { path: '/dig',     waitSel: '#crates-surface > *',                          scheme, viewport: { width: 390, height: 844 }, mobile: true, clipH: 630 });
  await shot(`onboard-shuffle-mobile${sfx}.jpg`, { path: '/shuffle', waitSel: '#mobile-shuffle-area .track-card, #mobile-shuffle-area > *', scheme, viewport: { width: 390, height: 844 }, mobile: true, clipH: 844, extraWait: 5000 });
}

await browser.close();
console.log('done');
