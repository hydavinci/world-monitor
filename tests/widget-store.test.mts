import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CustomWidgetSpec } from '../src/services/widget-store.ts';

type WidgetStore = typeof import('../src/services/widget-store.ts');

type GlobalSnapshot = { exists: boolean; value: unknown };

function snapshotGlobal(name: string): GlobalSnapshot {
  return {
    exists: Object.prototype.hasOwnProperty.call(globalThis, name),
    value: (globalThis as Record<string, unknown>)[name],
  };
}

function restoreGlobal(name: string, snapshot: GlobalSnapshot): void {
  if (snapshot.exists) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: snapshot.value,
    });
    return;
  }
  delete (globalThis as Record<string, unknown>)[name];
}

const globalSnapshots = new Map(
  ['localStorage', 'window', '__clearedPanelSpans', '__clearedPanelColSpans']
    .map(name => [name, snapshotGlobal(name)]),
);

afterEach(() => {
  for (const [name, snapshot] of globalSnapshots) restoreGlobal(name, snapshot);
});

async function loadWidgetStore(): Promise<WidgetStore> {
  const tempDir = mkdtempSync(join(tmpdir(), 'wm-widget-store-'));
  const outfile = join(tempDir, 'widget-store.bundle.mjs');
  const entry = resolve(process.cwd(), 'src/services/widget-store.ts');

  const stubModules = new Map([
    ['utils-stub', `
      export function loadFromStorage(key, fallback) {
        try {
          const raw = localStorage.getItem(key);
          return raw == null ? fallback : JSON.parse(raw);
        } catch {
          return fallback;
        }
      }
      export function saveToStorage(key, value) {
        localStorage.setItem(key, JSON.stringify(value));
      }
    `],
    ['panel-storage-stub', `
      export function clearPanelSpanEntry(id) {
        globalThis.__clearedPanelSpans = globalThis.__clearedPanelSpans || [];
        globalThis.__clearedPanelSpans.push(id);
      }
      export function clearPanelColSpanEntry(id) {
        globalThis.__clearedPanelColSpans = globalThis.__clearedPanelColSpans || [];
        globalThis.__clearedPanelColSpans.push(id);
      }
    `],
    ['widget-sanitizer-stub', `export function sanitizeWidgetHtml(html) { return 'sanitized:' + String(html); }`],
  ]);

  const aliasMap = new Map([
    ['@/utils', 'utils-stub'],
    ['@/utils/panel-storage', 'panel-storage-stub'],
    ['@/utils/widget-sanitizer', 'widget-sanitizer-stub'],
  ]);

  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    write: false,
    plugins: [{
      name: 'widget-store-test-stubs',
      setup(buildApi) {
        buildApi.onResolve({ filter: /.*/ }, (args) => {
          const target = aliasMap.get(args.path);
          return target ? { path: target, namespace: 'stub' } : null;
        });
        buildApi.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
          contents: stubModules.get(args.path),
          loader: 'js',
        }));
      },
    }],
  });

  writeFileSync(outfile, result.outputFiles[0].text, 'utf8');
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  rmSync(tempDir, { recursive: true, force: true });
  return mod as WidgetStore;
}

function installLocalStorage(initial: Record<string, string> = {}): Map<string, string> {
  const values = new Map(Object.entries(initial));
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: new EventTarget(),
  });
  (globalThis as Record<string, unknown>).__clearedPanelSpans = [];
  (globalThis as Record<string, unknown>).__clearedPanelColSpans = [];
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem(key: string) {
        return values.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        values.set(key, String(value));
      },
      removeItem(key: string) {
        values.delete(key);
      },
    },
  });
  return values;
}

function makeWidget(overrides: Partial<CustomWidgetSpec> = {}): CustomWidgetSpec {
  return {
    id: 'cw-basic-reload',
    title: 'Reloadable Local Widget',
    html: '<div class="reload-marker">survives reload</div>',
    prompt: 'Build a reloadable widget',
    tier: 'basic',
    accentColor: null,
    conversationHistory: [
      { role: 'user', content: 'Build a reloadable widget' },
      { role: 'assistant', content: 'Generated Reloadable Local Widget' },
    ],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_001,
    ...overrides,
  };
}

describe('widget-store local persistence', () => {
  it('loads empty and malformed storage resiliently', async () => {
    installLocalStorage();
    const { loadWidgets } = await loadWidgetStore();
    assert.deepEqual(loadWidgets(), []);

    localStorage.setItem('wm-custom-widgets', '{not-json');
    assert.deepEqual(loadWidgets(), []);
  });

  it('loads resiliently when storage access is denied', async () => {
    installLocalStorage();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem() {
          throw new Error('storage denied');
        },
      },
    });
    const { loadWidgets } = await loadWidgetStore();
    assert.deepEqual(loadWidgets(), []);
  });

  it('rejects non-array storage and rows without string IDs or HTML', async () => {
    installLocalStorage({ 'wm-custom-widgets': JSON.stringify({ widgets: [] }) });
    const { loadWidgets } = await loadWidgetStore();
    assert.deepEqual(loadWidgets(), []);
    localStorage.setItem('wm-custom-widgets', JSON.stringify([
      null, {}, { id: 1, html: '<div>invalid ID</div>' }, { id: 'cw-bad', html: null },
      makeWidget(),
    ]));
    assert.deepEqual(loadWidgets(), [makeWidget()]);
  });

  it('drops retired Pro rows even when canonical or side-key HTML exists', async () => {
    const pro = { ...makeWidget(), id: 'cw-pro', tier: 'pro' };
    installLocalStorage({
      'wm-custom-widgets': JSON.stringify([pro, { ...pro, id: 'cw-pro-side', html: '' }, makeWidget()]),
      'wm-pro-html-cw-pro-side': '<script>retired()</script>',
    });
    const { loadWidgets, getWidget } = await loadWidgetStore();
    assert.deepEqual(loadWidgets(), [makeWidget()]);
    assert.equal(getWidget('cw-pro'), null);
    assert.equal(getWidget('cw-pro-side'), null);
  });

  it('resilient loads normalize a legacy widget with no tier field to basic instead of dropping it', async () => {
    const legacyWidget = {
      id: 'cw-legacy-no-tier',
      title: 'Pre-tier Widget',
      html: '<div>legacy</div>',
      prompt: 'Build a legacy widget',
      accentColor: null,
      conversationHistory: [],
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_001,
      // no `tier` field — widgets saved before `tier` was added to the spec.
    };
    installLocalStorage({
      'wm-custom-widgets': JSON.stringify([legacyWidget]),
    });
    const { loadWidgets } = await loadWidgetStore();

    const loaded = loadWidgets();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]!.tier, 'basic');
    assert.equal(loaded[0]!.id, 'cw-legacy-no-tier');

    assert.equal(loaded[0]!.html, '<div>legacy</div>');
  });

  it('saveWidget persists sanitized basic HTML in the canonical widget entry', async () => {
    const storage = installLocalStorage();
    const { saveWidget } = await loadWidgetStore();

    const save = saveWidget(makeWidget());
    assert.ok(save instanceof Promise, 'saving a widget should defer optional sanitizer loading');
    await save;

    const stored = JSON.parse(localStorage.getItem('wm-custom-widgets') ?? '[]') as Array<{ html?: string }>;
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.html, 'sanitized:<div class="reload-marker">survives reload</div>');
    assert.deepEqual([...storage.keys()], ['wm-custom-widgets']);
    const reloaded = await loadWidgetStore();
    assert.equal(reloaded.getWidget('cw-basic-reload')?.html, stored[0]?.html);
  });

  it('truncates HTML to 50,000 characters before sanitizing', async () => {
    installLocalStorage();
    const { saveWidget } = await loadWidgetStore();
    const basic = makeWidget({ html: 'a'.repeat(50_000) + 'discarded' });

    await saveWidget(basic);

    const stored = JSON.parse(localStorage.getItem('wm-custom-widgets') ?? '[]') as Array<{ html?: string }>;
    assert.equal(stored[0]?.html, 'sanitized:' + 'a'.repeat(50_000));
  });

  it('loadWidgets restores basic HTML from the canonical entry', async () => {
    const spec = makeWidget();
    installLocalStorage({
      'wm-custom-widgets': JSON.stringify([spec]),
    });
    const { loadWidgets } = await loadWidgetStore();

    const widgets = loadWidgets();

    assert.equal(widgets.length, 1);
    assert.equal(widgets[0]?.id, spec.id);
    assert.match(widgets[0]?.html ?? '', /reload-marker/);
  });

  it('ignores retired side-key HTML for a basic widget', async () => {
    const spec = makeWidget();
    installLocalStorage({
      'wm-custom-widgets': JSON.stringify([spec]),
      [`wm-pro-html-${spec.id}`]: '<script>retired()</script>',
    });
    const { loadWidgets } = await loadWidgetStore();

    const widgets = loadWidgets();

    assert.equal(widgets.length, 1);
    assert.equal(widgets[0]?.id, spec.id);
    assert.equal(widgets[0]?.html, spec.html);
  });

  it('updates an existing widget without duplicating it or discarding other widgets', async () => {
    const original = makeWidget();
    const other = makeWidget({ id: 'cw-other', title: 'Other widget' });
    installLocalStorage({ 'wm-custom-widgets': JSON.stringify([original, other]) });
    const { saveWidget, loadWidgets, getWidget } = await loadWidgetStore();
    await saveWidget({ ...original, title: 'Updated', html: '<div>new</div>', updatedAt: 2 });

    assert.deepEqual(loadWidgets().map(widget => widget.id), ['cw-other', original.id]);
    assert.equal(getWidget(original.id)?.title, 'Updated');
    assert.equal(getWidget(original.id)?.html, 'sanitized:<div>new</div>');
    assert.equal(getWidget(original.id)?.updatedAt, 2);
    assert.deepEqual(getWidget(other.id), other);
    assert.equal(getWidget('cw-missing'), null);
  });

  it('persists only the latest ten widgets and ten conversation entries', async () => {
    installLocalStorage();
    const { saveWidget, loadWidgets } = await loadWidgetStore();
    const history = Array.from({ length: 12 }, (_, i) => ({ role: 'user' as const, content: `turn-${i}` }));
    for (let i = 0; i < 12; i++) await saveWidget(makeWidget({ id: `cw-${i}`, conversationHistory: history }));

    assert.deepEqual(loadWidgets().map(widget => widget.id), [
      'cw-2', 'cw-3', 'cw-4', 'cw-5', 'cw-6', 'cw-7', 'cw-8', 'cw-9', 'cw-10', 'cw-11',
    ]);
    assert.deepEqual(loadWidgets()[9]!.conversationHistory.map(turn => turn.content), [
      'turn-2', 'turn-3', 'turn-4', 'turn-5', 'turn-6', 'turn-7', 'turn-8', 'turn-9', 'turn-10', 'turn-11',
    ]);
    assert.equal(history.length, 12, 'saving must not mutate the caller history');
  });

  it('save failures reject without publishing a local change', async () => {
    const storage = installLocalStorage();
    const { saveWidget, subscribeWidgets } = await loadWidgetStore();
    let changes = 0;
    const unsubscribe = subscribeWidgets(() => { changes++; });
    localStorage.setItem = () => { throw new Error('quota exceeded'); };
    try {
      await assert.rejects(saveWidget(makeWidget()), /quota exceeded/);
      assert.equal(changes, 0);
      assert.equal(storage.has('wm-custom-widgets'), false);
    } finally {
      unsubscribe();
    }
  });

  it('deletes the requested widget and both panel span entries', async () => {
    const first = makeWidget();
    const other = makeWidget({ id: 'cw-other' });
    installLocalStorage({ 'wm-custom-widgets': JSON.stringify([first, other]) });
    const { deleteWidget, loadWidgets, getWidget } = await loadWidgetStore();
    deleteWidget(first.id);

    assert.deepEqual(loadWidgets(), [other]);
    assert.equal(getWidget(first.id), null);
    assert.deepEqual((globalThis as Record<string, unknown>).__clearedPanelSpans, [first.id]);
    assert.deepEqual((globalThis as Record<string, unknown>).__clearedPanelColSpans, [first.id]);
  });

  it('notifies on local writes and relevant cross-tab changes, and unsubscribes', async () => {
    installLocalStorage();
    const { subscribeWidgets, saveWidget, deleteWidget } = await loadWidgetStore();
    let changes = 0;
    const unsubscribe = subscribeWidgets(() => { changes++; });
    try {
      await saveWidget(makeWidget());
      assert.equal(changes, 1);
      deleteWidget('cw-basic-reload');
      assert.equal(changes, 2);
      for (const [key, expected] of [['unrelated', 2], ['wm-custom-widgets', 3], [null, 4]] as const) {
        const event = Object.assign(new Event('storage'), { key });
        window.dispatchEvent(event);
        assert.equal(changes, expected);
      }
      unsubscribe();
      await saveWidget(makeWidget());
      window.dispatchEvent(Object.assign(new Event('storage'), { key: null }));
      assert.equal(changes, 4);
    } finally {
      unsubscribe();
    }
  });
});
