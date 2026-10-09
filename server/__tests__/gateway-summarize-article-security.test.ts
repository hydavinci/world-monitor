// @vitest-environment node
import { beforeEach, expect, test, vi } from 'vitest';

const endpointLimit = vi.fn();
vi.mock('../_shared/rate-limit', async (original) => ({
  ...await original<typeof import('../_shared/rate-limit')>(),
  checkEndpointRateLimit: (...args: unknown[]) => endpointLimit(...args),
  checkRateLimit: async () => null,
}));
vi.mock('../../api/_api-key.js', async (original) => ({
  ...await original<Record<string, unknown>>(),
  validateApiKey: async () => ({ valid: true, required: false, kind: 'session' }),
}));

import { createDomainGateway } from '../gateway';
import { ENDPOINT_RATE_POLICIES } from '../_shared/rate-limit';

const path = '/api/news/v1/summarize-article';
const cachePath = `${path}-cache`;
const translate = vi.fn(async () => Response.json({ ok: true }));
const cache = vi.fn(async () => Response.json({ cached: true }));
const gateway = createDomainGateway([
  { method: 'POST', path, handler: translate },
  { method: 'GET', path: cachePath, handler: cache },
]);
const request = () => new Request(`https://worldmonitor.app${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': 'wms_anonymous' },
  body: JSON.stringify({ mode: 'translate', text: 'hola', targetLang: 'en' }),
});

beforeEach(() => {
  endpointLimit.mockReset().mockResolvedValue(null);
  translate.mockClear();
  cache.mockClear();
});

test('anonymous translation retains endpoint abuse limits', async () => {
  expect(ENDPOINT_RATE_POLICIES[path]).toEqual({ limit: 30, window: '60 s' });
  expect((await gateway(request(), { waitUntil: () => {} })).status).toBe(200);
  expect(translate).toHaveBeenCalledTimes(1);
  expect(endpointLimit).toHaveBeenCalledWith(expect.any(Request), path, expect.any(Object));
});

test('degraded endpoint limiting rejects before public provider execution', async () => {
  endpointLimit.mockResolvedValue(Response.json({ error: 'Rate-limit service unavailable' }, { status: 503 }));
  expect((await gateway(request(), { waitUntil: () => {} })).status).toBe(503);
  expect(translate).not.toHaveBeenCalled();
});

test('anonymous cached-summary lookup remains public and read-only', async () => {
  expect((await gateway(new Request(`https://worldmonitor.app${cachePath}?cache_key=public`),
    { waitUntil: () => {} })).status).toBe(200);
  expect(cache).toHaveBeenCalledTimes(1);
  expect(translate).not.toHaveBeenCalled();
});
