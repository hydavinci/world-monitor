import assert from 'node:assert/strict';
import { it } from 'node:test';
import middleware from '../middleware.ts';

for (const path of ['/pro', '/pricing', '/mcp-grant', '/oauth/token', '/api/scenario/v1/run', '/api/supply-chain/v1/country-products']) {
  it(`retires ${path} before redirects, aliases and upstream handoffs`, async () => {
    const response = await middleware(new Request(`https://worldmonitor.app${path}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', Origin: 'https://worldmonitor.app' },
    }));
    assert.ok(response instanceof Response, 'retired routes must terminate, not continue to a rewrite');
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'feature_removed');
    assert.match(response.headers.get('Cache-Control') ?? '', /no-store/);
  });
}
