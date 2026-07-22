// Regenerate the onboarding screenshots (img/onboard-dig.jpg, img/onboard-shuffle.jpg).
// Run the static dev server first (python3 scripts/serve.py), then: node scripts/capture_onboarding.mjs
import { chromium } from 'playwright';

const OUT = new URL('../img/', import.meta.url).pathname;
const BASE = 'http://localhost:8000';
const browser = await chromium.launch();

async function shot(file, path, waitSel, extraWait = 3500) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}${path}?noplay`, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  try { await page.waitForSelector(waitSel, { timeout: 20000 }); } catch {}
  // Drop any helper toast so the shot is clean
  await page.evaluate(() => document.querySelectorAll('.helper-toast').forEach(t => t.remove()));
  await page.waitForTimeout(extraWait);
  await page.screenshot({ path: `${OUT}${file}`, type: 'jpeg', quality: 82 });
  console.log('saved img/' + file);
  await ctx.close();
}

await shot('onboard-dig.jpg', '/dig', '#crates-surface > *');
await shot('onboard-shuffle.jpg', '/shuffle', '#nodes-layer > *', 4500);
await browser.close();
console.log('done');
