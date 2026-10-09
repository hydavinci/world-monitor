import { expect, test, type Page } from '@playwright/test';

async function addPublicPanel(page: Page): Promise<void> {
  await page.locator('#panelsGrid .add-panel-block').click();
  const toggle = page.locator('#usPanelToggles .panel-toggle-item[data-panel="strategic-risk"]');
  await expect(toggle).not.toHaveClass(/\bactive\b/);
  await toggle.click();
  await page.locator('.panels-save-layout').click();
  await page.locator('.unified-settings-close').click();
  await expect(page.locator('#panelsGrid [data-panel="strategic-risk"]')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('__workspace_test_seeded__')) return;
    sessionStorage.setItem('__workspace_test_seeded__', '1');
    localStorage.clear();
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
  });
});

test('Main fills the content area with Global Situation only', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page.getByRole('tab', { name: 'Main', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#mapContainer')).toBeVisible();
  await expect(page.locator('#panelsGrid')).toBeHidden();
  await expect(page.locator('#mapWidthResizeHandle')).toBeHidden();
  await expect.poll(async () => {
    const main = await page.locator('#main').boundingBox();
    const map = await page.locator('#mapSection').boundingBox();
    return main && map
      ? Math.max(Math.abs(main.width - map.width), Math.abs(main.height - map.height))
      : Infinity;
  }).toBeLessThanOrEqual(2);
  const controlledId = await page.getByRole('tab', { name: 'Main', exact: true }).getAttribute('aria-controls');
  await expect(page.locator(`#${controlledId}`)).toBeVisible();
});

test('Add Panel stays in its own final row after tall panels and viewport changes', async ({ page }, testInfo) => {
  await page.goto('/dashboard');
  await page.locator('.dashboard-tab-add').click();
  await addPublicPanel(page);
  await page.locator('#panelsGrid .add-panel-block').click();
  for (const key of ['live-news', 'cii', 'strategic-posture']) {
    const toggle = page.locator(`#usPanelToggles .panel-toggle-item[data-panel="${key}"]`);
    if (!await toggle.evaluate(element => element.classList.contains('active'))) await toggle.click();
  }
  await page.locator('.panels-save-layout').click();
  await page.locator('.unified-settings-close').click();
  for (const width of [1920, 1280, 600, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.locator('#panelsGrid').evaluate(grid => {
      const add = grid.querySelector<HTMLElement>('.add-panel-block');
      if (!add) throw new Error('Add Panel block missing');
      const panels = Array.from(grid.querySelectorAll<HTMLElement>(':scope > [data-panel]'))
        .map(panel => panel.getBoundingClientRect())
        .filter(rect => rect.width > 0 && rect.height > 0);
      if (panels.length < 4) throw new Error('Expected tall workspace panels missing');
      const rect = add.getBoundingClientRect();
      const styles = getComputedStyle(grid);
      const innerWidth = grid.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight);
      return Math.max(
        Math.max(...panels.map(panel => panel.bottom)) - rect.top,
        Math.abs(innerWidth - rect.width),
      );
    })).toBeLessThanOrEqual(0.5);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  const add = page.locator('#panelsGrid .add-panel-block');
  await add.scrollIntoViewIfNeeded();
  await expect(add).toHaveCSS('grid-column-start', '1');
  await expect(add).toHaveCSS('grid-column-end', '-1');
  await page.screenshot({ path: testInfo.outputPath('add-panel-final-row.png') });
  await add.click();
  await expect(page.locator('#usPanelToggles')).toBeVisible();
});

test('new tabs start empty, retain added panels and return to the same map', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page.locator('#mapContainer')).toBeVisible();
  await page.locator('#mapContainer').evaluate(element => element.dataset.workspaceMap = 'original');
  await page.locator('.dashboard-tab-add').click();
  await expect(page.getByRole('tab', { name: 'New Tab', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#mapSection')).toBeHidden();
  await expect(page.locator('#main .panel:visible')).toHaveCount(0);
  await expect(page.locator('#panelsGrid .add-panel-block')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('tab', { name: 'New Tab', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#mapSection')).toBeHidden();
  await expect(page.locator('#main .panel:visible')).toHaveCount(0);
  await addPublicPanel(page);
  await page.reload();
  await expect(page.locator('#panelsGrid [data-panel="strategic-risk"]')).toBeVisible();
  await expect(page.locator('#mapSection')).toBeHidden();
  await page.getByRole('tab', { name: 'Main', exact: true }).click();
  await expect(page.locator('#mapContainer')).toBeVisible();
  await expect(page.locator('#panelsGrid')).toBeHidden();
  await page.locator('#mapContainer .time-btn[data-range="6h"]').click();
  await page.locator('#mapContainer').evaluate(element => element.dataset.workspaceMap = 'retained');
  await page.getByRole('tab', { name: 'New Tab', exact: true }).click();
  await expect(page.locator('#panelsGrid [data-panel="strategic-risk"]')).toBeVisible();
  await expect(page.locator('#mapSection')).toBeHidden();
  await page.getByRole('tab', { name: 'Main', exact: true }).click();
  await expect(page.locator('#mapContainer')).toHaveAttribute('data-workspace-map', 'retained');
  await expect(page.locator('#mapContainer .time-btn[data-range="6h"]')).toHaveClass(/\bactive\b/);
  await page.getByRole('tab', { name: 'New Tab', exact: true }).click();
  await page.reload();
  await expect(page.locator('#panelsGrid [data-panel="strategic-risk"]')).toBeVisible();
  await expect(page.locator('#mapSection')).toBeHidden();
});

test('Main fills the mobile content area and new tabs have no map', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/dashboard');
  await expect(page.locator('#mapContainer')).toBeVisible();
  await expect(page.locator('#panelsGrid')).toBeHidden();
  await expect.poll(async () => {
    const main = await page.locator('#main').boundingBox();
    const map = await page.locator('#mapSection').boundingBox();
    return main && map ? Math.abs(main.height - map.height) : Infinity;
  }).toBeLessThanOrEqual(2);
  await page.locator('.dashboard-tab-add').click();
  await expect(page.locator('#mapSection')).toBeHidden();
  await expect(page.locator('#panelsGrid .add-panel-block')).toBeVisible();
});

test('legacy tabs keep their saved custom layout when workspace roles are migrated', async ({ page }) => {
  await page.goto('/dashboard');
  await page.locator('.dashboard-tab-add').click();
  await addPublicPanel(page);
  await page.getByRole('tab', { name: 'Main', exact: true }).click();
  await page.getByRole('tab', { name: 'New Tab', exact: true }).click();
  const legacyTabs = await page.evaluate(() => {
    const key = 'worldmonitor-tabs-v1:full';
    const state = JSON.parse(localStorage.getItem(key)!);
    for (const tab of state.tabs) delete tab.view;
    localStorage.setItem(key, JSON.stringify(state));
    return state.tabs;
  });
  await page.reload();
  await expect(page.getByRole('tab', { name: 'New Tab', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#panelsGrid [data-panel="strategic-risk"]')).toBeVisible();
  const migratedTabs = await page.evaluate(() => JSON.parse(localStorage.getItem('worldmonitor-tabs-v1:full')!).tabs);
  expect(migratedTabs.map((tab: { view: string }) => tab.view)).toEqual(['map', 'panels']);
  expect(migratedTabs.map(({ view, ...tab }: { view: string }) => tab)).toEqual(legacyTabs);
  await page.getByRole('tab', { name: 'Main', exact: true }).click();
  await expect(page.locator('#mapContainer')).toBeVisible();
  await expect(page.locator('#panelsGrid')).toBeHidden();
});

test('deleting an active custom tab restores the full Main map', async ({ page }) => {
  await page.goto('/dashboard');
  await page.locator('.dashboard-tab-add').click();
  await addPublicPanel(page);
  await page.locator('.dashboard-tab.active .dashboard-tab-close').click();
  await expect(page.getByRole('tab', { name: 'Main', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#mapContainer')).toBeVisible();
  await expect(page.locator('#panelsGrid')).toBeHidden();
  await expect(page.locator('.dashboard-tab')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('#mapContainer')).toBeVisible();
  await expect(page.locator('#panelsGrid')).toBeHidden();
});

test('Main has no close button when custom tabs exist and remains protected after reload', async ({ page }) => {
  await page.goto('/dashboard');
  await page.locator('.dashboard-tab-add').click();
  const main = page.locator('.dashboard-tab').filter({
    has: page.getByRole('tab', { name: 'Main', exact: true }),
  });
  await expect(main.locator('.dashboard-tab-close')).toHaveCount(0);
  await expect(page.locator('.dashboard-tab.active .dashboard-tab-close')).toBeVisible();
  const guarded = await page.evaluate(async (moduleUrl) => {
    const { PanelLayoutManager } = await import(moduleUrl);
    const key = 'worldmonitor-tabs-v1:full';
    const stored = localStorage.getItem(key)!;
    const manager = Object.create(PanelLayoutManager.prototype);
    manager.tabsState = JSON.parse(stored);
    const mainId = manager.tabsState.tabs.find((tab: { id: string; view: string }) => tab.view === 'map')?.id;
    if (!mainId) throw new Error('Main map workspace missing');
    const receipt = manager.deleteTab(mainId);
    return {
      rejected: !receipt.persisted,
      unchanged: JSON.stringify(manager.tabsState) === stored,
      persistedUnchanged: localStorage.getItem(key) === stored,
    };
  }, '/src/app/panel-layout.ts');
  expect(guarded).toEqual({ rejected: true, unchanged: true, persistedUnchanged: true });
  await page.reload();
  await expect(main.locator('.dashboard-tab-close')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Main', exact: true }).click();
  await expect(main.locator('.dashboard-tab-close')).toHaveCount(0);
  await expect(page.locator('#mapContainer')).toBeVisible();
});
