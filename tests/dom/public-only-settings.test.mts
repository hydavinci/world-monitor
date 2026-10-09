import { describe, expect, it, vi } from 'vitest';
vi.mock('@/services/runtime', () => ({ isDesktopRuntime: () => false }));
vi.mock('@/services/preferences-content', () => ({ renderPreferences: () => ({ html: '', attach: () => () => {} }) }));
vi.mock('@/services/i18n', () => ({ t: (key: string) => key }));

describe('public-only settings', () => {
  it('has only local settings, panels and sources and no account launcher', async () => {
    const { UnifiedSettings } = await import('@/components/UnifiedSettings');
    const settings = new UnifiedSettings({
      getPanelSettings: () => ({ weather: { name: 'Weather', enabled: true, priority: 1 } }),
      savePanelSettings: vi.fn(), getDisabledSources: () => new Set(),
      toggleSource: vi.fn(), setSourcesEnabled: vi.fn(), getAllSourceNames: () => ['BBC'],
      getLocalizedPanelName: (_, fallback) => fallback, resetLayout: vi.fn(), isDesktopApp: false,
    });
    settings.open();
    expect(Array.from(document.querySelectorAll('[role="tab"]')).map(el => el.getAttribute('data-tab')))
      .toEqual(['settings', 'panels', 'sources']);
    expect(document.querySelector('[data-tab="account"], [data-tab="api-keys"], [data-tab="embeds"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/Upgrade|Sign In|Billing|Pricing/);
    settings.destroy();
  });
});
