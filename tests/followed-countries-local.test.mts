import assert from 'node:assert/strict';
import { after, before, beforeEach, it } from 'node:test';
import { MiniStorage } from './helpers/mini-dom.mts';

const originals = {
  localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
  window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
};
const storage = new MiniStorage();
const events = new EventTarget();
let followed: typeof import('../src/services/followed-countries.ts');

before(async () => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: events });
  followed = await import('../src/services/followed-countries.ts');
});
beforeEach(() => storage.clear());
after(() => {
  for (const [key, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

it('persists uncapped, normalized local follows without sign-in or backend calls', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected account request'); });
  for (const code of ['us', 'FR', 'DE', 'JP', 'GB', 'AU', 'CA']) {
    assert.deepEqual(await followed.addCountry(code), { ok: true });
  }
  assert.deepEqual(await followed.addCountry('US'), { ok: true });
  assert.deepEqual(followed.getFollowed(), ['US', 'FR', 'DE', 'JP', 'GB', 'AU', 'CA']);
  assert.deepEqual(JSON.parse(storage.getItem(followed.FOLLOWED_COUNTRIES_STORAGE_KEY)!), {
    countries: ['US', 'FR', 'DE', 'JP', 'GB', 'AU', 'CA'],
  });
  assert.deepEqual(await followed.removeCountry('us'), { ok: true });
  assert.deepEqual(await followed.removeCountry('US'), { ok: true });
  assert.equal(followed.isFollowed('US'), false);
  assert.equal(fetch.mock.callCount(), 0);
});

it('rejects invalid follows without changing persisted selections', async () => {
  await followed.addCountry('US');
  const before = storage.getItem(followed.FOLLOWED_COUNTRIES_STORAGE_KEY);
  assert.deepEqual(await followed.addCountry('not-a-country'), { ok: false, reason: 'INVALID_INPUT' });
  assert.equal(storage.getItem(followed.FOLLOWED_COUNTRIES_STORAGE_KEY), before);
});

it('reports storage failure without claiming the local follow was saved', async t => {
  await followed.addCountry('US');
  t.mock.method(storage, 'setItem', () => { throw new Error('QuotaExceededError'); });
  assert.deepEqual(await followed.addCountry('FR'), { ok: false, reason: 'STORAGE_FULL' });
  assert.deepEqual(followed.getFollowed(), ['US']);
});

it('notifies and unsubscribes local follow observers', async () => {
  let count = 0;
  const unsubscribe = followed.subscribe(() => count++);
  await followed.addCountry('US');
  assert.equal(count, 1);
  unsubscribe();
  await followed.addCountry('FR');
  assert.equal(count, 1);
});

for (const key of ['wm-followed-countries-v1', null, 'unrelated-key']) {
  it(`reconciles cross-tab storage notifications for ${String(key)}`, () => {
    let count = 0;
    const unsubscribe = followed.subscribe(() => count++);
    const event = new Event('storage');
    Object.defineProperty(event, 'key', { value: key });
    events.dispatchEvent(event);
    assert.equal(count, key === 'unrelated-key' ? 0 : 1);
    unsubscribe();
  });
}
