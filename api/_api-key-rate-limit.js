// @ts-check
// Operator burst admission and shared rate-limit response headers.
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { getKeyPrefix } from './_upstash-json.js';

/** Configured operator-key per-minute burst ceiling. */
export const ENTERPRISE_API_RATE_LIMIT = 1000;
// One Redis client shared across every per-minute Ratelimit instance; one
// Ratelimit per distinct numeric limit (60, 300, 1000) cached in the Map so two
// Starter accounts share a limiter *config* but get separate buckets via the
// per-account identifier passed to `.limit()`.
/** @type {Redis | null} */
let redisSingleton = null;
/** @type {Map<number, Ratelimit>} */
const burstLimiters = new Map();
function getRedis() {
  if (redisSingleton)
    return redisSingleton;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token)
    return null;
  // Skip the @upstash/redis retry backoff under the node test runner so
  // fail-open tests pointed at a fake host degrade immediately; production
  // (env unset) keeps the resilient default. Mirrors api/_rate-limit.js.
  // `retry: false` must stay a literal (not a spread) or it widens to
  // `boolean` and fails tsconfig.api.json's RetryConfig type.
  redisSingleton = process.env.NODE_TEST_CONTEXT
    ? new Redis({ url, token, retry: false })
    : new Redis({ url, token });
  return redisSingleton;
}
/**
 * The per-minute burst limiter for `perMinute` requests / 60s, cached by limit.
 * Returns null when Upstash is not configured.
 */
/** @param {number} perMinute */
export function getBurstLimiter(perMinute) {
  const existing = burstLimiters.get(perMinute);
  if (existing)
    return existing;
  const redis = getRedis();
  if (!redis)
    return null;
  const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(perMinute, '60 s'),
    // Env-scope the prefix exactly like the daily meter (runRedisPipeline's
    // prefixKey) so a preview deployment sharing one Upstash database doesn't
    // consume/pollute the production burst namespace. Empty in production.
    prefix: `${getKeyPrefix()}rl:apikey:min`,
    analytics: false,
  });
  burstLimiters.set(perMinute, limiter);
  return limiter;
}
/** @type {number | undefined} */
let lastBurstWarningAt;
/** @param {'not_configured' | 'timeout' | 'error'} reason */
function unavailableBurst(reason) {
  const now = Date.now();
  if (lastBurstWarningAt === undefined || now - lastBurstWarningAt >= 60_000) {
    lastBurstWarningAt = now;
    console.warn('[api-key-rate-limit] burst unavailable', { reason });
  }
  return { ok: /** @type {null} */ (null), reason };
}
/**
 * Evaluate account burst admission. Unavailable is not a denial: callers retain
 * daily metering and their existing fallback policy without claiming admission.
 * @param {number} perMinute
 * @param {string} identity
 * @returns {Promise<{ok: true} | {ok: false, limit: number, reset: number} | {ok: null, reason: 'not_configured' | 'timeout' | 'error'}>}
 */
export async function checkBurst(perMinute, identity) {
  try {
    const limiter = getBurstLimiter(perMinute);
    if (!limiter)
      return unavailableBurst('not_configured');
    const { success, limit, reset, reason } = await limiter.limit(identity);
    if (reason === 'timeout')
      return unavailableBurst('timeout');
    if (!success)
      return { ok: false, limit, reset };
    return { ok: true };
  }
  catch {
    return unavailableBurst('error');
  }
}
/**
 * Standard rate-limit response headers for a 429. Emits the IETF RateLimit
 * fields (draft-ietf-httpapi-ratelimit-headers) — RateLimit-Policy advertises
 * the quota/window, the combined RateLimit member carries live remaining +
 * delta-seconds reset — alongside the legacy X-RateLimit-* set for back-compat,
 * so customers get a uniform self-throttle contract across the per-IP and
 * per-account limiters. Mirrors api/_rate-limit.js. The gateway merges these
 * with corsHeaders.
 *
 * `resetMs` is a Unix epoch in MILLISECONDS; the IETF reset (`t` /
 * RateLimit-Reset) is delta-SECONDS, so it is derived here. `windowSec` is the
 * policy window in seconds (defaults to the 60 s burst window).
 */
/** @param {{limit: number, remaining: number, resetMs: number, retryAfterSec: number, windowSec?: number}} opts */
export function rateLimitHeaders(opts) {
  const remaining = Math.max(0, opts.remaining);
  const resetSeconds = Math.max(0, Math.ceil((opts.resetMs - Date.now()) / 1000));
  const windowSec = opts.windowSec ?? 60;
  return {
    // IETF RateLimit fields.
    'RateLimit-Policy': `"default";q=${opts.limit};w=${windowSec}`,
    'RateLimit-Limit': String(opts.limit),
    'RateLimit-Remaining': String(remaining),
    'RateLimit-Reset': String(resetSeconds),
    RateLimit: `"default";r=${remaining};t=${resetSeconds}`,
    // Legacy X-RateLimit-* retained for back-compat (Reset is epoch-ms).
    'X-RateLimit-Limit': String(opts.limit),
    'X-RateLimit-Remaining': String(remaining),
    'X-RateLimit-Reset': String(opts.resetMs),
    'Retry-After': String(Math.max(1, opts.retryAfterSec)),
  };
}
