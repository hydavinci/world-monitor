/**
 * Tests for U6 — CIIPanel pin-to-top with stable sort.
 *
 * Two layers of coverage:
 *
 *  1. Pure partition contract (`partitionByFollowed` /
 *     `shouldRenderSectionLabels` from
 *     `src/components/_cii-panel-partition.ts`). These are the actual
 *     functions the panel calls — no shadow re-implementations.
 *
 *  2. Local service integration and the actual CIIPanel constructor,
 *     loaded with a closed import map instead of Vite/i18n startup.
 *
 * Mirrors the stubbing shape from `tests/follow-button.test.mjs`.
 */

import { describe, it, before, beforeEach, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { MiniDocument, MiniNode } from './helpers/mini-dom.mts';
import * as dom from '../src/utils/dom-utils.ts';
import * as buttons from '../src/utils/follow-button.ts';
import * as activation from '../src/utils/activation.ts';

// ---------------------------------------------------------------------------
// Browser-global stubs
// ---------------------------------------------------------------------------

class MemoryStorage {
  constructor() {
    this.store = new Map();
  }
  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }
  setItem(key, value) {
    this.store.set(key, String(value));
  }
  removeItem(key) {
    this.store.delete(key);
  }
  clear() {
    this.store.clear();
  }
}

class FakeWindow extends EventTarget {}

let _localStorage;
let _window;

before(() => {
  _localStorage = new MemoryStorage();
  _window = new FakeWindow();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: _localStorage,
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: _window,
  });
});

  // Compile production code without loading Panel's Vite/i18n graph. Imports are
  // closed: an unexpected dependency fails instead of reaching the app or env.
  function loadSource(source, filename, imports, globals = {}) {
    const exports = {};
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(compiled, {
      exports, ...globals,
      require(id) {
        assert.ok(Object.hasOwn(imports, id), `Unexpected production import: ${id}`);
        return imports[id];
      },
    }, { filename });
    return exports;
  }

  describe('CIIPanel — actual local pin rendering and persistence', () => {
    let panel;
    let documentDescriptor;
    let nodeDescriptor;

    before(() => {
      documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
      nodeDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Node');
      Object.defineProperty(globalThis, 'document', { configurable: true, value: new MiniDocument() });
      Object.defineProperty(globalThis, 'Node', { configurable: true, value: MiniNode });
    });
    after(() => {
      for (const [key, descriptor] of [['document', documentDescriptor], ['Node', nodeDescriptor]]) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    });

    beforeEach(() => {
      _localStorage.clear();
      class PanelBoundary {
        content = document.createElement('div');
        showLoading() {}
        setCount() {}
        setDataBadge() {}
        clearDataBadge() {}
        setContentNodes(...nodes) { this.content.replaceChildren(...nodes); }
        destroy() {}
      }
      const adapterSource = readFileSync(new URL('../src/services/cached-risk-scores.ts', import.meta.url), 'utf8');
      const start = adapterSource.indexOf('export function toCountryScore(');
      const end = adapterSource.indexOf('export function normalizeCiiCountryCode(', start);
      assert.ok(start >= 0 && end > start);
      const adapter = loadSource(adapterSource.slice(start, end), 'toCountryScore.ts', {});
      const { CIIPanel } = loadSource(
        readFileSync(new URL('../src/components/CIIPanel.ts', import.meta.url), 'utf8'),
        'CIIPanel.ts',
        {
          './Panel': { Panel: PanelBoundary },
          '@/utils': { getCSSColor: () => '#000000' },
          '../services/i18n': { t: key => key },
          '@/utils/dom-utils': {
            ...dom,
            // MiniDocument has no HTML template parser; icons aren't the pin contract.
            rawHtml: () => document.createDocumentFragment(),
          },
          '@/services/cached-risk-scores': adapter,
          '@/utils/follow-button': buttons,
          '@/services/followed-countries': svc,
          './_cii-panel-partition': partitionMod,
          '@/utils/activation': activation,
        },
        { console: { log() {} } },
      );
      panel = new CIIPanel();
    });
    afterEach(() => panel.destroy());

    function render() {
      panel.renderFromCached({
        cii: SCORES_5.map(score => ({ ...score, lastUpdated: '2026-10-09T00:00:00.000Z' })),
        degraded: false, stale: false,
      });
    }
    function codes() {
      return panel.content.querySelectorAll('.cii-country').map(row => row.dataset.code);
    }
    function labels() {
      return panel.content.querySelectorAll('.cii-section-label').map(label => label.textContent);
    }

    it('constructor subscribes; persisted follows pin in score order, not storage order', () => {
      _localStorage.setItem(FOLLOWED_COUNTRIES_STORAGE_KEY, JSON.stringify({ countries: ['FR', 'RU'] }));
      render();
      assert.deepEqual(codes(), ['RU', 'FR', 'US', 'CN', 'GB']);
      assert.deepEqual(labels(), ['components.cii.sectionFollowing', 'components.cii.sectionAll']);
      const hosts = panel.content.querySelectorAll('.cii-follow-btn-host');
      assert.equal(hosts.length, 5);
      assert.match(hosts[0].innerHTML, /aria-pressed="true"/);
      assert.match(hosts[2].innerHTML, /aria-pressed="false"/);
    });

    it('real local mutations reorder loaded rows and persist without refetching', async () => {
      render();
      assert.deepEqual(codes(), ['US', 'CN', 'RU', 'GB', 'FR']);
      assert.deepEqual(labels(), []);
      await addCountry('France');
      // Unknown names are rejected; supported ISO-3 identifiers are normalized.
      assert.deepEqual(codes(), ['US', 'CN', 'RU', 'GB', 'FR']);
      await addCountry('FRA');
      assert.deepEqual(codes(), ['FR', 'US', 'CN', 'RU', 'GB']);
      assert.deepEqual(JSON.parse(_localStorage.getItem(FOLLOWED_COUNTRIES_STORAGE_KEY)), { countries: ['FR'] });
      await addCountry('RU');
      assert.deepEqual(codes(), ['RU', 'FR', 'US', 'CN', 'GB']);
      await removeCountry('FRA');
      assert.deepEqual(codes(), ['RU', 'US', 'CN', 'GB', 'FR']);
    });

    it('a row follow control persists, reorders and releases replaced controls', async () => {
      render();
      const oldHosts = panel.content.querySelectorAll('.cii-follow-btn-host');
      oldHosts[4].dispatchEvent(new Event('click'));
      await Promise.resolve();
      assert.deepEqual(codes(), ['FR', 'US', 'CN', 'RU', 'GB']);
      assert.deepEqual(getFollowed(), ['FR']);
      oldHosts[0].dispatchEvent(new Event('click'));
      await Promise.resolve();
      assert.deepEqual(getFollowed(), ['FR'], 'detached old row cannot mutate');
      assert.match(oldHosts[0].innerHTML, /aria-pressed="false"/);
    });

    it('all-followed has no dividers and retains original score order', async () => {
      for (const code of ['FR', 'GB', 'RU', 'CN', 'US']) await addCountry(code);
      render();
      assert.deepEqual(codes(), ['US', 'CN', 'RU', 'GB', 'FR']);
      assert.deepEqual(labels(), []);
    });

    it('failed persistence does not pin a new country or alter saved follows', async t => {
      render();
      t.mock.method(_localStorage, 'setItem', () => { throw new Error('QuotaExceededError'); });
      assert.deepEqual(await addCountry('FR'), { ok: false, reason: 'STORAGE_FULL' });
      assert.deepEqual(codes(), ['US', 'CN', 'RU', 'GB', 'FR']);
      assert.deepEqual(labels(), []);
      assert.deepEqual(getFollowed(), []);
    });

    it('destroy stops panel rerenders and all current row mutations', async () => {
      render();
      const hosts = panel.content.querySelectorAll('.cii-follow-btn-host');
      panel.destroy();
      panel.destroy();
      await addCountry('FR');
      assert.deepEqual(codes(), ['US', 'CN', 'RU', 'GB', 'FR']);
      assert.match(hosts[4].innerHTML, /aria-pressed="false"/);
      hosts[0].dispatchEvent(new Event('click'));
      await Promise.resolve();
      assert.deepEqual(getFollowed(), ['FR']);
    });
  });

after(() => {
  delete globalThis.localStorage;
  delete globalThis.window;
});

// ---------------------------------------------------------------------------
// Imports under test
// ---------------------------------------------------------------------------

const partitionMod = await import(
  '../src/components/_cii-panel-partition.ts'
);
const { partitionByFollowed, shouldRenderSectionLabels } = partitionMod;

const svc = await import('../src/services/followed-countries.ts');
const {
  getFollowed,
  isFollowFeatureEnabled,
  subscribe,
  FOLLOWED_COUNTRIES_STORAGE_KEY,
  WM_FOLLOWED_COUNTRIES_CHANGED,
  addCountry,
  removeCountry,
} = svc;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal CountryScore shape — only `code` is required by the partition
 * helper (see `PartitionableScore`). Other fields are kept here so the
 * tests look like real CIIPanel rows and any future consumer reading
 * extra fields off the partitioned items will still typecheck.
 */
function makeScore(code, score = 50) {
  return {
    code,
    name: code,
    score,
    level: 'normal',
    trend: 'stable',
    change24h: 0,
    components: { unrest: 0, conflict: 0, security: 0, information: 0 },
    lastUpdated: new Date(0),
  };
}

const SCORES_5 = [
  makeScore('US', 80),
  makeScore('CN', 70),
  makeScore('RU', 60),
  makeScore('GB', 50),
  makeScore('FR', 40),
];

beforeEach(() => {
  _localStorage.clear();
});

// ---------------------------------------------------------------------------
// Pure partition contract
// ---------------------------------------------------------------------------

describe('partitionByFollowed — pure helper', () => {
  it('happy path: 3 followed in middle of list → all 3 pinned to top in original order', () => {
    // Followed = {RU, US, FR} but stored in a different order than scores.
    // The partition must preserve the SCORES order (US, RU, FR), not the
    // followedCodes order. Memory: sort-before-positional-index.
    const result = partitionByFollowed(SCORES_5, ['RU', 'US', 'FR']);
    assert.deepEqual(
      result.followed.map((s) => s.code),
      ['US', 'RU', 'FR'],
      'followed group preserves original scores order',
    );
    assert.deepEqual(
      result.unfollowed.map((s) => s.code),
      ['CN', 'GB'],
      'unfollowed group preserves original scores order',
    );
  });

  it('zero followed → followed=[], unfollowed=scores (identity passthrough)', () => {
    const result = partitionByFollowed(SCORES_5, []);
    assert.equal(result.followed.length, 0);
    assert.strictEqual(
      result.unfollowed,
      SCORES_5,
      'returns the SAME reference (no copy) when watchlist is empty',
    );
  });

  it('all countries followed → unfollowed empty; followed preserves order', () => {
    const result = partitionByFollowed(SCORES_5, ['US', 'CN', 'RU', 'GB', 'FR']);
    assert.deepEqual(
      result.followed.map((s) => s.code),
      ['US', 'CN', 'RU', 'GB', 'FR'],
    );
    assert.equal(result.unfollowed.length, 0);
  });

  it('followed code not present in scores → silently dropped, no error', () => {
    // 'JP' is followed but not in SCORES_5 — must NOT throw, must NOT
    // appear in either group, and the rest of the partition still works.
    const result = partitionByFollowed(SCORES_5, ['US', 'JP']);
    assert.deepEqual(
      result.followed.map((s) => s.code),
      ['US'],
      'JP is silently dropped (no row to pin)',
    );
    assert.deepEqual(
      result.unfollowed.map((s) => s.code),
      ['CN', 'RU', 'GB', 'FR'],
    );
  });

  it('empty scores list → both groups empty; no error', () => {
    const result = partitionByFollowed([], ['US', 'GB']);
    assert.equal(result.followed.length, 0);
    assert.equal(result.unfollowed.length, 0);
  });

  it('duplicate followed codes → de-duped via Set; no double-pin', () => {
    // Even if the watchlist has dupes (defensive — the service shouldn't
    // produce them), each scores row appears at most once in the output.
    const result = partitionByFollowed(SCORES_5, ['US', 'US', 'GB']);
    assert.deepEqual(
      result.followed.map((s) => s.code),
      ['US', 'GB'],
    );
    assert.equal(
      result.followed.length + result.unfollowed.length,
      SCORES_5.length,
      'every scores row appears exactly once across both groups',
    );
  });

  it('stable: a 50-row list partitioned twice → identical output', () => {
    // Regression guard against accidentally swapping `filter` for `sort`
    // (which is unstable for equal keys in older V8). Build a dense list,
    // partition twice, assert deep equality.
    const dense = Array.from({ length: 50 }, (_, i) =>
      makeScore(`X${i.toString().padStart(2, '0')}`, 50 - i),
    );
    const followed = ['X05', 'X10', 'X20', 'X30', 'X45'];
    const r1 = partitionByFollowed(dense, followed);
    const r2 = partitionByFollowed(dense, followed);
    assert.deepEqual(
      r1.followed.map((s) => s.code),
      r2.followed.map((s) => s.code),
    );
    assert.deepEqual(
      r1.unfollowed.map((s) => s.code),
      r2.unfollowed.map((s) => s.code),
    );
  });
});

describe('shouldRenderSectionLabels', () => {
  it('renders labels only when BOTH groups are non-empty', () => {
    assert.equal(
      shouldRenderSectionLabels({ followed: [makeScore('US')], unfollowed: [makeScore('CN')] }),
      true,
    );
  });

  it('zero followed → no labels (single-section list)', () => {
    assert.equal(
      shouldRenderSectionLabels({ followed: [], unfollowed: SCORES_5 }),
      false,
    );
  });

  it('all followed → no labels (single-section list)', () => {
    assert.equal(
      shouldRenderSectionLabels({ followed: SCORES_5, unfollowed: [] }),
      false,
    );
  });

  it('both empty (empty scores) → no labels', () => {
    assert.equal(shouldRenderSectionLabels({ followed: [], unfollowed: [] }), false);
  });
});

// ---------------------------------------------------------------------------
// Integration: panel-side reactive contract via the live service
// ---------------------------------------------------------------------------

describe('partition + service integration — reactive watchlist', () => {
  it('anonymous local follows are enabled and normalized before partitioning', () => {
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: [' usa ', 'United Kingdom', 'US', 'invalid'] }),
    );
    assert.equal(isFollowFeatureEnabled(), true);
    const followed = getFollowed();
    const partition = partitionByFollowed(SCORES_5, followed);
    assert.deepEqual(partition.followed.map(s => s.code), ['US', 'GB']);
    assert.deepEqual(partition.unfollowed.map(s => s.code), ['CN', 'RU', 'FR']);
    assert.equal(shouldRenderSectionLabels(partition), true);
  });

  it('empty localStorage → partition is identity passthrough', () => {
    const followed = getFollowed();
    assert.deepEqual(followed, []);
    const partition = partitionByFollowed(SCORES_5, followed);
    assert.equal(partition.followed.length, 0);
    assert.equal(partition.unfollowed.length, SCORES_5.length);
    assert.equal(shouldRenderSectionLabels(partition), false);
  });

  it('subscribe() handler fires on WM_FOLLOWED_COUNTRIES_CHANGED dispatch', async () => {
    // Locks in the panel's contract: it subscribes via subscribe(), and
    // the handler must fire when an external mutation dispatches the
    // canonical event. This is the rerenderRows() trigger path.

    let handlerCalls = 0;
    const unsubscribe = subscribe(() => {
      handlerCalls += 1;
    });

    // External mutation: write straight to localStorage (mirrors what
    // addCountry does internally on the anonymous path) and dispatch.
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: ['US'] }),
    );
    _window.dispatchEvent(new Event(WM_FOLLOWED_COUNTRIES_CHANGED));

    assert.equal(handlerCalls, 1, 'subscribe handler fires on external dispatch');

    // After mutation, getFollowed() returns the new list — the partition
    // would now place US at the top.
    const partition = partitionByFollowed(SCORES_5, getFollowed());
    assert.deepEqual(
      partition.followed.map((s) => s.code),
      ['US'],
    );
    assert.deepEqual(
      partition.unfollowed.map((s) => s.code),
      ['CN', 'RU', 'GB', 'FR'],
    );

    unsubscribe();
  });

  it('subscribe teardown stops further handler calls', async () => {

    let handlerCalls = 0;
    const unsubscribe = subscribe(() => {
      handlerCalls += 1;
    });
    _window.dispatchEvent(new Event(WM_FOLLOWED_COUNTRIES_CHANGED));
    assert.equal(handlerCalls, 1);

    unsubscribe();
    _window.dispatchEvent(new Event(WM_FOLLOWED_COUNTRIES_CHANGED));
    assert.equal(handlerCalls, 1, 'no further calls after teardown');
  });

  it('partition reflects the pre-mutation list before dispatch (no premature update)', () => {
    // Set up an initial state with US followed.
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: ['US'] }),
    );
    let partition = partitionByFollowed(SCORES_5, getFollowed());
    assert.deepEqual(
      partition.followed.map((s) => s.code),
      ['US'],
    );

    // Update localStorage but DON'T dispatch yet — the panel is supposed
    // to re-render only when notified, so a snapshot taken right now should
    // still reflect getFollowed() (which reads localStorage live in
    // anonymous mode). This locks in that the partition itself is a pure
    // function of (scores, followed), with no internal cache.
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: ['US', 'CN'] }),
    );
    partition = partitionByFollowed(SCORES_5, getFollowed());
    assert.deepEqual(
      partition.followed.map((s) => s.code),
      ['US', 'CN'],
      'getFollowed() reads localStorage live; partition reflects current state',
    );
  });
});
