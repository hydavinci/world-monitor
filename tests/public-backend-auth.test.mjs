import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, mock } from 'node:test';
import handler from '../api/telegram-feed.js';
import { issueSessionToken } from '../api/_session.js';
import { __resetRateLimitForTest } from '../api/_rate-limit.js';

const originalEnv = { ...process.env };
let calls;

beforeEach(() => {
  __resetRateLimitForTest();
  calls = [];
  process.env.WM_SESSION_SECRET = 'public-backend-session-secret-at-least-32-characters';
  process.env.WORLDMONITOR_VALID_KEYS = 'wm_operator';
  process.env.WS_RELAY_URL = 'https://relay.test';
  process.env.CONVEX_SITE_URL = 'https://convex.test';
  process.env.CONVEX_SERVER_SHARED_SECRET = 'synthetic-secret';
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  mock.method(globalThis, 'fetch', async (input) => {
    calls.push(String(input));
    assert.equal(new URL(String(input)).origin, 'https://relay.test');
    return Response.json({ enabled: true, messages: [] });
  });
});

afterEach(() => {
  mock.restoreAll();
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

test('retired user keys are rejected before storage or relay work, even with a valid session cookie', async () => {
  const { token } = await issueSessionToken();
  for (const name of ['X-WorldMonitor-Key', 'X-Api-Key']) {
    const response = await handler(new Request('https://worldmonitor.app/api/telegram-feed', {
      headers: { [name]: `wm_${'a'.repeat(40)}`, Cookie: `wm-session=${token}` },
    }));
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'Invalid API key' });
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  assert.deepEqual(calls, []);
});

test('public Telegram feed accepts anonymous HMAC tokens and configured wm_ operator keys', async () => {
  const { token } = await issueSessionToken();
  for (const key of [token, 'wm_operator']) {
    const response = await handler(new Request('https://worldmonitor.app/api/telegram-feed', {
      headers: { 'X-WorldMonitor-Key': key },
    }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Cache-Control'), /private/);
  }
  assert.equal(calls.length, 2);
});
