import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addCountry, getFollowed, removeCountry } from '@/services/followed-countries';
import { loadTabsState } from '@/services/tab-store';
import { importSettings } from '@/utils/settings-persistence';
import { loadWidgets, saveWidget } from '@/services/widget-store';
import { getWebMcpAccessContext } from '@/app/webmcp-access';

vi.mock('@/services/runtime', () => ({ isDesktopRuntime: () => false }));

beforeEach(() => localStorage.clear());

const publicPanel = { name: 'Economic', enabled: false, priority: 2, fontScale: 1.2 };

describe('public preference boundaries', () => {
  it('sanitizes actual settings imports while retaining source and theme choices', async () => {
    const data = {
      'worldmonitor-panels': JSON.stringify({
        economic: { ...publicPanel, premium: 'locked', proGated: true },
        'stock-analysis': { name: 'Retired', enabled: true, priority: 1 },
      }),
      'worldmonitor-layers': JSON.stringify({ weather: true, ciiChoropleth: true, resilienceScore: true }),
      'worldmonitor-theme': 'light',
      'worldmonitor-disabled-feeds': '["BBC"]',
    };
    await importSettings(new File([JSON.stringify({ version: 1, data })], 'settings.json'));
    expect(JSON.parse(localStorage.getItem('worldmonitor-panels')!)).toEqual({ economic: publicPanel });
    expect(JSON.parse(localStorage.getItem('worldmonitor-layers')!)).toEqual({ weather: true, ciiChoropleth: true });
    expect(localStorage.getItem('worldmonitor-theme')).toBe('light');
    expect(localStorage.getItem('worldmonitor-disabled-feeds')).toBe('["BBC"]');
  });

  it('prunes retired panels from saved tab snapshots and ordering at load time', () => {
    localStorage.setItem('worldmonitor-tabs-v1:full', JSON.stringify({
      activeTabId: 'tab-abc-123',
      tabs: [{
        id: 'tab-abc-123', name: 'Local',
        panelSettings: { economic: publicPanel, 'stock-analysis': { name: 'Retired', enabled: true } },
        panelOrder: ['economic', 'stock-analysis'], bottomSet: ['economic', 'stock-analysis'],
      }],
    }));
    expect(loadTabsState()?.tabs[0]).toEqual({
      id: 'tab-abc-123', name: 'Local', view: 'map', panelSettings: { economic: publicPanel },
      panelOrder: ['economic'], bottomSet: ['economic'],
    });
  });
});

describe('account-free local features', () => {
  it('reports public access with export and uncapped local panels and tabs', () => {
    expect(getWebMcpAccessContext({ enabledPanelUsed: 41, dashboardTabCount: 11 })).toEqual({
      mode: 'public',
      capabilities: { dataExport: true },
      limits: {
        enabledPanels: { used: 41, cap: null },
        dashboardTabs: { used: 11, cap: null, canCreate: true },
      },
    });
  });

  it('follows more countries than the former account cap using local storage only', async () => {
    for (const code of ['US', 'FR', 'DE', 'NG', 'IR', 'GB', 'BR', 'JP', 'AU', 'CA', 'RU', 'UA', 'CN', 'ZA', 'SA', 'IN', 'MX', 'ES', 'IT', 'PL', 'NL']) {
      expect(await addCountry(code)).toEqual({ ok: true });
    }
    expect(getFollowed()).toHaveLength(21);
    expect(await addCountry('not-a-country')).toEqual({ ok: false, reason: 'INVALID_INPUT' });
    await removeCountry('us');
    expect(getFollowed()).not.toContain('US');
    expect(getFollowed()).toHaveLength(20);
  });

  it('persists basic widgets locally and ignores persisted paid variants', async () => {
    localStorage.setItem('wm-custom-widgets', JSON.stringify([
      { id: 'cw-paid', title: 'Retired', html: '<p>Paid</p>', tier: 'pro' },
    ]));
    await saveWidget({
      id: 'cw-local', title: 'Local', html: '<p>Local only</p>',
      tier: 'basic', prompt: '', accentColor: null, conversationHistory: [], createdAt: 1, updatedAt: 1,
    });
    const widgets = loadWidgets();
    expect(widgets.map(widget => widget.id)).toEqual(['cw-local']);
    expect(widgets[0]?.html).toContain('Local only');
    expect(widgets[0]?.tier).toBe('basic');
  });
});
