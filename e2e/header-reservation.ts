import { expect, type Page } from '@playwright/test';

type Box = {
  height: number;
  width: number;
  x: number;
  y: number;
};

const waitForLayoutFrame = async (page: Page): Promise<void> => {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
};

const expectBoxesToMatch = (actual: Box, expected: Box, message: string): void => {
  expect(Math.abs(actual.x - expected.x), `${message} x`).toBeLessThanOrEqual(1);
  expect(Math.abs(actual.y - expected.y), `${message} y`).toBeLessThanOrEqual(1);
  expect(Math.abs(actual.width - expected.width), `${message} width`).toBeLessThanOrEqual(1);
  expect(Math.abs(actual.height - expected.height), `${message} height`).toBeLessThanOrEqual(1);
};

export const assertPublicHeaderKeepsLayoutStable = async (page: Page): Promise<void> => {
  await expect(page.locator('.header')).toBeVisible();
  await expect(page.locator('#unifiedSettingsBtn')).toBeVisible();
  await expect(page.locator('#authWidgetMount, .auth-header-widget, .auth-signin-btn')).toHaveCount(0);

  const measure = async () => page.evaluate(() => {
    const header = document.querySelector<HTMLElement>('.header');
    const settings = document.getElementById('unifiedSettingsBtn');
    if (!header || !settings) throw new Error('missing public header controls');
    const rectOf = (element: Element): Box => {
      const rect = element.getBoundingClientRect();
      return { height: rect.height, width: rect.width, x: rect.x, y: rect.y };
    };
    return { header: rectOf(header), settings: rectOf(settings) };
  });

  await waitForLayoutFrame(page);
  const before = await measure();
  await page.locator('#unifiedSettingsBtn').click();
  await expect(page.locator('#unifiedSettingsModal.active')).toBeVisible();
  await waitForLayoutFrame(page);
  const whileOpen = await measure();
  expectBoxesToMatch(whileOpen.header, before.header, 'public header while settings is open');
  expectBoxesToMatch(whileOpen.settings, before.settings, 'settings control while settings is open');
  await page.locator('#unifiedSettingsModal .unified-settings-close').click();
  await expect(page.locator('#unifiedSettingsModal')).toBeHidden();
  await waitForLayoutFrame(page);
  const after = await measure();

  expectBoxesToMatch(after.header, before.header, 'public header');
  expectBoxesToMatch(after.settings, before.settings, 'settings control');
};
