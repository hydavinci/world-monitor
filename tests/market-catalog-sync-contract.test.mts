import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LOCAL_PREFERENCE_KEYS } from '../src/utils/local-preference-keys.ts';
import { __testing__ as settingsTesting } from '../src/utils/settings-persistence.ts';

const CATALOG_KEY = 'wm-market-catalog-selection-v1';

describe('market catalog preference persistence contract', () => {
  it('is included in local settings export/import allowlists', () => {
    assert.ok(LOCAL_PREFERENCE_KEYS.includes(CATALOG_KEY));
    assert.equal(settingsTesting.isSettingsKey(CATALOG_KEY), true);
  });

});
