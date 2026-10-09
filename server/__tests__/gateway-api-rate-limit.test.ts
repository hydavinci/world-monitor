// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const checkBurst = vi.fn();
vi.mock('../_shared/api-key-rate-limit', async (original) => ({
  ...await original<typeof import('../_shared/api-key-rate-limit')>(),
  checkBurst: (...args: unknown[]) => checkBurst(...args),
}));
const checkRateLimit = vi.fn();
let endpointPolicy = false;
vi.mock('../_shared/rate-limit', async (original) => ({
  ...await original<typeof import('../_shared/rate-limit')>(),
  checkRateLimit: (...args: unknown[]) => checkRateLimit(...args),
  checkEndpointRateLimit: async () => null,
  hasEndpointRatePolicy: () => endpointPolicy,
}));
import { createDomainGateway } from '../gateway';
import { hashKeySync } from '../_shared/usage-identity';

const path = '/api/news/v1/list-feed-digest';
const handler = vi.fn(async () => Response.json({ ok: true }));
const gateway = createDomainGateway([{ method: 'GET', path, handler }]);
const ctx = { waitUntil: () => {} };
const request = (key = 'wm_operator', cookie?: string) => new Request(`https://worldmonitor.app${path}`, {
  headers: { 'X-Api-Key': key, ...(cookie ? { Cookie: cookie } : {}) },
});

beforeEach(() => {
  vi.stubEnv('WORLDMONITOR_VALID_KEYS', 'wm_operator');
  vi.stubEnv('API_RATE_LIMIT_ENFORCE', 'true');
  endpointPolicy = false;
  checkBurst.mockReset().mockResolvedValue({ ok: true });
  checkRateLimit.mockReset().mockResolvedValue(null);
  handler.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

test('operator burst identity stays stable across anonymous session rotations', async () => {
  for (const session of ['wms_first', 'wms_second']) {
    expect((await gateway(request('wm_operator', `wm-session=${session}`), ctx)).status).toBe(200);
  }
  expect(checkBurst.mock.calls).toEqual([
    [1000, hashKeySync('wm_operator')], [1000, hashKeySync('wm_operator')],
  ]);
  expect(checkRateLimit).not.toHaveBeenCalled();
});

test('retired user keys fail before operator admission or the handler', async () => {
  expect((await gateway(request('wm_retired'), ctx)).status).toBe(401);
  expect(checkBurst).not.toHaveBeenCalled();
  expect(handler).not.toHaveBeenCalled();
});

test('enforced operator burst denial preserves 429 headers and stops work', async () => {
  checkBurst.mockResolvedValue({ ok: false, limit: 1000, reset: Date.now() + 30_000 });
  const response = await gateway(request(), ctx);
  expect(response.status).toBe(429);
  expect(response.headers.get('Retry-After')).toBeTruthy();
  expect(response.headers.get('X-RateLimit-Limit')).toBe('1000');
  expect(handler).not.toHaveBeenCalled();
});

test('shadow burst rejection still runs the fallback limiter', async () => {
  vi.stubEnv('API_RATE_LIMIT_ENFORCE', 'false');
  checkBurst.mockResolvedValue({ ok: false, limit: 1000, reset: Date.now() + 30_000 });
  expect((await gateway(request(), ctx)).status).toBe(200);
  expect(checkRateLimit).toHaveBeenCalled();
});

test('unavailable operator limiter falls back to IP/principal admission', async () => {
  checkBurst.mockResolvedValue({ ok: null, reason: 'timeout' });
  checkRateLimit.mockResolvedValue(Response.json({ error: 'Too many requests' }, { status: 429 }));
  expect((await gateway(request(), ctx)).status).toBe(429);
  expect(handler).not.toHaveBeenCalled();
  expect(checkRateLimit).toHaveBeenCalled();
});

test('an existing endpoint policy owns fallback during a burst outage', async () => {
  endpointPolicy = true;
  checkBurst.mockResolvedValue({ ok: null, reason: 'error' });
  expect((await gateway(request(), ctx)).status).toBe(200);
  expect(checkRateLimit).not.toHaveBeenCalled();
});
