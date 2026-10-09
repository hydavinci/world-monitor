/**
 * Gateway-level regression tests for LeadsService public access.
 *
 * Regression: the enterprise contact form on the /pro marketing page POSTs
 * to /api/leads/v1/submit-contact with NO credentials (no wms_ session, no
 * API key) — by design, since the audience is anonymous prospects. The
 * gateway 401'd these requests because the leads paths were missing from
 * PUBLIC_NO_AUTH_RPC_PATHS, so the handler's own anti-abuse stack
 * (server-side Turnstile, honeypot, free-email rejection, per-IP and
 * per-email rate limits) never ran. The retired Pro waitlist must reject
 * requests while the independent contact form remains public.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { installRedis } from './helpers/fake-upstash-redis.mts';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.keys(process.env).forEach((k) => {
    if (!(k in originalEnv)) delete process.env[k];
  });
  Object.assign(process.env, originalEnv);
});

async function loadLeadsGateway() {
  const [{ createDomainGateway, PUBLIC_NO_AUTH_RPC_PATHS, serverOptions }, generated, { leadsHandler }] = await Promise.all([
    import('../server/gateway.ts'),
    import('../src/generated/server/worldmonitor/leads/v1/service_server.ts'),
    import('../server/worldmonitor/leads/v1/handler.ts'),
  ]);
  delete process.env.WORLDMONITOR_VALID_KEYS;
  // The endpoint rate limiter fails closed (503) when Redis is unconfigured;
  // install the fake so the request reaches the handler like in production.
  installRedis({});
  return {
    PUBLIC_NO_AUTH_RPC_PATHS,
    gateway: createDomainGateway(generated.createLeadsServiceRoutes(leadsHandler, serverOptions)),
  };
}

describe('leads gateway public access', { concurrency: 1 }, () => {
  it('declares the independent contact RPC public-no-auth', async () => {
    const { PUBLIC_NO_AUTH_RPC_PATHS } = await loadLeadsGateway();
    assert.equal(PUBLIC_NO_AUTH_RPC_PATHS.has('/api/leads/v1/submit-contact'), true);
  });

  it('accepts an anonymous submit-contact POST (no API key, no session token)', async () => {
    const { gateway } = await loadLeadsGateway();

    // Honeypot-filled body: the handler short-circuits to a silent success
    // without touching Turnstile/Convex/Resend, so this exercises ONLY the
    // gateway auth pipeline — exactly the layer that regressed.
    const res = await gateway(new Request('https://api.worldmonitor.app/api/leads/v1/submit-contact', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://worldmonitor.app',
      },
      body: JSON.stringify({
        email: 'lead@example-corp.com',
        name: 'Lead',
        organization: 'ExampleCorp',
        phone: '+1 555 123 4567',
        message: 'hello',
        source: 'enterprise-contact',
        website: 'http://honeypot-filled.example',
        // The generated request validator requires a non-empty token; the
        // honeypot still short-circuits before the handler verifies it.
        turnstileToken: 'test-token',
      }),
    }));

    assert.notEqual(res.status, 401, 'gateway must not 401 anonymous contact submissions');
    const bodyText = await res.text();
    assert.equal(res.status, 200, bodyText);
    const body = JSON.parse(bodyText) as { status?: string };
    assert.equal(body.status, 'sent');
  });

  it('rejects the retired Pro waitlist, including honeypot submissions', async () => {
    const { gateway } = await loadLeadsGateway();

    const res = await gateway(new Request('https://api.worldmonitor.app/api/leads/v1/register-interest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://worldmonitor.app',
      },
      body: JSON.stringify({
        email: 'lead@example-corp.com',
        source: 'pro-waitlist',
        website: 'http://honeypot-filled.example',
        turnstileToken: '',
      }),
    }));

    assert.equal(res.status, 403);
  });
});
