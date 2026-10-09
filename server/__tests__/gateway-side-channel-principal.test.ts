// @vitest-environment node
import { beforeEach, expect, test, vi } from 'vitest';

const runRedisPipeline = vi.fn();
vi.mock('../_shared/redis', async (original) => ({
  ...await original<typeof import('../_shared/redis')>(),
  runRedisPipeline: (...args: unknown[]) => runRedisPipeline(...args),
}));
vi.mock('../_shared/rate-limit', async (original) => ({
  ...await original<typeof import('../_shared/rate-limit')>(),
  checkRateLimit: async () => null,
  checkEndpointRateLimit: async () => null,
}));
vi.mock('../_shared/api-key-rate-limit', async (original) => ({
  ...await original<typeof import('../_shared/api-key-rate-limit')>(),
  checkBurst: async () => ({ ok: true }),
}));
vi.mock('../../api/_api-key.js', async (original) => ({
  ...await original<Record<string, unknown>>(),
  validateApiKey: async () => ({ valid: true, required: true, kind: 'enterprise', credential: 'operator' }),
}));

import { createDomainGateway } from '../gateway';
import { markRetryableResponse, setResponseHeader, setSuccessStatusOverride } from '../_shared/response-headers';
import { IDEMPOTENCY_HEADER } from '../_shared/idempotency';
import { TRUSTED_RATE_LIMIT_PRINCIPAL_HEADER } from '../_shared/rate-limit';
import {
  createNewsServiceRoutes,
  type NewsServiceHandler,
} from '../../src/generated/server/worldmonitor/news/v1/service_server';

const path = '/api/news/v1/summarize-article';
const location = `${path}?mode=translate`;
const ctx = { waitUntil: () => {} };
const accepted = { summary: 'translated', model: '', provider: '', fallback: false, error: '', translatedTitle: '', translatedText: '' };
const translate = vi.fn<NewsServiceHandler['summarizeArticle']>();
const makeGateway = () => createDomainGateway(createNewsServiceRoutes({
  summarizeArticle: translate,
} as unknown as NewsServiceHandler).filter(route => route.path === path));
const post = (headers: Record<string, string> = {}) => new Request(`https://worldmonitor.app${path}`, {
  method: 'POST',
  headers: { 'X-WorldMonitor-Key': 'operator', 'Content-Type': 'application/json', 'cf-connecting-ip': '203.0.113.7', ...headers },
  body: JSON.stringify({ mode: 'translate', text: 'Hello', targetLang: 'fr' }),
});

beforeEach(() => {
  runRedisPipeline.mockReset().mockResolvedValue([]);
  translate.mockReset().mockImplementation(async (handlerCtx) => {
    setSuccessStatusOverride(handlerCtx.request, 202);
    setResponseHeader(handlerCtx.request, 'Location', location);
    return accepted;
  });
});

test('public translation does not acquire an account principal', async () => {
  expect((await makeGateway()(post(), ctx)).status).toBe(202);
  expect(translate).toHaveBeenCalledTimes(1);
  expect(translate.mock.calls[0]![0].request.headers.get(TRUSTED_RATE_LIMIT_PRINCIPAL_HEADER)).toBeNull();
});

test('operator translation drains the status and Location side channels', async () => {
  const response = await makeGateway()(post(), ctx);
  expect(response.status).toBe(202);
  expect(response.headers.get('Location')).toBe(location);
  expect(await response.json()).toMatchObject({ summary: 'translated' });
});

test('an in-band retryable public response releases its idempotency lock', async () => {
  translate.mockImplementation(async (handlerCtx) => {
    markRetryableResponse(handlerCtx.request);
    setResponseHeader(handlerCtx.request, 'Retry-After', '5');
    return accepted;
  });
  runRedisPipeline
    .mockResolvedValueOnce([{ result: null }])
    .mockResolvedValueOnce([{ result: 'OK' }, { result: null }])
    .mockResolvedValueOnce([{ result: 1 }]);
  const response = await makeGateway()(post({ [IDEMPOTENCY_HEADER]: 'operator-retryable' }), ctx);
  expect(response.status).toBe(200);
  expect(response.headers.get('Retry-After')).toBe('5');
  expect(runRedisPipeline.mock.calls[2]![0][0][0]).toBe('DEL');
});
