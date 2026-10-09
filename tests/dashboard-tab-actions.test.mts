import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DASHBOARD_TAB_NAME_MAX_LENGTH,
  TABS_PERSIST_FAILED_MESSAGE,
  applyPersistReceipt,
  describeDashboardTabs,
  mutationApplied,
  normalizeDashboardTabName,
  resolveCreateDashboardTab,
  resolveDeleteDashboardTab,
  resolveRenameDashboardTab,
  resolveSelectDashboardTab,
} from '../src/services/dashboard-tab-actions.ts';
import type { PanelTab, TabsState } from '../src/services/tab-store.ts';
import type { TabCapVerdict } from '../src/services/dashboard-tab-actions.ts';

const MAIN_ID = 'tab-main01-abc123';
const MARKETS_ID = 'tab-mrkts2-def456';

function tab(id: string, name: string): PanelTab {
  return { id, name, view: id === MAIN_ID ? 'map' : 'panels', panelSettings: {}, panelOrder: [], bottomSet: [] };
}

function state(activeTabId: string, tabs: PanelTab[]): TabsState {
  return { activeTabId, tabs };
}

const uncapped: TabCapVerdict = { allowed: true, cap: null };

describe('dashboard tab name and ID rules', () => {
  it('accepts the same 1–40 trimmed names as the dashboard rename control', () => {
    assert.equal(DASHBOARD_TAB_NAME_MAX_LENGTH, 40);
    assert.equal(normalizeDashboardTabName('  Markets  '), 'Markets');
    assert.equal(normalizeDashboardTabName('a'.repeat(40)), 'a'.repeat(40));
    assert.equal(normalizeDashboardTabName('a'.repeat(41)), null);
    assert.equal(normalizeDashboardTabName('   '), null);
    assert.equal(normalizeDashboardTabName('bad\nname'), null);
    assert.equal(normalizeDashboardTabName(1), null);
  });
});

describe('listDashboardTabs availability', () => {
  it('reports the active tab, IDs, names, and create/delete availability', () => {
    const listed = describeDashboardTabs(
      state(MARKETS_ID, [tab(MAIN_ID, 'Main'), tab(MARKETS_ID, 'Markets')]),
      uncapped,
    );
    assert.equal(listed.activeTabId, MARKETS_ID);
    assert.deepEqual(listed.tabs, [
      { id: MAIN_ID, name: 'Main', active: false, canDelete: false },
      { id: MARKETS_ID, name: 'Markets', active: true, canDelete: true },
    ]);
    assert.equal(listed.canCreate, true);
    assert.equal(listed.tabCount, 2);
  });

  it('retains the last required tab without capping additional tabs', () => {
    const listed = describeDashboardTabs(state(MAIN_ID, [tab(MAIN_ID, 'Main')]), uncapped);
    assert.equal(listed.tabs[0]?.canDelete, false);
    assert.equal(listed.canCreate, true);
    assert.equal(listed.cap, null);
  });
});

describe('selectDashboardTab', () => {
  it('is a no-op when the requested tab is already active', () => {
    const result = resolveSelectDashboardTab(state(MAIN_ID, [tab(MAIN_ID, 'Main')]), MAIN_ID);
    assert.deepEqual(result, { ok: true, unchanged: true, tab: tab(MAIN_ID, 'Main') });
  });

  it('selects another tab by stable ID and rejects names or missing IDs', () => {
    const tabs = [tab(MAIN_ID, 'Main'), tab(MARKETS_ID, 'Markets')];
    const selected = resolveSelectDashboardTab(state(MAIN_ID, tabs), MARKETS_ID);
    assert.equal(selected.ok, true);
    if (selected.ok) {
      assert.equal(selected.unchanged, false);
      assert.equal(selected.tab.id, MARKETS_ID);
    }
    assert.equal(resolveSelectDashboardTab(state(MAIN_ID, tabs), 'Markets').ok, false);
    assert.equal(resolveSelectDashboardTab(state(MAIN_ID, tabs), 'tab-missing-zzzzzz').reason, 'tab_not_found');
  });
});

describe('createDashboardTab', () => {
  it('returns the existing named tab instead of creating a duplicate', () => {
    const current = state(MAIN_ID, [tab(MAIN_ID, 'Main'), tab(MARKETS_ID, 'Markets')]);
    const result = resolveCreateDashboardTab(current, 'Markets');
    assert.deepEqual(result, {
      ok: true,
      unchanged: false,
      alreadyExisted: true,
      tab: tab(MARKETS_ID, 'Markets'),
    });
    const alreadyActive = resolveCreateDashboardTab(
      state(MARKETS_ID, current.tabs),
      'Markets',
    );
    assert.deepEqual(alreadyActive, {
      ok: true,
      unchanged: true,
      alreadyExisted: true,
      tab: tab(MARKETS_ID, 'Markets'),
    });
  });

  it('allows unnamed and named creates without a tier cap and rejects invalid names', () => {
    const current = state(MAIN_ID, [tab(MAIN_ID, 'Main')]);
    const created = resolveCreateDashboardTab(current, undefined);
    assert.deepEqual(created, { ok: true, unchanged: false, name: '' });
    const named = resolveCreateDashboardTab(current, ' Watchlist ');
    assert.deepEqual(named, { ok: true, unchanged: false, name: 'Watchlist' });
    assert.equal(resolveCreateDashboardTab(current, '   ').reason, 'invalid_name');
  });
});

describe('renameDashboardTab', () => {
  it('no-ops an identical name and rejects empty or oversized names', () => {
    const current = state(MAIN_ID, [tab(MAIN_ID, 'Main')]);
    const same = resolveRenameDashboardTab(current, MAIN_ID, 'Main');
    assert.equal(same.ok, true);
    if (same.ok) assert.equal(same.unchanged, true);
    assert.equal(resolveRenameDashboardTab(current, MAIN_ID, '').reason, 'invalid_name');
    assert.equal(
      resolveRenameDashboardTab(current, MAIN_ID, 'x'.repeat(DASHBOARD_TAB_NAME_MAX_LENGTH + 1)).reason,
      'invalid_name',
    );
  });
});

describe('persist receipt', () => {
  it('keeps durable success only when persistence reports a write', () => {
    const applied = mutationApplied('create', {
      message: 'Created dashboard tab.',
      tabId: MAIN_ID,
      name: 'Main',
    });
    assert.equal(applied.ok, true);
    assert.equal(applied.status, 'applied');
    assert.equal(applied.persisted, true);

    const persisted = applyPersistReceipt({ persisted: true }, applied);
    assert.equal(persisted.ok, true);
    assert.equal(persisted.status, 'applied');
    assert.equal(persisted.persisted, true);
    assert.equal(persisted.message, 'Created dashboard tab.');
  });

  it('does not report applied after a swallowed storage failure', () => {
    const applied = mutationApplied('rename', {
      message: 'Renamed dashboard tab.',
      tabId: MAIN_ID,
      name: 'Markets',
    });
    const failed = applyPersistReceipt({ persisted: false }, applied);
    assert.deepEqual(failed, {
      ok: false,
      status: 'denied',
      actionType: 'rename',
      reason: 'persist_failed',
      persisted: false,
      message: TABS_PERSIST_FAILED_MESSAGE,
      tabId: MAIN_ID,
      name: 'Markets',
    });
  });
});

describe('deleteDashboardTab', () => {
  it('protects Main by its map role even when renamed or inactive', () => {
    for (const activeTabId of [MAIN_ID, MARKETS_ID]) {
      const current = state(activeTabId, [tab(MAIN_ID, 'Situation'), tab(MARKETS_ID, 'Main')]);
      assert.equal(resolveDeleteDashboardTab(current, MAIN_ID, true).reason, 'main_tab');
      assert.equal(resolveDeleteDashboardTab(current, MARKETS_ID, true).ok, true);
      assert.equal(current.tabs.length, 2);
      assert.equal(describeDashboardTabs(current, uncapped).tabs[0]?.canDelete, false);
    }
  });

  it('requires confirm=true and refuses the last required tab', () => {
    const single = state(MAIN_ID, [tab(MAIN_ID, 'Main')]);
    assert.equal(resolveDeleteDashboardTab(single, MAIN_ID, true).reason, 'last_tab');
    assert.equal(resolveDeleteDashboardTab(single, MAIN_ID, false).reason, 'confirmation_required');
    assert.equal(resolveDeleteDashboardTab(single, MAIN_ID, undefined).reason, 'confirmation_required');

    const two = state(MARKETS_ID, [tab(MAIN_ID, 'Main'), tab(MARKETS_ID, 'Markets')]);
    const deleted = resolveDeleteDashboardTab(two, MARKETS_ID, true);
    assert.equal(deleted.ok, true);
    if (deleted.ok) {
      assert.equal(deleted.wasActive, true);
      assert.equal(deleted.fallbackId, MAIN_ID);
    }
  });
});
