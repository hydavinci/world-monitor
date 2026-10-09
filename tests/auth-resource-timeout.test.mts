import assert from 'node:assert/strict';
import test from 'node:test';

const after = <T>(ms: number, value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), ms));

/**
 * Deadlock detector, not a latency budget.
 *
 * These tests stub a fetch that never resolves (or resolves later than the
 * code's own abort timer), so a promise that settles AT ALL proves the timeout
 * fired — the elapsed time proves nothing extra. Racing a tight millisecond
 * budget instead measured the runner's load and flaked on a busy CI box while
 * passing in isolation. The deadline here only exists so a genuine hang fails
 * this test rather than stalling the whole suite; the assertions that follow
 * each call are what pin the timeout behaviour.
 */
const HANG_DEADLINE_MS = 15_000;

async function settlesWithoutHanging<T>(work: Promise<T>, label: string): Promise<T> {
  const pending = Symbol('pending');
  const outcome = await Promise.race([work, after(HANG_DEADLINE_MS, pending)]);
  assert.notEqual(outcome, pending, `${label} never settled — the abort path did not fire`);
  return outcome as T;
}

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear() { values.clear(); },
    getItem(key) { return values.get(key) ?? null; },
    key(index) { return Array.from(values.keys())[index] ?? null; },
    removeItem(key) { values.delete(key); },
    setItem(key, value) { values.set(key, String(value)); },
  };
}

test('frontend session mint must not block API callers forever', async () => {
  (globalThis as unknown as { window: unknown }).window = globalThis;
  (globalThis as unknown as { location: Location }).location = {
    href: 'https://worldmonitor.app/',
    origin: 'https://worldmonitor.app',
    hostname: 'worldmonitor.app',
    protocol: 'https:',
    host: 'worldmonitor.app',
  } as Location;
  (globalThis as unknown as { sessionStorage: Storage }).sessionStorage = storage();
  (globalThis as unknown as { localStorage: Storage }).localStorage = storage();
  (globalThis as unknown as { document: unknown }).document = {
    visibilityState: 'visible',
    addEventListener() {},
  };
  (globalThis as unknown as { fetch: typeof fetch }).fetch = ((_input, init) => new Promise<Response>((_, reject) => {
    if (init?.signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }
    init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
  })) as typeof fetch;

  const mod = await import('../src/services/wm-session.ts');
  mod.__resetWmSessionForTests();
  mod.__setWmSessionFetchTimeoutForTests(50);

  const outcomes = await Promise.all(Array.from({ length: 100 }, async () => Promise.race([
    mod.ensureWmSession().then(() => 'settled'),
    after(500, 'still-pending'),
  ])));

  assert.equal(outcomes.filter((value) => value === 'still-pending').length, 0);
  mod.__resetWmSessionForTests();
});

test('wm-session request-body read must terminate for a body that never ends', async () => {
  process.env.WM_SESSION_SECRET = 'test-secret-must-be-at-least-32-chars-long-xxx';
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
  process.env.WM_SESSION_BODY_TIMEOUT_MS = '50';

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify([{ result: [29, 30] }]), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch;

  try {
    const { default: handler } = await import('../api/wm-session.js');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"widgetKey":"'));
      },
    });
    const req = new Request('https://api.worldmonitor.app/api/wm-session', {
      method: 'POST',
      headers: {
        origin: 'https://worldmonitor.app',
        'content-type': 'application/json',
      },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    const outcome = await Promise.race([
      handler(req).then(() => 'settled'),
      after(500, 'still-pending'),
    ]);
    assert.equal(outcome, 'settled');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.WM_SESSION_BODY_TIMEOUT_MS;
  }
});

test('__resetWmSessionForTests restores the default mint timeout', async () => {
  (globalThis as unknown as { window: unknown }).window = globalThis;
  (globalThis as unknown as { location: Location }).location = {
    href: 'https://worldmonitor.app/',
    origin: 'https://worldmonitor.app',
    hostname: 'worldmonitor.app',
    protocol: 'https:',
    host: 'worldmonitor.app',
  } as Location;
  (globalThis as unknown as { sessionStorage: Storage }).sessionStorage = storage();
  (globalThis as unknown as { localStorage: Storage }).localStorage = storage();
  (globalThis as unknown as { document: unknown }).document = {
    visibilityState: 'visible',
    addEventListener() {},
  };
  (globalThis as unknown as { fetch: typeof fetch }).fetch = ((_input, init) => new Promise<Response>((resolve, reject) => {
    if (init?.signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }
    init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    setTimeout(() => resolve(new Response(JSON.stringify({ exp: Date.now() + 3600000 }))), 100);
  })) as typeof fetch;

  const mod = await import('../src/services/wm-session.ts?reset-timeout-repro=1');
  mod.__setWmSessionFetchTimeoutForTests(50);
  mod.__resetWmSessionForTests();

  // The stubbed fetch resolves at 100ms but the session timeout is 50ms, so
  // ensureWmSession can only settle by aborting its own request.
  await settlesWithoutHanging(mod.ensureWmSession(), 'ensureWmSession');
});
