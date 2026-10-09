import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildInventoryFacts } from '../scripts/generate-inventory-facts.mjs';
import { loadConfigFromFile } from 'vite';

test('inventory generation supports a public dashboard without subscription MCP tools', () => {
  const facts = buildInventoryFacts({
    mcpToolCount: 0,
    locales: 1,
    variantCount: 1,
    layerDefinitions: 1,
    panelClasses: 1,
    feedDefinitions: 1,
    freshnessSources: 1,
    sourceAttributionHosts: 1,
    sourceAttribution: { providerCount: 1 },
    localeCodes: ['en'],
  });

  assert.equal(facts.capabilities.mcpTools, 0);
  assert.equal(facts.capabilities.panelImplementations, 1);
});

test('Vite loads the public-only retirement plugin before all dev routers', async t => {
  const token = process.env.SENTRY_AUTH_TOKEN;
  process.env.SENTRY_AUTH_TOKEN = '';
  t.after(() => {
    if (token === undefined) delete process.env.SENTRY_AUTH_TOKEN;
    else process.env.SENTRY_AUTH_TOKEN = token;
  });
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' });
  assert.ok(loaded);
  assert.equal(loaded.config.plugins[0].name, 'public-only-retired-routes');
});
