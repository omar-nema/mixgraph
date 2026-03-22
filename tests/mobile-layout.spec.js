import { test, expect } from '@playwright/test';

const BASE_URL = 'http://localhost:8000';

const phones = [
  { name: 'iPhone-14-Pro', width: 393, height: 852 },
  { name: 'iPhone-SE',     width: 375, height: 667 },
];

for (const phone of phones) {
  test(`mobile layout — ${phone.name}`, async ({ page }) => {
    await page.setViewportSize({ width: phone.width, height: phone.height });
    await page.goto(BASE_URL);

    // Wait for the carousel to populate with tracks
    await page.waitForSelector('#mobile-carousel .mobile-carousel-item', { timeout: 15000 });

    // Mode tabs visible at top
    const modeTabs = page.locator('#mobile-mode-tabs');
    await expect(modeTabs).toBeVisible();
    const tabsBox = await modeTabs.boundingBox();
    expect(tabsBox.y).toBeLessThan(60);

    // Active tab has bright blue background (visual check via class)
    await expect(page.locator('#mobile-mode-tabs .mode-tab.active')).toBeVisible();

    // SC player area visible at bottom
    const player = page.locator('#sc-player-area');
    await expect(player).toBeVisible();
    const playerBox = await player.boundingBox();
    // Player bottom should be at or near the viewport bottom
    expect(playerBox.y + playerBox.height).toBeGreaterThan(phone.height - 10);

    // Full content block (shuffle area + carousel + sources) should be
    // vertically centered in the space between tabs and player
    const shuffleBox = await page.locator('#mobile-shuffle-area').boundingBox();
    const sourcesBox = await page.locator('#mobile-sources').boundingBox();

    const contentTop    = shuffleBox.y;
    const contentBottom = sourcesBox.y + sourcesBox.height;
    const contentMid    = (contentTop + contentBottom) / 2;

    const headerBottom  = tabsBox.y + tabsBox.height;
    const playerTop     = playerBox.y;
    const availableMid  = headerBottom + (playerTop - headerBottom) / 2;

    // Content midpoint should be within 80px of the available center
    const offset = Math.abs(contentMid - availableMid);
    expect(offset).toBeLessThan(80);

    // Screenshot for visual confirmation
    await page.screenshot({
      path: `tests/screenshots/mobile-layout-${phone.name}.png`,
      fullPage: false,
    });
  });
}
