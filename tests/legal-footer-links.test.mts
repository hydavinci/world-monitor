/** Public dashboard legal links remain required after the marketing app retirement. */
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  EULA_PATH,
  LEGAL_FOOTER_LINKS,
  TERMS_PATH,
  PRIVACY_PATH,
  LICENSE_PATH,
  TRADEMARK_PATH,
} from '../shared/legal.ts';
import { legalLinksHtml } from '../src/utils/legal-links.ts';
const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

const REQUIRED = [EULA_PATH, TERMS_PATH, PRIVACY_PATH, LICENSE_PATH, TRADEMARK_PATH];

describe('legal links are reachable in one click', () => {
  it('the shared cluster retains every public legal document', () => {
    assert.deepEqual(
      LEGAL_FOOTER_LINKS.map(link => link.path),
      REQUIRED,
    );
    for (const link of LEGAL_FOOTER_LINKS) {
      assert.ok(link.label.length > 0, `${link.path} needs a label`);
    }
  });

  it('the dashboard legal row carries the same five documents', () => {
    const html = legalLinksHtml('https://worldmonitor.app');
    for (const path of REQUIRED) {
      assert.ok(
        html.includes(`href="https://worldmonitor.app${path}"`),
        `dashboard legal row is missing ${path}`,
      );
    }
  });

  it('the dashboard legal row is absolute, so the desktop WebView resolves it', () => {
    // A root-relative /docs/terms inside Tauri resolves against the bundled
    // app origin and 404s — the one runtime where the link silently dies.
    const html = legalLinksHtml('https://worldmonitor.app');
    assert.ok(!/href="\/docs\//.test(html), 'legal row must not emit root-relative doc links');
  });

  it('the dashboard legal row opens externally without leaking the opener', () => {
    const html = legalLinksHtml('https://worldmonitor.app');
    const anchors = html.match(/<a\b[^>]*>/g) ?? [];
    assert.equal(anchors.length, REQUIRED.length);
    for (const anchor of anchors) {
      assert.match(anchor, /rel="noopener noreferrer"/, `missing rel on ${anchor}`);
      assert.match(anchor, /target="_blank"/, `missing target on ${anchor}`);
    }
  });

  it('retains the public AGPL notice and does not link retired account or pricing routes', () => {
    assert.match(read('LICENSE'), /GNU AFFERO GENERAL PUBLIC LICENSE/);
    assert.match(read('public/world-monitor.md'), /AGPL-3\.0/);
    const html = legalLinksHtml('https://worldmonitor.app');
    assert.doesNotMatch(html, /href="[^"]*\/(?:pro|pricing|oauth|account)(?:[\/?#"])/);
  });
});
