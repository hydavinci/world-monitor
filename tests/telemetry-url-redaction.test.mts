import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripSensitiveParamsFromUrl } from '../src/bootstrap/secondary-startup.ts';
import {
  SENSITIVE_URL_PARAM_RE,
  redactSensitiveUrl,
  urlCarriesSensitiveParams,
} from '../shared/sensitive-url-params.ts';

describe('shared sensitive URL redaction without external collectors', () => {
  it('strips sensitive query parameters while retaining ordinary navigation', () => {
    const keys = [
      'email', 'license_key', 'subscription_id', 'payment_id', 'accept-business-invite',
      'token', 'access_token', 'ref', 'wm_referral', '__clerk_handshake',
      '__clerk_ticket', '__clerk_foo', 'checkoutProduct', 'checkoutDiscount',
    ];
    const url = new URL('https://www.worldmonitor.app/dashboard?tab=news');
    for (const key of keys) url.searchParams.set(key, 'sensitive-value');
    const result = new URL(redactSensitiveUrl(url.href));
    for (const key of keys) assert.equal(result.searchParams.get(key), null, key);
    assert.equal(result.searchParams.get('tab'), 'news');
  });

  it('retains absolute and relative URL shapes', () => {
    assert.equal(
      redactSensitiveUrl('https://www.worldmonitor.app/dashboard?token=secret&tab=news'),
      'https://www.worldmonitor.app/dashboard?tab=news',
    );
    assert.equal(
      redactSensitiveUrl('/dashboard?ref=secret&tab=news', 'https://www.worldmonitor.app'),
      '/dashboard?tab=news',
    );
    assert.equal(redactSensitiveUrl('/?ref=secret', 'https://www.worldmonitor.app'), '/');
  });

  it('scrubs OAuth and route fragments', () => {
    for (const href of [
      'https://www.worldmonitor.app/dashboard#access_token=secret&token_type=Bearer',
      'https://www.worldmonitor.app/dashboard#/r?ref=secret&checkoutProduct=pro&keep=1',
    ]) {
      assert.ok(!redactSensitiveUrl(href).includes('secret'));
    }
    assert.ok(redactSensitiveUrl('/dashboard#/r?ref=secret&keep=1', 'https://www.worldmonitor.app').includes('keep=1'));
  });

  it('leaves ordinary URLs unchanged', () => {
    const href = 'https://www.worldmonitor.app/dashboard?tab=news';
    assert.equal(redactSensitiveUrl(href), href);
  });

  it('keeps sensitive-parameter detection aligned with redaction', () => {
    for (const key of ['ref', 'wm_referral', 'accept-business-invite', 'token', 'invite_token', '__clerk_ticket', '__clerk_status', '__clerk_handshake', 'checkoutReferral', 'email', 'license_key']) {
      const href = `https://www.worldmonitor.app/dashboard?${key}=secret&tab=news`;
      assert.equal(urlCarriesSensitiveParams(href), true, key);
      assert.equal(new URL(redactSensitiveUrl(href)).searchParams.get(key), null, key);
    }
    assert.equal(urlCarriesSensitiveParams('https://www.worldmonitor.app/dashboard?tab=news&utm_source=x'), false);
    assert.equal(urlCarriesSensitiveParams(undefined), false);
    assert.ok(SENSITIVE_URL_PARAM_RE.test('__clerk_db_jwt'));
  });
});

describe('boot-time URL privacy', () => {
  function runBootStrip(href: string): string[] {
    const replaced: string[] = [];
    const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: { href },
        history: { replaceState: (_state: unknown, _title: string, url: string) => replaced.push(url) },
      },
    });
    try {
      stripSensitiveParamsFromUrl();
      return replaced;
    } finally {
      if (original) Object.defineProperty(globalThis, 'window', original);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  }

  it('removes unread secrets but retains the selected tab', () => {
    assert.deepEqual(
      runBootStrip('https://www.worldmonitor.app/dashboard?email=secret&license_key=secret&tab=news'),
      ['/dashboard?tab=news'],
    );
  });

  it('preserves parameters owned by deferred readers', () => {
    for (const href of [
      'https://www.worldmonitor.app/dashboard?ref=abc&checkoutProduct=pro&accept-business-invite=g1&token=tok123&subscription_id=sub_1&tab=news',
      'https://www.worldmonitor.app/?__clerk_status=verified&__clerk_created_session=sess_1&__clerk_ticket=tkt_1',
      'https://www.worldmonitor.app/dashboard#/r?ref=abc&checkoutProduct=pro',
    ]) assert.deepEqual(runBootStrip(href), []);
  });

  it('scrubs the live URL before fetch wrappers and sharing metadata initialize', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    const strip = main.indexOf('stripSensitiveParamsFromUrl();');
    assert.ok(strip > 0);
    assert.ok(strip < main.indexOf('initMetaTags();'));
    assert.ok(strip < main.indexOf('installFetchFailureAttribution();'));
  });
});
