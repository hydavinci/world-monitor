/**
 * The dashboard "Embed this map" dialog.
 *
 * Two snippets, one dialog. The free iframe form is ungated on purpose — it is
 * a supported product surface, not a trial, and it must keep working for a
 * signed-out visitor. The keyed loader form appears only for an account that
 * can actually mint an embed key, and has to be legibly better than the free
 * one: all fourteen layers, ten minutes instead of hourly, AT THE CURRENT
 * VIEW. That last part is the easy thing to get wrong — public/embed.js only
 * learned to forward layers/center/zoom in this change, and without it the
 * paid snippet would render three default layers while the free snippet beside
 * it rendered the user's real map.
 *
 * EventHandlers pulls the whole dashboard import graph, so the two dialog
 * methods are extracted and transpiled against injected dependencies — the
 * same harness shape as unified-settings-account-handoff.test.mjs.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import {
  buildEmbedIframeSnippet,
  buildEmbedLoaderSnippet,
  embedLayerIdsFromMapLayers,
  createBlankMapLayers,
  EMBED_KEY_PLACEHOLDER,
} from '@/embed/embed-url';
import { declareOverlay } from '@/utils/open-modal';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = readFileSync(resolve(root, 'src/app/event-handlers.ts'), 'utf8');

function extractMethod(signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `${signature} not found`).toBeGreaterThanOrEqual(0);
  const braceStart = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1).replace(/^private\s+/, '');
    }
  }
  throw new Error(`unbalanced ${signature}`);
}

const js = ts.transpileModule(
  `class Harness { ${extractMethod('private openEmbedDialog(')}\n${extractMethod('private buildEmbedTier(')} }`,
  { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } },
).outputText;

let embedAccess = false;
let accountRole: 'free' | 'pro' = 'free';
const openSettings = vi.fn();

// eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
const Harness = new Function(
  'buildEmbedIframeSnippet',
  'buildEmbedLoaderSnippet',
  'embedLayerIdsFromMapLayers',
  'EMBED_KEY_PLACEHOLDER',
  'hasFeature',
  'hasEmbedAccessForAccount',
  'getAuthState',
  'getCurrentTheme',
  'SITE_VARIANT',
  'declareOverlay',
  `${js}\nreturn Harness;`,
)(
  buildEmbedIframeSnippet,
  buildEmbedLoaderSnippet,
  embedLayerIdsFromMapLayers,
  EMBED_KEY_PLACEHOLDER,
  (flag: string) => flag === 'embedAccess' && embedAccess,
  (role: 'free' | 'pro' | undefined) => role === 'pro' || embedAccess,
  () => ({ user: { role: accountRole } }),
  () => 'dark',
  'full',
  // The real one, so the dialog's reload contract is observable here rather
  // than stubbed away (a source-text harness must name every free identifier).
  declareOverlay,
);

const MAP_STATE = {
  layers: { ...createBlankMapLayers(), conflicts: true, protests: true, cables: true },
  zoom: 4.5,
};

function makeInstance() {
  const instance = new Harness();
  instance.ctx = {
    map: {
      getState: () => MAP_STATE,
      getCenter: () => ({ lat: 25.2048, lon: 55.2708 }),
    },
    unifiedSettings: { open: (tab: string) => openSettings(tab) },
  };
  // about:blank keeps happy-dom from actually loading the preview iframe.
  // Only the free snippet's SHAPE is under test here; what the real
  // getEmbedUrl() builds is covered by tests/embed-url.test.mts.
  instance.getEmbedUrl = () => 'about:blank';
  instance.closeEmbedDialog = () => {
    document.getElementById('embedModalOverlay')?.remove();
  };
  instance.copyToClipboard = vi.fn(async () => {});
  instance.boundEmbedModalKeydownHandler = null;
  return instance;
}

const tiers = () => Array.from(document.querySelectorAll('.embed-modal-tier'));
const snippets = () =>
  Array.from(document.querySelectorAll<HTMLTextAreaElement>('.embed-snippet-textarea'))
    .map((el) => el.value);

beforeEach(() => {
  document.body.replaceChildren();
  embedAccess = false;
  accountRole = 'free';
  openSettings.mockClear();
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('embed dialog tiers', () => {
  it('offers only the keyless iframe snippet without embedAccess', () => {
    makeInstance().openEmbedDialog();

    expect(tiers()).toHaveLength(1);
    const [free] = snippets();
    expect(free).toContain('<iframe');
    expect(free).not.toContain('embed.js');
    expect(free).not.toContain(EMBED_KEY_PLACEHOLDER);
    expect(document.querySelector('.embed-manage-keys-btn')).toBeNull();
  });
});
