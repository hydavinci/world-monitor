import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initTestI18n } from './helpers/i18n.mts';

beforeAll(initTestI18n);

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('footer-free dashboard shell', () => {
  it('renders the toolbar and main content without creating a dashboard footer', async () => {
    vi.stubGlobal('__APP_VERSION__', 'test');
    const { PanelLayoutManager } = await import('@/app/panel-layout');
    const container = document.createElement('div');
    container.id = 'app';
    document.body.appendChild(container);
    const manager = new PanelLayoutManager({
      container,
      isDesktopApp: false,
      isMobile: false,
      isDestroyed: false,
      panels: {},
      newsPanels: {},
      newsCategoryPanelKeys: new Map(),
      panelSettings: {},
      PANEL_ORDER_KEY: 'worldmonitor-test-order',
    } as any, {} as any);
    vi.spyOn(manager as any, 'createPanels').mockResolvedValue(undefined);
    try {
      await manager.renderLayout();
      expect(container.querySelector('.header[role="banner"]')).not.toBeNull();
      expect(container.querySelector('#main #mapContainer')).not.toBeNull();
      expect(container.querySelector('#main #panelsGrid')).not.toBeNull();
      expect(container.querySelector('footer, .site-footer, #footerDownloadMount, .digest-coverage-row')).toBeNull();
      expect(container.querySelector('#main')?.nextElementSibling?.id).toBe('mobileTabBar');
    } finally {
      manager.destroy();
    }
  });
});
