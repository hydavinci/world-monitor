import type { Ratelimit } from '@upstash/ratelimit';
// @ts-expect-error — JS module, no declaration file; typed API below.
import * as core from '../../api/_api-key-rate-limit.js';

export type BurstDecision =
  | { ok: true }
  | { ok: null; reason: 'not_configured' | 'timeout' | 'error' }
  | { ok: false; limit: number; reset: number };

export const ENTERPRISE_API_RATE_LIMIT: 1000 = core.ENTERPRISE_API_RATE_LIMIT;
export const getBurstLimiter = core.getBurstLimiter as (perMinute: number) => Ratelimit | null;
export const checkBurst = core.checkBurst as (perMinute: number, identity: string) => Promise<BurstDecision>;
export const rateLimitHeaders = core.rateLimitHeaders as (opts: { limit: number; remaining: number; resetMs: number; retryAfterSec: number; windowSec?: number }) => Record<string, string>;
