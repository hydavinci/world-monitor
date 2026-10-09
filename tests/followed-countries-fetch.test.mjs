// The account relay is retired. Follow controls consume public country scores;
// exercise the current fetch/adapters/cache, not a replacement relay stub.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { IntelligenceServiceClient } from '../src/generated/client/worldmonitor/intelligence/v1/service_client.ts';
import { TIER1_COUNTRIES } from '../src/config/countries.ts';
import { MiniStorage } from './helpers/mini-dom.mts';

function loadProduction(path, imports, globals) {
  const exports = {};
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(compiled, {
    exports, ...globals,
    require(id) {
      assert.ok(Object.hasOwn(imports, id), `Unexpected production import: ${id}`);
      return imports[id];
    },
  }, { filename: path });
  return exports;
}

const NOW = Date.UTC(2026, 9, 9, 12);
function publicResponse() {
  return {
    ciiScores: [
      { region: 'US', staticBaseline: 20, dynamicScore: 4, combinedScore: 70,
        trend: 'TREND_DIRECTION_RISING', computedAt: NOW - 1000,
        components: { newsActivity: 1, ciiContribution: 2, geoConvergence: 3, militaryActivity: 4 } },
      { region: 'GB', staticBaseline: 10, dynamicScore: 0, combinedScore: 30,
        trend: 'TREND_DIRECTION_STABLE', computedAt: 0 },
    ],
    strategicRisks: [{ region: 'global', score: 60, level: 'SEVERITY_LEVEL_HIGH',
      trend: 'TREND_DIRECTION_STABLE', factors: ['US'] }],
    degraded: false,
    stale: false,
  };
}

// Only I/O boundaries are supplied: fetch, bootstrap and IndexedDB storage.
// The generated RPC client, score adapters and circuit breaker are real.
function harness({ fetcher = async () => Response.json(publicResponse()), hydrated, stored } = {}) {
  const storage = new MiniStorage();
  if (stored) storage.setItem('wm:risk-scores', JSON.stringify(stored));
  let now = NOW;
  class Clock extends Date {
    static now() { return now; }
  }
  const requests = [];
  const persistent = new Map();
  const globals = {
    Date: Clock, localStorage: storage, DOMException, URLSearchParams,
    setTimeout, clearTimeout, console: { log() {}, warn() {}, error() {} },
    fetch: async (...args) => {
      requests.push(args);
      return fetcher(...args);
    },
  };
  const breaker = loadProduction('../src/utils/circuit-breaker.ts', {
    '../services/persistent-cache': {
      getPersistentCache: async key => persistent.get(key),
      setPersistentCache: async (key, data) => persistent.set(key, { data, updatedAt: now }),
      deletePersistentCache: async key => persistent.delete(key),
      deletePersistentCacheByPrefix: async prefix => {
        for (const key of persistent.keys()) if (key.startsWith(prefix)) persistent.delete(key);
      },
    },
  }, globals);
  const service = loadProduction('../src/services/cached-risk-scores.ts', {
    '@/services/rpc-client': { getRpcBaseUrl: () => 'https://public.example' },
    './country-instability': { setHasCachedScores() {} },
    '@/config/countries': { TIER1_COUNTRIES },
    '@/utils': breaker,
    '@/services/bootstrap': {
      getHydratedData(key) {
        assert.equal(key, 'riskScores');
        return hydrated;
      },
    },
    '@/services/generated-rpc-clients': { IntelligenceServiceClient },
  }, globals);
  return { service, storage, requests, advance: ms => { now += ms; } };
}

const plain = value => JSON.parse(JSON.stringify(value));

describe('public country scores — request and response contracts', () => {
  it('fetches public scores anonymously via GET, without relay identity or authorization', async () => {
    const { service, requests, storage } = harness();
    const result = await service.fetchCachedRiskScores();
    assert.deepEqual(plain(result.cii.map(row => row.code)), ['US', 'GB']);
    assert.equal(requests.length, 1);
    const [url, options] = requests[0];
    assert.equal(url, 'https://public.example/api/intelligence/v1/get-risk-scores');
    assert.equal(options.method, 'GET');
    assert.deepEqual(options.headers, { 'Content-Type': 'application/json' });
    assert.equal(options.body, undefined);
    assert.equal(result.cii[0].name, 'United States');
    assert.equal(result.cii[0].level, 'high');
    assert.equal(result.cii[0].trend, 'rising');
    assert.deepEqual(plain(result.cii[0].components), { unrest: 2, conflict: 3, security: 4, information: 1 });
    assert.deepEqual(JSON.parse(storage.getItem('wm:risk-scores')).data, plain(result));
  });

  it('preserves timestamps, null unknown dates, and upstream degraded/stale flags', async () => {
    const response = publicResponse();
    response.degraded = true;
    response.stale = true;
    const { service } = harness({ fetcher: async () => Response.json(response) });
    const result = await service.fetchCachedRiskScores();
    assert.equal(result.computedAt, '2026-10-09T11:59:59.000Z');
    assert.equal(result.strategicRisk.lastUpdated, '2026-10-09T11:59:59.000Z');
    assert.equal(result.cii[1].lastUpdated, null);
    assert.equal(result.degraded, true);
    assert.equal(result.stale, true);
    assert.equal(service.getCachedCountryScore('gb').lastUpdated, null);
  });

  it('empty successful response is unavailable, not a cached success', async () => {
    const { service } = harness({
      fetcher: async () => Response.json({ ciiScores: [], strategicRisks: [], degraded: false, stale: false }),
    });
    assert.equal(await service.fetchCachedRiskScores(), null);
    assert.equal(service.getCachedScores(), null);
    assert.equal(service.hasCachedScores(), false);
  });

  for (const status of [401, 404, 500]) {
    it(`HTTP ${status} without cached public data degrades to null`, async () => {
      const { service, requests } = harness({ fetcher: async () => new Response('unavailable', { status }) });
      assert.equal(await service.fetchCachedRiskScores(), null);
      assert.equal(service.getCachedScores(), null);
      assert.equal(requests.length, 1);
    });
  }

  it('transport failure degrades to null without throwing', async () => {
    const { service } = harness({ fetcher: async () => { throw new Error('ECONNREFUSED'); } });
    assert.equal(await service.fetchCachedRiskScores(), null);
    assert.equal(service.hasCachedScores(), false);
  });

  for (const [name, body] of [
    ['malformed JSON', 'not-json'],
    ['wrong array shape', '{"ciiScores":"bad","strategicRisks":[]}'],
    ['missing arrays', '{}'],
    ['top-level array', '["US","GB"]'],
    ['null', 'null'],
  ]) {
    it(`${name} degrades to null without populating cache`, async () => {
      const { service, storage } = harness({ fetcher: async () => new Response(body, { status: 200 }) });
      assert.equal(await service.fetchCachedRiskScores(), null);
      assert.equal(service.hasCachedScores(), false);
      assert.equal(storage.getItem('wm:risk-scores'), null);
    });
  }
});

describe('public country scores — cache, persistence and cancellation', () => {
  it('bootstrap hydration supplies real adapted scores without network and persists them', async () => {
    const { service, requests, storage } = harness({ hydrated: publicResponse() });
    const result = await service.fetchCachedRiskScores();
    assert.deepEqual(plain(result.cii.map(row => row.code)), ['US', 'GB']);
    assert.equal(requests.length, 0);
    assert.deepEqual(JSON.parse(storage.getItem('wm:risk-scores')).data, plain(result));
    assert.equal(service.hasCachedScores(), true);
  });

  it('fresh memory cache avoids a second request and exposes normalized country lookups', async () => {
    const { service, requests } = harness();
    const first = await service.fetchCachedRiskScores();
    assert.equal(await service.fetchCachedRiskScores(), first);
    assert.equal(requests.length, 1);
    assert.equal(service.getCachedCountryScoreValue('us'), 70);
    assert.equal(service.getCachedCountryScoreValue('ZZ'), null);
    assert.equal(service.getCachedCountryScore('us').lastUpdated.toISOString(), '2026-10-09T11:59:59.000Z');
    assert.deepEqual(plain(service.getCachedCountryScores().map(row => row.code)), ['US', 'GB']);
  });

  it('valid persisted public scores prime cache and canonicalize country names', async () => {
    const seed = harness();
    const data = plain(await seed.service.fetchCachedRiskScores());
    data.cii[0].name = '<untrusted name>';
    const { service, requests } = harness({ stored: { data, savedAt: NOW - 1000 } });
    assert.equal(service.getCachedCountryScore('us').name, 'United States');
    assert.equal((await service.fetchCachedRiskScores()).cii[0].score, 70);
    assert.equal(requests.length, 0);
  });

  it('expired persisted scores are removed and cannot mask an unavailable fetch', async () => {
    const data = plain(await harness().service.fetchCachedRiskScores());
    const { service, storage } = harness({
      stored: { data, savedAt: NOW - 60 * 60 * 1000 - 1 },
      fetcher: async () => new Response('unavailable', { status: 500 }),
    });
    assert.equal(await service.fetchCachedRiskScores(), null);
    assert.equal(storage.getItem('wm:risk-scores'), null);
  });

  it('invalid persisted country scores are removed before a new public fetch', async () => {
    const data = plain(await harness().service.fetchCachedRiskScores());
    data.cii[0].score = 101;
    const { service, storage, requests } = harness({ stored: { data, savedAt: NOW } });
    assert.equal(service.hasCachedScores(), false);
    assert.equal(storage.getItem('wm:risk-scores'), null);
    assert.equal((await service.fetchCachedRiskScores()).cii[0].score, 70);
    assert.equal(requests.length, 1);
  });

  it('local storage write failure does not discard successfully fetched public data', async t => {
    const { service, storage } = harness();
    t.mock.method(storage, 'setItem', () => { throw new Error('QuotaExceededError'); });
    assert.equal((await service.fetchCachedRiskScores()).cii[0].score, 70);
    assert.equal(service.getCachedCountryScoreValue('US'), 70);
    assert.equal(storage.getItem('wm:risk-scores'), null);
  });

  it('stale cache survives a failed background refresh with its original observation timestamp', async () => {
    let fail = false;
    const { service, requests, advance } = harness({
      fetcher: async () => {
        if (fail) throw new Error('offline');
        return Response.json(publicResponse());
      },
    });
    const first = await service.fetchCachedRiskScores();
    fail = true;
    advance(30 * 60 * 1000 + 1);
    const stale = await service.fetchCachedRiskScores();
    assert.equal(stale, first);
    assert.equal(requests.length, 2);
    assert.equal(stale.cii[0].score, 70);
    assert.equal(stale.computedAt, '2026-10-09T11:59:59.000Z');
    // Synchronous accessors deliberately expose fresh cache only.
    assert.equal(service.getCachedCountryScoreValue('US'), null);
    assert.equal(service.getCachedScores(), null);
  });

  it('already aborted callers do not attempt a network fetch', async () => {
    const { service, requests } = harness();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(service.fetchCachedRiskScores(controller.signal), { name: 'AbortError' });
    assert.equal(requests.length, 0);
  });

  it('caller abort rejects that read without cancelling the shared public cache fill', async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const { service } = harness({ fetcher: () => pending });
    const controller = new AbortController();
    const read = service.fetchCachedRiskScores(controller.signal);
    controller.abort();
    await assert.rejects(read, { name: 'AbortError' });
    release(Response.json(publicResponse()));
    // Join the actual breaker operation; no fixture server or timer wait.
    const result = await service.fetchCachedRiskScores();
    assert.equal(result.cii[0].score, 70);
    assert.equal(service.getCachedCountryScoreValue('US'), 70);
  });
});
