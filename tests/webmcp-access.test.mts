import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { boundWebMcpAccessContext } from '../src/services/webmcp.ts';

describe('public WebMCP access context', () => {
  it('reports local uncapped capabilities without account or token fields', () => {
    const snapshot = boundWebMcpAccessContext({
      mode: 'public',
      capabilities: { dataExport: true },
      limits: {
        enabledPanels: { used: 48, cap: null },
        dashboardTabs: { used: 8, cap: null, canCreate: true },
      },
    }, true);
    assert.deepEqual(snapshot, {
      mode: 'public',
      capabilities: { dataExport: true },
      limits: {
        enabledPanels: { used: 48, cap: null },
        dashboardTabs: { used: 8, cap: null, canCreate: true },
      },
      targetCancellationSupported: true,
    });
    assert.doesNotMatch(JSON.stringify(snapshot), /account|clerk|entitlement|token|productTier/i);
  });
});
