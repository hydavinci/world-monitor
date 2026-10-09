import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { getFunctionName } from 'convex/server';
import { ConvexError } from 'convex/values';
import http from '../convex/http.ts';

const retiredPaths = [
  '/api/internal-entitlements',
  '/api/internal-register-interest',
  '/api/user-prefs',
  '/api/telegram-pair-callback',
  '/relay/deactivate',
  '/relay/channels',
  '/relay/notification-channels',
  '/relay/user-preferences',
  '/relay/followed-countries',
  '/relay/entitlement',
  '/relay/register-referral-code',
  '/api/internal-validate-api-key',
  '/api/internal-validate-embed-key',
  '/api/internal-get-key-owner',
  '/api/internal-issue-pro-mcp-token',
  '/api/internal-validate-pro-mcp-token',
  '/api/internal-revoke-pro-mcp-token',
  '/relay/create-checkout',
  '/relay/customer-portal',
  '/relay/bulk-suppress-emails',
];

const originalSecret = process.env.CONVEX_SERVER_SHARED_SECRET;
const fixtureSecret = 'public-contact-fixture-secret';
const contact = { name: 'Fixture', email: 'fixture@example.test', source: 'dashboard' };
const handler = http.lookup('/leads/submit-contact', 'POST')?.[0]._handler;
assert.equal(typeof handler, 'function', 'the retained contact route must be registered');

function request(body, secret = fixtureSecret) {
  return new Request('https://contact-fixture.test/leads/submit-contact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-convex-shared-secret': secret },
    body,
  });
}

before(() => { process.env.CONVEX_SERVER_SHARED_SECRET = fixtureSecret; });
after(() => {
  if (originalSecret === undefined) delete process.env.CONVEX_SERVER_SHARED_SECRET;
  else process.env.CONVEX_SERVER_SHARED_SECRET = originalSecret;
});

describe('convex/http JSON object body guard', () => {
  it('does not register retired account, billing or private relay routes', () => {
    for (const path of retiredPaths) {
      assert.equal(http.lookup(path, 'POST'), null, path);
    }
  });

  for (const body of ['', '{', 'null', 'true', 'false', '0', '"text"', '[]', '[{}]']) {
    it(`rejects malformed or non-object contact JSON ${JSON.stringify(body)} before storage`, async () => {
      let writes = 0;
      const response = await handler({ runMutation: async () => { writes++; } }, request(body));
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: 'INVALID_CONTACT' });
      assert.equal(writes, 0);
    });
  }

  for (const body of [
    {},
    { ...contact, name: null },
    { ...contact, email: 1 },
    { ...contact, source: [] },
    ...['organization', 'phone', 'message'].map(field => ({ ...contact, [field]: {} })),
  ]) {
    it(`rejects invalid contact fields ${JSON.stringify(body)} before storage`, async () => {
      let writes = 0;
      const response = await handler({ runMutation: async () => { writes++; } }, request(JSON.stringify(body)));
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: 'INVALID_CONTACT' });
      assert.equal(writes, 0);
    });
  }

  for (const secret of ['', 'wrong-contact-fixture-secret']) {
    it(`requires service authentication before parsing or storing contacts (${secret || 'missing'})`, async () => {
      let reads = 0;
      let writes = 0;
      const incoming = request(JSON.stringify(contact), secret);
      incoming.json = async () => { reads++; return contact; };
      const response = await handler({ runMutation: async () => { writes++; } }, incoming);
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: 'UNAUTHORIZED' });
      assert.equal(reads, 0);
      assert.equal(writes, 0);
    });
  }

  it('stores a valid public contact using only the retained contact mutation', async () => {
    let writes = 0;
    const body = { ...contact, organization: 'Fixture', phone: '', message: 'Fixture message' };
    const response = await handler({
      runMutation: async (mutation, args) => {
        writes++;
        assert.equal(getFunctionName(mutation), 'contactMessages:submit');
        assert.deepEqual(args, body);
        return { status: 'sent' };
      },
    }, request(JSON.stringify(body)));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'sent' });
    assert.equal(writes, 1);
  });

  for (const [error, status, code] of [
    [new ConvexError({ kind: 'rate_limited' }), 429, 'rate_limited'],
    [new ConvexError({ kind: 'FREE_EMAIL_NOT_ALLOWED' }), 422, 'FREE_EMAIL_NOT_ALLOWED'],
    [new Error('fixture storage failure'), 503, 'CONTACT_STORAGE_FAILED'],
  ]) {
    it(`surfaces contact storage errors as ${status} ${code}`, async () => {
      const response = await handler({
        runMutation: async () => { throw error; },
      }, request(JSON.stringify(contact)));
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { error: code });
    });
  }
});
