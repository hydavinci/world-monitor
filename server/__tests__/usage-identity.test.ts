import { expect, test } from 'vitest';
import { buildUsageIdentity, hashKeySync, type UsageIdentityInput } from '../_shared/usage-identity';

const input = (overrides: Partial<UsageIdentityInput> = {}): UsageIdentityInput => ({
  sessionUserId: null, isUserApiKey: false, enterpriseApiKey: null,
  widgetKey: null, clerkOrgId: null, userApiKeyCustomerRef: null,
  tier: null, planKey: null, ...overrides,
});

test('anonymous telemetry has no account identity, tier or plan', () => {
  expect(buildUsageIdentity(input({ tier: 99, planKey: 'pro' }))).toEqual({
    auth_kind: 'anon', principal_id: null, customer_id: null, tier: 0, plan_key: null,
  });
});

test.each([
  { sessionUserId: 'retired-user', clerkOrgId: 'retired-org' },
  { isUserApiKey: true, sessionUserId: 'retired-user', userApiKeyCustomerRef: 'retired-customer' },
  { widgetKey: 'retired-widget' },
])('retired account signals cannot establish identity: %j', (legacy) => {
  expect(buildUsageIdentity(input(legacy))).toEqual(buildUsageIdentity(input()));
});

test('operator telemetry hashes the actual configured authority, never logs its key', () => {
  const key = 'wm_synthetic-operator';
  const identity = buildUsageIdentity(input({ enterpriseApiKey: key }));
  expect(identity).toEqual({
    auth_kind: 'enterprise_api_key', principal_id: hashKeySync(key),
    customer_id: 'enterprise-unmapped', tier: 0, plan_key: 'enterprise',
  });
  expect(JSON.stringify(identity)).not.toContain(key);
});

test.each([0, 1, 2, 3])('operator telemetry preserves its declared tier %s', (tier) => {
  expect(buildUsageIdentity(input({ enterpriseApiKey: 'operator', tier })).tier).toBe(tier);
});
