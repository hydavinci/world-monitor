import { expect, test } from '@playwright/test';

test('desktop dashboard has no footer or reserved bottom space', async ({ page }, testInfo) => {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#main')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('#unifiedSettingsBtn')).toBeVisible();
  await expect(page.locator('.site-footer')).toHaveCount(0);
  await expect(page.locator('.digest-coverage-row')).toHaveCount(0);
  const main = await page.locator('#main').boundingBox();
  expect(main).not.toBeNull();
  expect(Math.abs(main!.y + main!.height - page.viewportSize()!.height)).toBeLessThanOrEqual(2);
  await expect(page.locator('#mapContainer')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('dashboard-without-footer.png') });
});

test('mobile dashboard keeps its navigation but has no site footer', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#main')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('#mobileTabBar')).toBeVisible();
  await expect(page.locator('.site-footer')).toHaveCount(0);
  await expect(page.locator('.digest-coverage-row')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('mobile-without-footer.png') });
});
