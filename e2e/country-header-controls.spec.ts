import { expect, test, type Locator } from '@playwright/test';

async function expectSeparateControls(panel: Locator): Promise<void> {
  await expect.poll(() => panel.evaluate(element => {
    const controls = ['.cdp-share-btn', '.cdp-maximize-btn', '.panel-close']
      .map(selector => {
        const button = element.querySelector<HTMLButtonElement>(selector);
        if (!button) throw new Error(`Country header control missing: ${selector}`);
        return button.getBoundingClientRect();
      });
    let largestIntersection = 0;
    for (let i = 0; i < controls.length; i++) {
      for (let j = i + 1; j < controls.length; j++) {
        const a = controls[i]!;
        const b = controls[j]!;
        const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
        const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        largestIntersection = Math.max(largestIntersection, width * height);
      }
    }
    return largestIntersection;
  })).toBe(0);
}

for (const width of [1280, 600, 390]) {
  test(`country header controls do not overlap at ${width}px and remain usable`, async ({ page, context }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.addInitScript(() => {
      localStorage.clear();
      localStorage.setItem('wm-layer-warning-dismissed', 'true');
      localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
    });
    await page.goto('/dashboard?country=CA&expanded=1');
    const panel = page.locator('#country-deep-dive-panel');
    await expect(panel).toHaveAttribute('aria-hidden', 'false');
    await expect(panel.locator('.cdp-country-name')).toHaveText('Canada');
    await expect(panel).toHaveClass(/\bmaximized\b/);
    await expectSeparateControls(panel);
    await panel.locator('.cdp-maximize-btn').click();
    await expect(panel).not.toHaveClass(/\bmaximized\b/);
    await expectSeparateControls(panel);
    await page.evaluate(() => navigator.clipboard.writeText('country-control-test'));
    await panel.locator('.cdp-share-btn').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(new URL('/dashboard?c=CA', page.url()).href);
    await panel.locator('.cdp-maximize-btn').click();
    await expect(panel).toHaveClass(/\bmaximized\b/);
    await expectSeparateControls(panel);
    await page.screenshot({ path: testInfo.outputPath(`country-header-${width}px.png`) });
    await panel.locator('.cdp-maximize-btn').click();
    await expect(panel).not.toHaveClass(/\bmaximized\b/);
    await expectSeparateControls(panel);
    await panel.locator('.panel-close').click();
    await expect(panel).toHaveAttribute('aria-hidden', 'true');
  });
}
