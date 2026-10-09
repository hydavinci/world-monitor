// Anonymous, uncapped local follow controls; no account or backend fixture.
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MiniElement, MiniStorage } from './helpers/mini-dom.mts';

const originals = Object.fromEntries(['window', 'localStorage'].map(key =>
  [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const storage = new MiniStorage();
const events = new EventTarget();
let service;
let renderFollowButton;
const teardowns = [];

before(async () => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: events });
  service = await import('../src/services/followed-countries.ts');
  ({ renderFollowButton } = await import('../src/utils/follow-button.ts'));
});
beforeEach(() => storage.clear());
afterEach(() => {
  for (const teardown of teardowns.splice(0)) teardown();
});
after(() => {
  for (const [key, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function mount(props = { countryCode: 'US' }) {
  const handle = renderFollowButton(props);
  const host = new MiniElement('span');
  const teardown = handle.attach(host);
  teardowns.push(teardown);
  return { handle, host, teardown };
}

async function click(host) {
  host.dispatchEvent(new Event('click'));
  await Promise.resolve();
}

describe('renderFollowButton — local visual state', () => {
  it('renders an interactive outlined star without sign-in', () => {
    const { html } = renderFollowButton({ countryCode: 'US' });
    assert.match(html, /class="follow-country-btn follow-country-btn--md"/);
    assert.match(html, /aria-pressed="false"/);
    assert.match(html, /aria-label="Follow US"/);
    assert.match(html, /☆/);
    assert.doesNotMatch(html, /disabled|loading|Upgrade/);
  });

  it('renders a filled star for a persisted, normalized country', () => {
    storage.setItem(service.FOLLOWED_COUNTRIES_STORAGE_KEY, JSON.stringify({ countries: ['usa'] }));
    const { html } = renderFollowButton({ countryCode: ' us ' });
    assert.match(html, /is-followed/);
    assert.match(html, /aria-pressed="true"/);
    assert.match(html, /★/);
    assert.match(html, /Unfollow/);
  });

  it('retains small size and escapes tooltip / accessible country names', () => {
    const { html } = renderFollowButton({
      countryCode: 'US', size: 'sm', countryName: 'US "<&>',
    });
    assert.match(html, /follow-country-btn--sm/);
    assert.match(html, /aria-label="Follow US &quot;&lt;&amp;&gt;"/);
    assert.match(html, /title="Follow US &quot;&lt;&amp;&gt;"/);
  });

  it('attach resolves state drift since the initial markup snapshot', async () => {
    const handle = renderFollowButton({ countryCode: 'US' });
    assert.match(handle.html, /aria-pressed="false"/);
    await service.addCountry('US');
    const host = new MiniElement('span');
    teardowns.push(handle.attach(host));
    assert.match(host.innerHTML, /aria-pressed="true"/);
  });
});

describe('renderFollowButton — local mutations and failures', () => {
  it('click follows, persists and rerenders; next click unfollows', async () => {
    const { host } = mount();
    await click(host);
    assert.deepEqual(service.getFollowed(), ['US']);
    assert.deepEqual(JSON.parse(storage.getItem(service.FOLLOWED_COUNTRIES_STORAGE_KEY)), { countries: ['US'] });
    assert.match(host.innerHTML, /aria-pressed="true"/);
    await click(host);
    assert.deepEqual(JSON.parse(storage.getItem(service.FOLLOWED_COUNTRIES_STORAGE_KEY)), { countries: [] });
    assert.match(host.innerHTML, /aria-pressed="false"/);
  });

  it('follows beyond the retired free cap without network or upgrade', async t => {
    const fetch = t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('Unexpected network request');
    });
    for (const code of ['US', 'FR', 'DE', 'JP', 'GB']) await service.addCountry(code);
    const { host } = mount({ countryCode: 'CA' });
    assert.match(host.innerHTML, /Follow CA/);
    await click(host);
    assert.deepEqual(service.getFollowed(), ['US', 'FR', 'DE', 'JP', 'GB', 'CA']);
    assert.match(host.innerHTML, /aria-pressed="true"/);
    assert.equal(fetch.mock.callCount(), 0);
  });

  it('same-turn double click is suppressed until the local mutation settles', async () => {
    const { host } = mount();
    host.dispatchEvent(new Event('click'));
    host.dispatchEvent(new Event('click'));
    await Promise.resolve();
    assert.deepEqual(service.getFollowed(), ['US']);
    assert.match(host.innerHTML, /aria-pressed="true"/);
    await click(host);
    assert.deepEqual(service.getFollowed(), []);
  });

  for (const initiallyFollowed of [false, true]) {
    it(`storage failure preserves ${initiallyFollowed ? 'followed' : 'unfollowed'} state and reports failure`, async t => {
      if (initiallyFollowed) await service.addCountry('US');
      const { host } = mount();
      let notifications = 0;
      teardowns.push(service.subscribe(() => notifications++));
      t.mock.method(storage, 'setItem', () => { throw new Error('QuotaExceededError'); });
      await click(host);
      assert.deepEqual(service.getFollowed(), initiallyFollowed ? ['US'] : []);
      assert.match(host.innerHTML, new RegExp(`aria-pressed="${initiallyFollowed}"`));
      assert.equal(host.getAttribute('title'), 'Could not save local followed countries');
      assert.equal(notifications, 0);
    });
  }

  it('invalid mounted country does not commit and exposes the local save error', async () => {
    const { host } = mount({ countryCode: 'NotAValidCode' });
    await click(host);
    assert.equal(storage.getItem(service.FOLLOWED_COUNTRIES_STORAGE_KEY), null);
    assert.match(host.innerHTML, /aria-pressed="false"/);
    assert.equal(host.getAttribute('title'), 'Could not save local followed countries');
  });

  it('a failed save releases busy state so a later click can persist', async t => {
    const { host } = mount();
    const failing = t.mock.method(storage, 'setItem', () => { throw new Error('QuotaExceededError'); });
    await click(host);
    failing.mock.restore();
    await click(host);
    assert.deepEqual(service.getFollowed(), ['US']);
    assert.match(host.innerHTML, /aria-pressed="true"/);
  });
});

describe('renderFollowButton — subscriptions and disposal', () => {
  it('external local watchlist events rerender both follow and unfollow states', () => {
    const { host } = mount();
    storage.setItem(service.FOLLOWED_COUNTRIES_STORAGE_KEY, JSON.stringify({ countries: ['US'] }));
    events.dispatchEvent(new Event(service.WM_FOLLOWED_COUNTRIES_CHANGED));
    assert.match(host.innerHTML, /aria-pressed="true"/);
    storage.clear();
    events.dispatchEvent(new Event(service.WM_FOLLOWED_COUNTRIES_CHANGED));
    assert.match(host.innerHTML, /aria-pressed="false"/);
  });

  it('cross-tab storage events rerender through the actual service listener', () => {
    const { host } = mount();
    storage.setItem(service.FOLLOWED_COUNTRIES_STORAGE_KEY, JSON.stringify({ countries: ['US'] }));
    const event = new Event('storage');
    Object.defineProperty(event, 'key', { value: service.FOLLOWED_COUNTRIES_STORAGE_KEY });
    events.dispatchEvent(event);
    assert.match(host.innerHTML, /aria-pressed="true"/);
  });

  it('idempotent teardown stops click mutations and watchlist rerenders', async () => {
    const { host, teardown } = mount();
    teardown();
    teardown();
    await click(host);
    assert.equal(storage.getItem(service.FOLLOWED_COUNTRIES_STORAGE_KEY), null);
    await service.addCountry('US');
    assert.match(host.innerHTML, /aria-pressed="false"/);
  });

  it('teardown during a pending click prevents a late failure UI write', async t => {
    const { host, teardown } = mount();
    t.mock.method(storage, 'setItem', () => { throw new Error('QuotaExceededError'); });
    host.dispatchEvent(new Event('click'));
    teardown();
    await Promise.resolve();
    assert.equal(host.getAttribute('title'), null);
  });
});
