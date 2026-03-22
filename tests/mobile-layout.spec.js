import { test, expect } from '@playwright/test';

const BASE_URL = 'http://localhost:8001';

const phones = [
  { name: 'iPhone-14-Pro', width: 393, height: 852 },
  { name: 'iPhone-SE',     width: 375, height: 667 },
];

for (const phone of phones) {
  test(`mobile layout — ${phone.name}`, async ({ page }) => {
    await page.setViewportSize({ width: phone.width, height: phone.height });
    await page.goto(BASE_URL);

    // Wait for carousel to populate
    await page.waitForSelector('#mobile-carousel .mobile-carousel-item', { timeout: 15000 });

    // Measure gaps
    const gaps = await page.evaluate(() => {
      const modeTabs   = document.getElementById('mobile-mode-tabs');
      const shuffleArea = document.getElementById('mobile-shuffle-area');
      const sources    = document.getElementById('mobile-sources');
      const player     = document.getElementById('sc-player-area');
      const r = el => el.getBoundingClientRect();
      return {
        gapTop:    Math.round(r(shuffleArea).top - r(modeTabs).bottom),
        gapBottom: Math.round(r(player).top      - r(sources).bottom),
      };
    });

    console.log(`${phone.name} — gapTop: ${gaps.gapTop}px, gapBottom: ${gaps.gapBottom}px, diff: ${gaps.gapTop - gaps.gapBottom}px`);

    // Gaps must be equal within 2px
    expect(Math.abs(gaps.gapTop - gaps.gapBottom)).toBeLessThanOrEqual(2);

    // Basic structure checks
    await expect(page.locator('#mobile-mode-tabs')).toBeVisible();
    await expect(page.locator('#mobile-mode-tabs .mode-tab.active')).toBeVisible();
    await expect(page.locator('#sc-player-area')).toBeVisible();

    await page.screenshot({
      path: `tests/screenshots/mobile-layout-${phone.name}.png`,
      fullPage: false,
    });
  });
}
