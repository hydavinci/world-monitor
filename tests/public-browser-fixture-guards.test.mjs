import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { expect, test as playwrightTest } from '@playwright/test';
import ts from 'typescript';

const newsText = readFileSync(new URL('../e2e/dashboard-news-request-budget.spec.ts', import.meta.url), 'utf8');
const newsSource = ts.createSourceFile('news.spec.ts', newsText, ts.ScriptTarget.Latest, true);
const newsTests = [];
const visit = (node) => {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'test') {
    newsTests.push(node);
  }
  ts.forEachChild(node, visit);
};
visit(newsSource);

test('news budget scenarios never register another test during execution', () => {
  for (const declaration of newsTests) {
    let parent = declaration.parent;
    while (parent) {
      assert.ok(!newsTests.includes(parent), `Nested test: ${declaration.arguments[0].text}`);
      parent = parent.parent;
    }
  }
});

for (const title of [
  'a preset-only anonymous load issues one digest and zero rss-proxy requests',
  'the public supply-chain news category fetches a bounded window and renders its sources',
]) {
  test(`${title}: callback reaches boot without runtime test registration`, async () => {
    const declaration = newsTests.find((node) => node.arguments[0].text === title);
    assert.ok(declaration, 'Expected independent news scenario');
    const stopped = new Error('Stop before browser boot');
    const exports = {};
    vm.runInNewContext(ts.transpileModule(`exports.boot = ${declaration.arguments[1].getText(newsSource)};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText, {
      exports,
      test: playwrightTest,
      seedFreshAnonymousFullVariant: async () => { throw stopped; },
    });
    await assert.rejects(exports.boot({ page: { on() {} } }), (error) => error === stopped);
  });
}

const headerText = readFileSync(new URL('../e2e/header-reservation.ts', import.meta.url), 'utf8');
const headerJs = ts.transpileModule(headerText, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function headerBoundary(displacement = {}) {
  let open = false;
  let closedOnce = false;
  class Locator {
    constructor(selector) { this.selector = selector; }
    async click() {
      if (this.selector === '#unifiedSettingsBtn') open = true;
      else if (this.selector === '#unifiedSettingsModal .unified-settings-close') {
        open = false;
        closedOnce = true;
      } else assert.fail(`Unexpected click: ${this.selector}`);
    }
  }
  const exports = {};
  vm.runInNewContext(headerJs, {
    exports,
    require(name) {
      assert.equal(name, '@playwright/test');
      return {
        expect(subject, message) {
          if (!(subject instanceof Locator)) return expect(subject, message);
          return {
            async toBeVisible() {
              assert.ok(subject.selector !== '#unifiedSettingsModal.active' || open);
            },
            async toBeHidden() { assert.equal(open, false); },
            async toHaveCount(count) { assert.equal(count, 0); },
          };
        },
      };
    },
  });
  const element = (control) => ({
    getBoundingClientRect() {
      const box = { x: 10, y: 10, width: 200, height: 40 };
      const displaced = displacement.when === 'closed' ? closedOnce && !open : open;
      if (displaced && displacement.control === control) box[displacement.axis] += 120;
      return box;
    },
  });
  const page = {
    locator(selector) { return new Locator(selector); },
    async evaluate(callback) {
      return vm.runInNewContext(`(${callback.toString()})()`, {
        document: {
          querySelector(selector) {
            assert.equal(selector, '.header');
            return element('header');
          },
          getElementById(id) {
            assert.equal(id, 'unifiedSettingsBtn');
            return element('settings');
          },
        },
        requestAnimationFrame(callback) { callback(); return 1; },
      });
    },
  };
  return () => exports.assertPublicHeaderKeepsLayoutStable(page);
}

test('public header guard accepts a stable settings open/close transition', async () => {
  await headerBoundary()();
});

for (const control of ['header', 'settings']) {
  for (const axis of ['x', 'y', 'width', 'height']) {
    test(`public header guard rejects transient ${control} ${axis} shifts while settings is open`, async () => {
      await assert.rejects(headerBoundary({ control, axis }), /toBeLessThanOrEqual/);
    });
  }
}

test('public header guard still rejects shifts after closing settings', async () => {
  await assert.rejects(headerBoundary({ control: 'header', axis: 'x', when: 'closed' }), /toBeLessThanOrEqual/);
});
