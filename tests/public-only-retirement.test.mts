import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { createDomainGateway } from '../server/gateway.ts';
import { marketHandler } from '../server/worldmonitor/market/v1/handler.ts';
import { readFileSync } from 'node:fs';
import { retiredRouteResponse } from '../api/_retired-routes.js';

const originalFetch = globalThis.fetch;
const originalKeys = process.env.WORLDMONITOR_VALID_KEYS;
const protectedPaths: string[] = [
  ...JSON.parse(readFileSync(new URL('./fixtures/public-only-protected-routes.json', import.meta.url), 'utf8')),
  '/api/market/v1/get-stock-analysis-history',
  '/api/market/v1/analyze-stock',
  '/api/supply-chain/v1/get-country-products',
  '/api/intelligence/v1/get-country-intel-brief',
  '/api/aviation/v1/list-airport-flights',
  '/api/scenario/v1/run-scenario',
  '/api/chat-analyst',
  '/api/v2/shipping/webhooks/customer/delete',
];
const credentials: Record<string, string>[] = [
  {},
  { 'X-WorldMonitor-Key': 'public-only-operator-test' },
  { Authorization: 'Bearer fabricated-account-session' },
  {
    'X-WM-MCP-Internal': 'fabricated-internal-signature',
    'X-WM-MCP-Internal-Verified': '1',
    'X-User-Id': 'former-subscriber',
  },
];

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKeys === undefined) delete process.env.WORLDMONITOR_VALID_KEYS;
  else process.env.WORLDMONITOR_VALID_KEYS = originalKeys;
});

for (const path of protectedPaths) {
  it(`retires ${path} before credentials, business handlers or cache reads`, async () => {
    process.env.WORLDMONITOR_VALID_KEYS = 'public-only-operator-test';
    let businessCalls = 0;
    let backendCalls = 0;
    globalThis.fetch = async () => {
      backendCalls++;
      return Response.json({ result: { private: 'previously-cached-paid-data' } });
    };
    const gateway = createDomainGateway(['GET', 'POST'].map(method => ({
      method,
      path,
      handler: async () => {
        businessCalls++;
        return Response.json({ private: 'paid-business-data' });
      },
    })));
    for (const method of ['GET', 'HEAD', 'POST']) {
      for (const credential of credentials) {
        const response = await gateway(new Request(`https://worldmonitor.app${path}?public=1`, {
          method,
          headers: { Origin: 'https://worldmonitor.app', ...credential },
        }));
        assert.equal(response.status, 403, `${method} ${JSON.stringify(credential)}`);
        assert.match(response.headers.get('Cache-Control') ?? '', /private.*no-store/);
        assert.equal(response.headers.get('CDN-Cache-Control'), 'no-store');
        assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://worldmonitor.app');
        if (method === 'HEAD') assert.equal(await response.text(), '');
        else assert.equal((await response.json()).error, 'feature_removed');
      }
    }
    assert.equal(businessCalls, 0);
    assert.equal(backendCalls, 0);
  });
}

it('preserves a public RPC with operator abuse-protection credentials', async () => {
  process.env.WORLDMONITOR_VALID_KEYS = 'public-only-operator-test';
  const gateway = createDomainGateway([{
    method: 'GET',
    path: '/api/intelligence/v1/get-risk-scores',
    handler: async () => Response.json({ ciiScores: [], strategicRisks: [] }),
  }]);
  const response = await gateway(new Request('https://worldmonitor.app/api/intelligence/v1/get-risk-scores?_debug=1', {
    headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': 'public-only-operator-test' },
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ciiScores: [], strategicRisks: [] });
});

it('retains only a rejecting generated-contract slot for removed stock history', async () => {
  await assert.rejects(marketHandler.getStockAnalysisHistory({
    request: new Request('https://worldmonitor.app/api/market/v1/get-stock-analysis-history'),
    pathParams: {},
    headers: {},
  }, { symbol: 'XYZ' }), { statusCode: 403, code: 'feature_removed' });
});

it('retires encoded, version-first and alternate-document routes before routing', () => {
  for (const path of [
    '/api/market/v1/%67et-stock-analysis-history',
    '/api/market/v1/get-stock-analysis-history/',
    '/api/market/v1/get-stock-analysis-history.md',
    '/api/market/v1/get-stock-analysis-history.json',
    '/api/v1/market/get-stock-analysis-history',
    '/api/v1/infrastructure/get-bootstrap-data?keys=nationalDebt',
    '/api/scenario/v1/run',
    '/api/supply-chain/v1/country-products',
    '/ask',
    '/a2a',
    '/agent/auth',
    '/.well-known/oauth-authorization-server/mcp',
    '/.well-known/oauth-protected-resource',
    '/.well-known/mcp.json',
    '/.well-known/mcp/server-card.json',
    '/api/leads/v1/register-interest',
    '/api/register-interest',
    '/api/internal/mcp-grant-context',
    '/api/internal/mcp-grant-mint',
    '/api/notification-suppressions',
  ]) {
    const response = retiredRouteResponse(new Request(`https://worldmonitor.app${path}`));
    assert.equal(response?.status, 403, path);
  }
  assert.equal(retiredRouteResponse(new Request('https://worldmonitor.app/docs/mcp')), null);
  assert.equal(retiredRouteResponse(new Request('https://worldmonitor.app/.well-known/mcp/docs-server-card.json')), null);
});

const bootstrapPaths = [
  '/api/bootstrap',
  '/api/b%6fotstrap',
  '/api/infrastructure/v1/get-bootstrap-data',
  '/api/v1/infrastructure/get-bootstrap-data',
];

it('denies retired bootstrap selections through trailing-slash and document aliases', async () => {
  for (const path of bootstrapPaths) {
    for (const suffix of ['', '/', '.md', '.json', '.json/']) {
      for (const method of ['GET', 'HEAD', 'POST']) {
        const response = retiredRouteResponse(new Request(
          `https://worldmonitor.app${path}${suffix}?keys=markets&keys=%20nationalDebt%20,sanctionsPressure`,
          { method, headers: { 'X-WorldMonitor-Key': 'public-only-operator-test' } },
        ));
        assert.equal(response?.status, 403, `${method} ${path}${suffix}`);
        assert.ok(response);
        assert.match(response.headers.get('Cache-Control') ?? '', /private.*no-store/);
        if (method === 'HEAD') assert.equal(await response.text(), '');
        else assert.equal((await response.json()).error, 'feature_removed');
      }
    }
  }
});

it('does not retire public bootstrap selections in those same alias forms', () => {
  for (const path of bootstrapPaths) {
    for (const suffix of ['', '/', '.md', '.json', '.json/']) {
      assert.equal(retiredRouteResponse(new Request(
        `https://worldmonitor.app${path}${suffix}?keys=markets,minerals`,
      )), null, `${path}${suffix}`);
    }
  }
});
