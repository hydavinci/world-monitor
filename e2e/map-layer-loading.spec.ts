import { expect, test, type Locator } from '@playwright/test';

async function columns(row: Locator): Promise<number[]> {
  return row.evaluate(element => {
    const selectors = ['input', '.toggle-icon', '.toggle-label', '.layer-explain-btn'];
    return selectors.flatMap(selector => {
      const control = element.querySelector<HTMLElement>(selector);
      if (!control) throw new Error(`Layer control missing: ${selector}`);
      const bounds = control.getBoundingClientRect();
      return [bounds.x, bounds.y, bounds.width, bounds.height];
    });
  });
}

for (const mode of ['deck', 'globe'] as const) {
  test(`${mode} truncation counts do not shift explanation buttons`, async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      localStorage.clear();
      localStorage.setItem('wm-layer-warning-dismissed', 'true');
      localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
      localStorage.setItem('worldmonitor-theme', 'light');
    });
    await page.goto('/dashboard?layers=datacenters');
    await expect(page.locator('#mapContainer .deckgl-layer-toggles')).toBeVisible({ timeout: 30_000 });
    if (mode === 'globe') {
      await page.locator('#mapDimensionToggle [data-mode="globe"]').click();
      await expect(page.locator('#mapContainer')).toHaveClass(/globe-mode/);
    }
    const row = page.locator('.layer-toggle-row[data-layer="datacenters"]');
    await row.scrollIntoViewIfNeeded();
    const metrics = await page.evaluate(async ({ moduleUrl, mode }) => {
      const { renderLayerTruncationBadges } = await import(moduleUrl);
      const root = document.querySelector<HTMLElement>('#mapContainer .deckgl-layer-toggles');
      if (!root) throw new Error('Real map picker missing');
      const row = root.querySelector<HTMLElement>('.layer-toggle-row[data-layer="datacenters"]');
      if (!row) throw new Error('Datacenter control missing');
      const bounds = (selector: string) => {
        const element = row.querySelector<HTMLElement>(selector);
        if (!element) throw new Error(`Layer control missing: ${selector}`);
        return element.getBoundingClientRect();
      };
      renderLayerTruncationBadges(root, {}, mode === 'globe' ? 'rotate' : 'pan');
      const before = {
        explanation: bounds('.layer-explain-btn').x,
        checkbox: bounds('input').x,
        icon: bounds('.toggle-icon').x,
        label: bounds('.toggle-label').x,
      };
      const samples = [235, 12345].map(shown => {
        renderLayerTruncationBadges(root, { datacenters: { shown, total: 54321 } }, mode === 'globe' ? 'rotate' : 'pan');
        const explanation = bounds('.layer-explain-btn');
        const badge = bounds('.layer-truncation-count');
        return {
          displacement: Math.max(
            Math.abs(explanation.x - before.explanation),
            Math.abs(bounds('input').x - before.checkbox),
            Math.abs(bounds('.toggle-icon').x - before.icon),
            Math.abs(bounds('.toggle-label').x - before.label),
          ),
          separation: explanation.left - badge.right,
          centerDifference: Math.abs((badge.top + badge.height / 2) - (explanation.top + explanation.height / 2)),
          lastIsExplanation: row.lastElementChild?.classList.contains('layer-explain-btn'),
        };
      });
      return samples;
    }, { moduleUrl: '/src/utils/layer-truncation-badge.ts', mode });
    for (const metric of metrics) {
      expect(metric.displacement).toBeLessThanOrEqual(0.5);
      expect(metric.separation).toBeGreaterThanOrEqual(0);
      expect(metric.centerDifference).toBeLessThanOrEqual(0.5);
      expect(metric.lastIsExplanation).toBe(true);
    }
    const checkbox = row.locator('input');
    const checked = await checkbox.isChecked();
    await row.locator('.layer-truncation-count').click();
    expect(await checkbox.isChecked()).toBe(checked);
    await page.screenshot({ path: testInfo.outputPath(`${mode}-truncation-count-alignment.png`) });
  });

  test(`${mode} layer controls stay aligned while a real request loads`, async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      localStorage.clear();
      localStorage.setItem('wm-layer-warning-dismissed', 'true');
      localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
    });
    let release!: () => void;
    let requested!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { requested = resolve; });
    await page.route('**/api/maritime/v1/list-navigational-warnings*', route =>
      route.fulfill({ json: { warnings: [], dataAvailable: true } }));
    await page.route('**/api/infrastructure/v1/get-cable-health*', async route => {
      requested();
      await pending;
      await route.fulfill({ json: { generatedAt: Date.now(), cables: {} } });
    });
    try {
      await page.goto('/dashboard?layers=waterways');
      await expect(page.locator('#mapContainer .deckgl-layer-toggles')).toBeVisible({ timeout: 30_000 });
      if (mode === 'globe') {
        await page.locator('#mapDimensionToggle [data-mode="globe"]').click();
        await expect(page.locator('#mapContainer')).toHaveClass(/globe-mode/);
      }
      const row = page.locator('.layer-toggle-row[data-layer="cables"]');
      const checkbox = row.locator('input');
      await expect(checkbox).not.toBeChecked();
      await row.scrollIntoViewIfNeeded();
      const before = await columns(row);
      await checkbox.check();
      await entered;
      await expect(row.locator('.layer-toggle')).toHaveClass(/\b(?:loading|layer-loading)\b/);
      expect(await row.locator('.toggle-icon').evaluate(icon =>
        getComputedStyle(icon, '::after').content)).toContain('\u23f3');
      const during = await columns(row);
      expect(Math.max(...during.map((value, index) => Math.abs(value - before[index]!))))
        .toBeLessThanOrEqual(0.5);
      await page.screenshot({ path: testInfo.outputPath(`${mode}-loading-alignment.png`) });
      release();
      await expect(row.locator('.layer-toggle')).not.toHaveClass(/\b(?:loading|layer-loading)\b/);
      await expect(checkbox).toBeChecked();
      const after = await columns(row);
      expect(Math.max(...after.map((value, index) => Math.abs(value - before[index]!))))
        .toBeLessThanOrEqual(0.5);
    } finally {
      release();
    }
  });
}
