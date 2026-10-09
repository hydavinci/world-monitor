import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  rateLimitHeaders, checkBurst, ENTERPRISE_API_RATE_LIMIT,
} from '../server/_shared/api-key-rate-limit.ts';

describe('operator burst limiter and headers', () => {
  it('reports unavailable when Upstash is not configured', async () => {
    const previousUrl = process.env.UPSTASH_REDIS_REST_URL;
    const previousToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    try {
      assert.deepEqual(await checkBurst(1000, 'operator'), { ok: null, reason: 'not_configured' });
    } finally {
      if (previousUrl !== undefined) process.env.UPSTASH_REDIS_REST_URL = previousUrl;
      if (previousToken !== undefined) process.env.UPSTASH_REDIS_REST_TOKEN = previousToken;
    }
  });

  it('retains legacy headers and Retry-After', () => {
    const headers = rateLimitHeaders({ limit: 60, remaining: 0, resetMs: 1_900_000_000_000, retryAfterSec: 42 });
    assert.equal(headers['X-RateLimit-Limit'], '60');
    assert.equal(headers['X-RateLimit-Remaining'], '0');
    assert.equal(headers['X-RateLimit-Reset'], '1900000000000');
    assert.equal(headers['Retry-After'], '42');
  });

  it('retains IETF fields with a delta-seconds reset', () => {
    const headers = rateLimitHeaders({ limit: 60, remaining: 7, resetMs: Date.now() + 30_000, retryAfterSec: 30, windowSec: 60 });
    assert.equal(headers['RateLimit-Policy'], '"default";q=60;w=60');
    assert.equal(headers['RateLimit-Limit'], '60');
    assert.equal(headers['RateLimit-Remaining'], '7');
    const reset = Number(headers['RateLimit-Reset']);
    assert.ok(reset >= 29 && reset <= 31);
    assert.equal(headers.RateLimit, `"default";r=7;t=${reset}`);
  });

  it('defaults the advertised window to 60 seconds', () => {
    assert.equal(rateLimitHeaders({ limit: 600, remaining: 0, resetMs: Date.now() + 1000, retryAfterSec: 1 })['RateLimit-Policy'], '"default";q=600;w=60');
  });

  it('floors Retry-After at one second', () => {
    assert.equal(rateLimitHeaders({ limit: 60, remaining: 0, resetMs: 0, retryAfterSec: 0 })['Retry-After'], '1');
  });

  it('preserves the configured operator burst limit', () => {
    assert.equal(ENTERPRISE_API_RATE_LIMIT, 1000);
  });
});
