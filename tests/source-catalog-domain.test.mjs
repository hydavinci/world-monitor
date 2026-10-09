import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildSourceCatalog, SOURCE_DOMAINS } from '../scripts/crawlable-sources-page.mjs';
import { activeSourceAttributionEntries } from '../scripts/source-attribution.mjs';

const manifest = JSON.parse(readFileSync(new URL('../shared/source-attribution-manifest.json', import.meta.url), 'utf8'));

test('curated X news sources remain discoverable in the news catalog', () => {
  const entries = manifest.entries.filter(entry => entry.provider === 'X API');
  assert.ok(entries.length > 0, 'the retained curated news source must be represented');
  const catalog = buildSourceCatalog(entries);
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].provider, 'X API');
  assert.equal(catalog[0].domainId, 'news');
  assert.ok(catalog[0].hosts.includes('api.x.com'));
});

test('every active committed provider can be placed in a public catalog domain', () => {
  const catalog = buildSourceCatalog(activeSourceAttributionEntries(manifest));
  const domains = new Set(SOURCE_DOMAINS.map(domain => domain.id));
  assert.ok(catalog.length > 0);
  for (const provider of catalog) {
    assert.ok(domains.has(provider.domainId), `${provider.provider}: invalid catalog domain`);
  }
});

test('unknown structured providers still reject instead of silently taking a default domain', () => {
  assert.throws(() => buildSourceCatalog([{
    provider: 'Unclassified Provider',
    host: 'unclassified.example',
    kind: 'structured',
    references: [],
  }]), /Source provider needs a catalog domain: Unclassified Provider/);
});
