import assert from 'node:assert/strict';
import { it } from 'node:test';
import { retiredRouteResponse } from '../api/_retired-routes.js';
import {
  ENDPOINT_RATE_POLICIES,
  FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED,
} from '../server/_shared/rate-limit.ts';

for (const path of [
  '/api/mcp-proxy',
  '/api/a2a',
  '/api/ask',
  '/api/embed/entitlement',
  '/api/embed/session',
  '/api/embed/map-frame',
  '/api/widget-agent',
  '/api/create-checkout',
]) {
  it(`denies ${path} without declaring a deleted business-handler budget`, () => {
    assert.equal(retiredRouteResponse(new Request(`https://worldmonitor.app${path}`))?.status, 403);
    assert.equal(Object.hasOwn(ENDPOINT_RATE_POLICIES, path), false);
    assert.equal(Object.hasOwn(FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED, path), false);
  });
}

it('retains the public documentation MCP facade budget', () => {
  assert.equal(retiredRouteResponse(new Request('https://worldmonitor.app/api/docs-mcp')), null);
  assert.deepEqual(ENDPOINT_RATE_POLICIES['/api/docs-mcp'], { limit: 60, window: '60 s' });
});
