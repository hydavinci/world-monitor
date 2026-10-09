import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { retiredRouteResponse } from '../api/_retired-routes.js';

const sourceText = readFileSync(new URL('../src-tauri/sidecar/local-api-server.mjs', import.meta.url), 'utf8');
const source = ts.createSourceFile('local-api-server.mjs', sourceText, ts.ScriptTarget.Latest, true);
const dispatchNode = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'dispatch');
assert.ok(dispatchNode, 'sidecar dispatch implementation is required');

for (const token of ['', 'synthetic-transport-token']) {
  test(`sidecar rejects retired registration before cloud fallback with ${token ? 'valid' : 'missing'} transport auth`, async () => {
    let upstreamCalls = 0;
    const context = vm.createContext({
      process: { env: { LOCAL_API_TOKEN: 'synthetic-transport-token' } },
      LOCAL_API_TRANSPORT_HEADER: 'x-worldmonitor-local-token',
      Request, Response, URL,
      retiredRouteResponse,
      makeCorsHeaders: () => ({}),
      json: (body, status = 200) => Response.json(body, { status }),
      proxyRegisterInterestToCloud: async () => {
        upstreamCalls++;
        return Response.json({ status: 'registered' });
      },
    });
    vm.runInContext(dispatchNode.getText(source), context);
    const response = await context.dispatch(new URL('http://localhost/api/register-interest'), {
      method: 'POST',
      headers: { 'x-worldmonitor-local-token': token },
    }, [], { mode: 'docker', cloudFallback: false, logger: { warn() {}, error() {} } });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'feature_removed');
    assert.match(response.headers.get('Cache-Control'), /no-store/);
    assert.equal(upstreamCalls, 0);
  });
}

test('sidecar retirement covers RPC aliases and HEAD while retaining public liveness', async () => {
  const context = vm.createContext({
    process: { env: {} }, Request, Response, URL, retiredRouteResponse,
    LOCAL_API_TRANSPORT_HEADER: 'x-worldmonitor-local-token',
    makeCorsHeaders: () => ({}),
    json: (body, status = 200) => Response.json(body, { status }),
  });
  vm.runInContext(dispatchNode.getText(source), context);
  const runtime = { mode: 'docker', port: 0, cloudFallback: false, logger: { warn() {}, error() {} } };
  for (const path of ['/api/leads/v1/register-interest', '/api/v1/market/analyze-stock', '/api/market/v1/analyze-stock.json']) {
    const response = await context.dispatch(new URL(`http://localhost${path}`), { method: 'HEAD', headers: {} }, [], runtime);
    assert.equal(response.status, 403, path);
    assert.equal(await response.text(), '');
  }
  const liveness = await context.dispatch(new URL('http://localhost/api/sidecar-health'), { method: 'GET', headers: {} }, [], runtime);
  assert.equal(liveness.status, 200);
});
