import { describe, expect, it, vi } from 'vitest';

vi.mock('@/services/runtime', () => ({ isDesktopRuntime: () => false }));

describe('permanent public catalog', () => {
  it('does not expose protected panels in any variant', async () => {
    const { ALL_PANELS, VARIANT_DEFAULTS } = await import('@/config/panels');
    const { DEFAULT_PANELS: full } = await import('@/config/variants/full');
    const { DEFAULT_PANELS: finance } = await import('@/config/variants/finance');
    for (const key of ['stock-analysis', 'stock-backtest', 'daily-market-brief']) {
      expect(full).not.toHaveProperty(key);
      expect(finance).not.toHaveProperty(key);
    }
    for (const key of ['stock-analysis', 'stock-backtest', 'chat-analyst', 'deduction',
      'regional-intelligence', 'latest-brief', 'global-procurement', 'trade-policy',
      'market-implications', 'wsb-ticker-scanner', 'sanctions-pressure', 'national-debt']) {
      expect(ALL_PANELS).not.toHaveProperty(key);
      for (const panels of Object.values(VARIANT_DEFAULTS)) expect(panels).not.toContain(key);
    }
    for (const key of ['forecast', 'cii', 'strategic-risk', 'gdelt-intel', 'supply-chain', 'economic']) {
      expect(ALL_PANELS).toHaveProperty(key);
      expect(ALL_PANELS[key]?.premium).toBeUndefined();
    }
  });

  it('prunes stale private preferences without changing public choices', async () => {
    const { sanitizePublicPanelSettings, sanitizePublicLayers } = await import('@/services/public-preferences');
    const publicPanel = { name: 'Weather', enabled: false, priority: 3, fontScale: 1.2 };
    const stored = { economic: publicPanel, 'stock-analysis': { name: 'Old', enabled: true, priority: 1 } };
    expect(sanitizePublicPanelSettings(stored)).toEqual({ economic: publicPanel });
    expect(stored).toHaveProperty('stock-analysis');
    expect(sanitizePublicLayers({ weather: true, ciiChoropleth: true, resilienceScore: true }))
      .toEqual({ weather: true, ciiChoropleth: true });
  });

  it('does not offer the retired resilience ranking layer', async () => {
    const { LAYER_REGISTRY, isPublicLayer, getOrderedLayerKeys } = await import('@/config/map-layer-definitions');
    expect(LAYER_REGISTRY).not.toHaveProperty('resilienceScore');
    expect(isPublicLayer('resilienceScore')).toBe(false);
    for (const variant of ['full', 'tech', 'finance', 'happy', 'commodity', 'energy'] as const) {
      expect(getOrderedLayerKeys(variant)).not.toContain('resilienceScore');
    }
  });
});
