import { describe, expect, it, vi } from 'vitest';

vi.mock('@/services/i18n', () => ({ t: (key: string) => key }));

describe('public lazy panel registration', () => {
  it('retains the loader, constructs once, and runs public setup', async () => {
    const { PanelLayoutManager } = await import('@/app/panel-layout');
    const { enqueuePanelCall } = await import('@/app/pending-panel-data');
    const manager = Object.create(PanelLayoutManager.prototype) as any;
    const panel = { destroy: vi.fn(), updateData: vi.fn() };
    const loader = vi.fn(async () => panel);
    const setup = vi.fn(() => {
      expect(panel.updateData).toHaveBeenCalledWith({ value: 42 });
    });
    manager.ctx = { panelSettings: { economic: { enabled: true } }, panels: {}, isDestroyed: false };
    manager.lazyPanelRegistrations = new Map();
    expect(manager.lazyPanel('economic', loader, setup)).toBe(true);
    expect(manager.lazyPanel('economic', loader, setup)).toBe(false);
    enqueuePanelCall('economic', 'updateData', [{ value: 42 }]);
    const [first, second] = await Promise.all([
      manager.loadRegisteredPanel('economic'),
      manager.loadRegisteredPanel('economic'),
    ]);
    expect(first).toBe(panel);
    expect(second).toBe(panel);
    expect(manager.ctx.panels.economic).toBe(panel);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(panel.updateData).toHaveBeenCalledTimes(1);
    expect(setup).toHaveBeenCalledWith(panel);
  });

  it('destroys a late result rather than publishing after teardown', async () => {
    const { PanelLayoutManager } = await import('@/app/panel-layout');
    const manager = Object.create(PanelLayoutManager.prototype) as any;
    let resolve!: (value: object) => void;
    const panel = { destroy: vi.fn() };
    manager.ctx = { panelSettings: { economic: { enabled: true } }, panels: {}, isDestroyed: false };
    manager.lazyPanelRegistrations = new Map();
    manager.lazyPanel('economic', () => new Promise(value => { resolve = value; }));
    const pending = manager.loadRegisteredPanel('economic');
    manager.ctx.isDestroyed = true;
    expect(resolve).toBeTypeOf('function');
    resolve(panel);
    expect(await pending).toBeNull();
    expect(panel.destroy).toHaveBeenCalledTimes(1);
    expect(manager.ctx.panels.economic).toBeUndefined();
  });
});
