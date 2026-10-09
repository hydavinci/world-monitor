import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { it } from 'node:test';

const layout = readFileSync(new URL('../src/app/panel-layout.ts', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/App.ts', import.meta.url), 'utf8');

it('persists the actual local panel-order key', () => {
  assert.match(layout, /saveToStorage\(this\.ctx\.PANEL_ORDER_KEY,\s*allOrder\)/);
});

it('persists local bottom placement alongside panel order', () => {
  assert.match(layout, /saveToStorage\(this\.ctx\.PANEL_ORDER_KEY \+ '-bottom-set',\s*Array\.from\(this\.bottomSetMemory\)\)/);
});

it('does not revive account-owned cloud preference reconciliation', () => {
  assert.equal(existsSync(new URL('../src/utils/cloud-prefs-sync.ts', import.meta.url)), false);
  assert.doesNotMatch(app, /from\s+['"][^'"]*cloud-prefs-sync['"]/);
  assert.doesNotMatch(app, /subscribeAuthState|applyCloudSyncedPrefsToRuntime|enforceFreeTierLimits/);
});
