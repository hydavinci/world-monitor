import assert from 'node:assert/strict';
import { it } from 'node:test';
import bootstrap from '../api/bootstrap.js';
import { summarizeArticle } from '../server/worldmonitor/news/v1/summarize-article.ts';
import { readBootstrapTierObject } from '../api/_bootstrap-r2.js';

for (const key of ['nationalDebt', 'sanctionsPressure']) {
  it(`rejects retired ${key} bootstrap selection before cached payload reads`, async t => {
    const originalKeys = process.env.WORLDMONITOR_VALID_KEYS;
    process.env.WORLDMONITOR_VALID_KEYS = 'public-only-bootstrap-operator';
    t.after(() => {
      if (originalKeys === undefined) delete process.env.WORLDMONITOR_VALID_KEYS;
      else process.env.WORLDMONITOR_VALID_KEYS = originalKeys;
    });
    let reads = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      reads++;
      return Response.json([{ result: JSON.stringify({ private: 'cached-paid-dataset' }) }]);
    });
    for (const endpoint of ['/api/bootstrap', '/api/infrastructure/v1/get-bootstrap-data']) {
      const request = new Request(`https://worldmonitor.app${endpoint}?keys=${key}`, {
        headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': 'public-only-bootstrap-operator' },
      });
      const response = endpoint === '/api/bootstrap'
        ? await bootstrap(request)
        : await (await import('../api/infrastructure/v1/[rpc].ts')).default(request);
      assert.equal(response.status, 403);
      assert.match(response.headers.get('Cache-Control') ?? '', /no-store/);
      assert.equal((await response.json()).error, 'feature_removed');
    }
    assert.equal(reads, 0);
  });
}

it('retires paid summarization modes before account, cache or provider calls', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json({ private: 'paid-summary' });
  });
  await assert.rejects(
    summarizeArticle({
      request: new Request('https://worldmonitor.app/api/news/v1/summarize-article'),
      pathParams: {},
      headers: {},
    }, {
      provider: 'openrouter', headlines: ['Public headline'], mode: 'brief',
      geoContext: '', variant: 'full', lang: 'en', bodies: [], systemAppend: '',
    }),
    { statusCode: 403, code: 'feature_removed' },
  );
  assert.equal(calls, 0);
});

it('rejects POST bodies at the GET-only standalone bootstrap before any reads', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json([]);
  });
  const response = await bootstrap(new Request('https://worldmonitor.app/api/bootstrap?public=1&tier=slow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://worldmonitor.app' },
    body: JSON.stringify({ keys: ['nationalDebt'] }),
  }));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('Allow'), 'GET, HEAD, OPTIONS');
  assert.match(response.headers.get('Cache-Control') ?? '', /no-store/);
  assert.equal(calls, 0);
});

it('never serves retired datasets from old aggregate R2 objects', async () => {
  const nowMs = Date.now();
  const env = {
    R2_ENDPOINT: 'https://bootstrap-cache.example',
    R2_BOOTSTRAP_BUCKET: 'public-bootstrap',
    R2_BOOTSTRAP_READ_KEY_ID: 'fixture-key',
    R2_BOOTSTRAP_READ_SECRET: 'fixture-secret',
  };
  for (const key of ['nationalDebt', 'sanctionsPressure']) {
    for (const payload of [{ data: { [key]: { private: true } }, missing: [] }, { data: {}, missing: [key] }]) {
      const result = await readBootstrapTierObject('slow', {
        timeoutMs: 1000, nowMs, env,
        awsClientFactory: () => ({ fetch: async () => Response.json({ tier: 'slow', generatedAt: nowMs, payload }) }),
      });
      assert.equal(result.status, 'fallback');
      assert.equal(result.reason, 'invalid');
      assert.equal('payload' in result, false);
    }
  }
  const publicPayload = { data: { news: { headlines: [] } }, missing: [] };
  const result = await readBootstrapTierObject('slow', {
    timeoutMs: 1000, nowMs, env,
    awsClientFactory: () => ({ fetch: async () => Response.json({ tier: 'slow', generatedAt: nowMs, payload: publicPayload }) }),
  });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.payload, publicPayload);
});

it('rejects unsupported bootstrap RPC POST bodies without reading any cache', async t => {
  const originalKeys = process.env.WORLDMONITOR_VALID_KEYS;
  process.env.WORLDMONITOR_VALID_KEYS = 'public-only-bootstrap-operator';
  t.after(() => {
    if (originalKeys === undefined) delete process.env.WORLDMONITOR_VALID_KEYS;
    else process.env.WORLDMONITOR_VALID_KEYS = originalKeys;
  });
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    reads++;
    return Response.json([{ result: JSON.stringify({ private: 'old-paid-cache' }) }]);
  });
  const endpoint = (await import('../api/infrastructure/v1/[rpc].ts')).default;
  for (const key of ['nationalDebt', 'sanctionsPressure']) {
    const response = await endpoint(new Request('https://worldmonitor.app/api/infrastructure/v1/get-bootstrap-data', {
      method: 'POST',
      headers: {
        Origin: 'https://worldmonitor.app', 'Content-Type': 'application/json',
        'X-WorldMonitor-Key': 'public-only-bootstrap-operator',
      },
      body: JSON.stringify({ keys: [key] }),
    }));
    assert.equal(response.status, 405);
    assert.equal((await response.json()).error, 'Method not allowed');
  }
  assert.equal(reads, 0);
});
