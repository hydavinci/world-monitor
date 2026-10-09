import { test, expect, type Page } from '@playwright/test';

async function choosePublicWorkspace(page: Page): Promise<void> {
  await page.locator('.dashboard-tab-add').click();
  await page.getByRole('button', { name: /Mission/i }).first().click();
  await page.getByRole('button', { name: /Crisis Desk/ }).click();
  await expect(page.locator('#panelsGrid .panel').first()).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('__anonymous_mode_seeded__')) return;
    sessionStorage.setItem('__anonymous_mode_seeded__', '1');
    localStorage.clear();
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
    localStorage.setItem('worldmonitor-theme', 'light');
  });
});

test('anonymous dashboard keeps public controls without account or upgrade entry points', async ({ page }, testInfo) => {
  const accountRequests: string[] = [];
  page.on('request', request => {
    const url = request.url();
    if (/clerk\.accounts|clerk\.com|\/api\/(?:user-prefs|cloud-prefs|billing|account)(?:[/?]|$)/.test(url)) {
      accountRequests.push(url);
    }
  });
  await page.goto('/dashboard');
  await choosePublicWorkspace(page);
  await expect(page.locator('#unifiedSettingsBtn')).toBeVisible();
  await expect(page.locator('#mapContainer')).toBeVisible();
  await expect(page.locator('#panelsGrid .panel').first()).toBeVisible();
  await expect(page.locator('#authWidgetMount, .auth-header-widget, .pro-banner, #proBannerSlot')).toHaveCount(0);
  await expect(page.locator('html')).not.toHaveClass(/wm-pro-banner-reserved/);
  await expect(page.locator('#mapContainer.deckgl-mode:not([aria-busy]), #mapContainer.globe-mode:not([aria-busy]), #mapContainer.svg-mode:not([aria-busy])')).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: testInfo.outputPath('anonymous-dashboard.png') });
  await page.locator('#unifiedSettingsBtn').click();
  await expect(page.locator('#unifiedSettingsModal')).toHaveClass(/active/);
  await expect(page.locator('#us-tab-settings')).toBeVisible();
  await expect(page.locator('#us-tab-panels')).toBeVisible();
  await expect(page.locator('#us-tab-sources')).toBeVisible();
  await expect(page.locator('#us-tab-api-keys, #us-tab-billing, #us-tab-notifications, #us-tab-embeds, #us-tab-mcp-clients')).toHaveCount(0);
  await page.locator('#us-tab-panels').click();
  await expect(page.locator('#usPanelToggles')).toBeVisible();
  await expect(page.locator('#usPanelToggles [data-panel="stock-analysis"], #usPanelToggles [data-panel="chat-analyst"]')).toHaveCount(0);
  await expect(page.locator('.pro-locked, .pro-preview-section, a[href*="/pro"]')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('anonymous-settings.png') });
  expect(accountRequests).toEqual([]);
});

test('mobile menu retains navigation without an account row', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/dashboard');
  await expect(page.locator('#mobileTabBar')).toBeVisible();
  await page.locator('[data-mobile-tab="more"]').click();
  await expect(page.locator('#mobileMenu')).toHaveClass(/open/);
  await expect(page.locator('.mobile-menu-account, #mobileAuthWidgetMount, #mobileAuthFallback')).toHaveCount(0);
  await expect(page.locator('#mobileMenuTheme')).toBeVisible();
  await expect.poll(() => page.locator('#mobileMenu').evaluate(element => Math.round(element.getBoundingClientRect().left))).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('anonymous-mobile-menu.png') });
});

test('public panel preferences still save locally and survive reload', async ({ page }) => {
  await page.goto('/dashboard');
  await choosePublicWorkspace(page);
  await expect(page.locator('#panelsGrid .panel').first()).toBeVisible();
  const panelId = await page.locator('#panelsGrid .panel').first().getAttribute('data-panel');
  expect(panelId).toBeTruthy();
  await page.locator('#unifiedSettingsBtn').click();
  await page.locator('#us-tab-panels').click();
  const toggle = page.locator(`#usPanelToggles .panel-toggle-item[data-panel="${panelId}"]`);
  await expect(toggle).toHaveClass(/\bactive\b/);
  await expect(page.locator(`#panelsGrid .panel[data-panel="${panelId}"]`)).toHaveCount(1);
  await toggle.click();
  await page.locator('.panels-save-layout').click();
  await page.locator('.unified-settings-close').click();
  await expect(page.locator(`#panelsGrid .panel[data-panel="${panelId}"]`)).toBeHidden();
  await expect.poll(() => page.evaluate(id => {
    const panels = JSON.parse(localStorage.getItem('worldmonitor-panels') ?? '{}');
    return panels[id!]?.enabled;
  }, panelId)).toBe(false);
  await page.reload();
  await expect(page.locator('#panelsGrid .panel').first()).toBeVisible();
  await page.locator('#unifiedSettingsBtn').click();
  await page.locator('#us-tab-panels').click();
  await expect(page.locator(`#usPanelToggles .panel-toggle-item[data-panel="${panelId}"]`)).not.toHaveClass(/\bactive\b/);
});

test('dashboard has no footer reservation and retains map source credits', async ({ page }, testInfo) => {
  await page.goto('/dashboard');
  await choosePublicWorkspace(page);
  await expect(page.locator('.header[role="banner"]')).toBeVisible();
  await expect(page.locator('.site-footer, #footerDownloadMount, .digest-coverage-row')).toHaveCount(0);
  await expect(page.locator('#mapContainer .map-attribution a[href*="openstreetmap.org"]')).toBeVisible();
  await expect(page.locator('#mapContainer .map-attribution a[href*="openfreemap.org"]')).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const app = document.getElementById('app')!;
    const main = document.getElementById('main')!;
    const style = getComputedStyle(main);
    return {
      viewportGap: Math.round(window.innerHeight - main.getBoundingClientRect().bottom),
      appGap: Math.round(app.getBoundingClientRect().bottom - main.getBoundingClientRect().bottom),
      bottomPadding: parseFloat(style.paddingBottom),
      bottomMargin: parseFloat(style.marginBottom),
    };
  })).toEqual({ viewportGap: 0, appGap: 0, bottomPadding: 0, bottomMargin: 0 });
  await page.screenshot({ path: testInfo.outputPath('footer-free-dashboard.png') });
});

test('personal dashboard omits version and author displays while keeping functional controls', async ({ page }) => {
  await page.setViewportSize({ width: 2000, height: 1000 });
  await page.goto('/dashboard');
  await expect(page.locator('#mapContainer')).toBeVisible();
  await expect(page.locator('.header .version, .header .credit-link')).toHaveCount(0);
  await expect(page.locator('.header .logo')).toBeVisible();
  await expect(page.locator('.header .github-link')).toHaveCount(0);
  await expect(page.locator('#mapDimensionToggle')).toBeVisible();
  await expect(page.locator('#mapContainer .map-attribution a[href*="openstreetmap.org"]')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-mobile-tab="more"]').click();
  await expect(page.locator('#mobileMenu')).toHaveClass(/open/);
  await expect(page.locator('#mobileMenu .mobile-menu-version, #mobileMenu a[href*="x.com/eliehabib"]')).toHaveCount(0);
  await expect(page.locator('#mobileMenuTheme')).toBeVisible();
});

for (const mode of ['2D', '3D'] as const) {
  test(`${mode} layer controls omit author badges without removing layer toggles`, async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.locator('#mapContainer .deckgl-layer-toggles')).toBeVisible();
    if (mode === '3D') {
      await page.locator('#mapDimensionToggle [data-mode="globe"]').click();
      await expect(page.locator('#mapContainer')).toHaveClass(/globe-mode/);
      await expect(page.locator('#mapContainer .globe-beta-badge')).toHaveCount(0);
      await expect.poll(async () => {
        const controls = await page.locator('#mapContainer .deckgl-controls').boundingBox();
        const zoom = await page.locator('#mapContainer .zoom-controls').boundingBox();
        return controls && zoom ? Math.abs(zoom.y - controls.y) : Infinity;
      }).toBeLessThanOrEqual(1);
    }
    await expect(page.locator('#mapContainer .deckgl-layer-toggles')).toBeVisible();
    await expect(page.locator('#mapContainer .layer-toggle input')).not.toHaveCount(0);
    await expect(page.locator('#mapContainer .map-author-badge')).toHaveCount(0);
  });
}

test('personal dashboard removes promotion but retains variants, Link, Embed and Mission', async ({ page }) => {
  await page.setViewportSize({ width: 2000, height: 1000 });
  await page.goto('/dashboard');
  await expect(page.locator('#mapContainer')).toBeVisible();
  await expect(page.locator('.github-link, #downloadBtn, #downloadDropdown')).toHaveCount(0);
  await expect(page.locator('.variant-switcher')).toBeVisible();
  await expect(page.locator('#copyLinkBtn')).toBeVisible();
  await expect(page.locator('#embedLinkBtn')).toBeVisible();
  await expect(page.getByRole('button', { name: /Mission/i }).first()).toBeVisible();
  await page.locator('#embedLinkBtn').click();
  await expect(page.locator('#embedModalOverlay')).toBeVisible();
  await page.reload();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-mobile-tab="more"]').click();
  await expect(page.locator('#mobileMenu')).toHaveClass(/open/);
  await expect(page.locator('#mobileMenu a[href*="/blog"], #mobileMenu a[href*="/docs"], #mobileMenu a[href*="status.worldmonitor"]')).toHaveCount(0);
  await expect(page.locator('#mobileMenu .mobile-menu-variant')).not.toHaveCount(0);
  await expect(page.locator('#mobileMenuMission')).toBeVisible();
});

test('personal interactions never emit events to an ambient external tracker', async ({ page }) => {
  await page.addInitScript(() => {
    const events: string[] = [];
    const record = (event: string) => {
      events.push(event);
      sessionStorage.setItem('__external_tracker_events__', JSON.stringify(events));
    };
    Object.defineProperty(window, 'umami', {
      configurable: true,
      value: { track: record, identify: () => record('identify') },
    });

  });
  await page.goto('/dashboard');
  await choosePublicWorkspace(page);
  await page.locator('#unifiedSettingsBtn').click();
  await expect(page.locator('#unifiedSettingsModal')).toHaveClass(/active/);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('__external_tracker_events__') ?? '[]'))).toEqual([]);
});

test('same-origin service-worker updates retain a styled local reload notification', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page.locator('#mapContainer .deckgl-layer-toggles')).toBeVisible({ timeout: 20_000 });
  await page.evaluate(() => {
    navigator.serviceWorker.dispatchEvent(new Event('controllerchange'));
    navigator.serviceWorker.dispatchEvent(new Event('controllerchange'));
  });
  const toast = page.locator('.update-toast.visible');
  await expect(toast).toBeVisible();
  await expect(toast.locator('[data-action="reload"]')).toHaveText('Reload');
  await expect.poll(() => toast.evaluate(element => getComputedStyle(element).position)).toBe('fixed');
  await expect.poll(() => toast.evaluate(element => window.innerWidth - element.getBoundingClientRect().right)).toBe(16);
  await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
  await expect.poll(() => toast.evaluate(element => element.getBoundingClientRect().left)).toBe(16);
  await toast.locator('[data-action="dismiss"]').click();
  await expect(toast).toHaveCount(0);
});

test('retained dashboard modules are cleaned up when the app is destroyed', async ({ page }) => {
  await page.goto('/dashboard');
  const destroyed = await page.evaluate(async (moduleUrl) => {
    const { App } = await import(moduleUrl);
    const container = document.createElement('div');
    container.id = 'teardown-regression-root';
    document.body.appendChild(container);
    const app = new App(container.id);
    const calls: string[] = [];
    for (const name of ['panelLayout', 'countryIntel', 'dataLoader', 'refreshScheduler', 'eventHandlers']) {
      const manager = app[name];
      const destroy = manager.destroy.bind(manager);
      manager.destroy = () => {
        calls.push(name);
        destroy();
      };
    }
    try {
      app.destroy();
    } finally {
      container.remove();
    }
    return calls;
  }, '/src/App.ts');
  expect(destroyed).toEqual(['eventHandlers', 'refreshScheduler', 'dataLoader', 'countryIntel', 'panelLayout']);
});
