import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { buildDefaultTabPanels, loadTabsState, saveTabsState, type TabsState } from '../src/services/tab-store.ts';

type GlobalSnapshot = { exists: boolean; value: unknown };

function snapshotGlobal(name: string): GlobalSnapshot {
  return {
    exists: Object.prototype.hasOwnProperty.call(globalThis, name),
    value: (globalThis as Record<string, unknown>)[name],
  };
}

function restoreGlobal(name: string, snapshot: GlobalSnapshot): void {
  if (snapshot.exists) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: snapshot.value,
    });
    return;
  }
  delete (globalThis as Record<string, unknown>)[name];
}

class MemoryStorage {
  private readonly store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

class ThrowingStorage extends MemoryStorage {
  override setItem(_key: string, _value: string): void {
    throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
  }
}

const localStorageSnapshot = snapshotGlobal('localStorage');

const sample: TabsState = {
  activeTabId: 'tab-main01-abc123',
  tabs: [{
    id: 'tab-main01-abc123',
    name: 'Main',
    panelSettings: {},
    panelOrder: [],
    bottomSet: [],
  }],
};

afterEach(() => {
  restoreGlobal('localStorage', localStorageSnapshot);
});

describe('saveTabsState persist receipt', () => {
  it('returns persisted: true when localStorage accepts the write', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: new MemoryStorage(),
    });
    assert.deepEqual(saveTabsState(sample), { persisted: true });
  });

  it('returns persisted: false when localStorage.setItem throws', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: new ThrowingStorage(),
    });
    assert.deepEqual(saveTabsState(sample), { persisted: false });
  });
});

describe('dashboard workspace defaults', () => {
  it('creates empty panel selections without mutating the current workspace', () => {
    const current = {
      map: { name: 'Global Situation', enabled: true, priority: 0 },
      'strategic-risk': { name: 'Strategic Risk Overview', enabled: true, priority: 1 },
      'cw-example': { name: 'My widget', enabled: true, priority: 2 },
    };
    const next = buildDefaultTabPanels(current);
    assert.deepEqual(next.panelOrder, []);
    assert.deepEqual(Object.values(next.panelSettings).map(panel => panel.enabled), [false, false, false]);
    assert.equal(next.panelSettings['cw-example']?.name, 'My widget');
    assert.equal(current.map.enabled, true);
    assert.equal(current['cw-example'].enabled, true);
  });

  it('migrates legacy tab roles without clearing saved panel selections', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: new MemoryStorage(),
    });
    const legacy: TabsState = {
      activeTabId: 'tab-custom01-def456',
      tabs: [
        { ...sample.tabs[0]!, name: 'Renamed Main' },
        {
          id: 'tab-custom01-def456',
          name: 'Main',
          panelSettings: { 'strategic-risk': { name: 'Strategic Risk Overview', enabled: true, priority: 1 } },
          panelOrder: ['strategic-risk'],
          bottomSet: [],
        },
      ],
    };
    saveTabsState(legacy);
    assert.deepEqual(loadTabsState(), {
      activeTabId: legacy.activeTabId,
      tabs: [
        { ...legacy.tabs[0], view: 'map' },
        { ...legacy.tabs[1], view: 'panels' },
      ],
    });
    const migrated = loadTabsState()!;
    saveTabsState({ activeTabId: migrated.activeTabId, tabs: [...migrated.tabs].reverse() });
    assert.deepEqual(loadTabsState()?.tabs, [...migrated.tabs].reverse());
  });
});
