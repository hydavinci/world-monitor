import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';
import { build } from 'esbuild';
import { orderMacroSections } from '../scripts/_macro-bundle-order.mjs';
import * as sanctionsSource from '../scripts/_sema-sanctions.mjs';
import { gzipSync } from 'node:zlib';
import { runSeed, writeExtraKeyWithMeta } from '../scripts/_seed-utils.mjs';

const root = new URL('../', import.meta.url);
const bundles = [
  'seed-bundle-macro.mjs',
  'seed-bundle-derived-signals.mjs',
  'seed-bundle-relay-backup.mjs',
  'seed-bundle-resilience.mjs',
  'seed-bundle-static-ref-heavy.mjs',
  'seed-bundle-static-ref.mjs',
];

test('public seed bundles link only retained implementations', () => {
  for (const bundle of bundles) {
    const path = new URL(`scripts/${bundle}`, root);
    const source = ts.createSourceFile(bundle, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const references = [];
    function visit(node) {
      if (ts.isImportDeclaration(node) && node.moduleSpecifier.text.startsWith('./')) {
        references.push(node.moduleSpecifier.text);
      }
      if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'script' && ts.isStringLiteral(node.initializer)) {
        references.push(`./${node.initializer.text}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    for (const reference of references) {
      assert.ok(existsSync(new URL(reference, path)), `${bundle} links removed ${reference}`);
    }
  }
});

test('public relay shared dependencies do not require removed pricing artifacts', () => {
  const source = ts.createSourceFile('ais-relay.cjs', readFileSync(new URL('scripts/ais-relay.cjs', root), 'utf8'), ts.ScriptTarget.Latest, true);
  const references = [];
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === 'requireShared' && ts.isStringLiteral(node.arguments[0])) {
      references.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const reference of references) {
    assert.ok(existsSync(new URL(`scripts/shared/${reference}`, root)), `relay requires removed ${reference}`);
  }
});

test('registered public services have deployable entrypoints and watch paths', () => {
  const services = JSON.parse(readFileSync(new URL('scripts/railway-services.json', root), 'utf8'));
  for (const service of services) {
    assert.ok(existsSync(new URL(service.entry, root)), `${service.service}: missing entrypoint`);
    if (service.watchPatterns === undefined) continue;
    assert.ok(Array.isArray(service.watchPatterns));
    for (const pattern of service.watchPatterns) {
      if (/[*?]/.test(pattern)) continue;
      assert.ok(existsSync(new URL(pattern, root)), `${service.service}: missing watch path ${pattern}`);
    }
  }
});

test('public runtime manifest bundles without private resilience scoring', async () => {
  await build({
    entryPoints: [new URL('server/worldmonitor/resilience/v1/get-resilience-runtime-manifest.ts', root).pathname],
    bundle: true,
    write: false,
    platform: 'node',
    logLevel: 'silent',
    plugins: [{
      name: 'reject-private-scorers',
      setup(builder) {
        builder.onResolve({ filter: /_dimension-scorers|_pillar-membership|_indicator-trace/ }, args => {
          throw new Error(`Public metadata imports retired scorer: ${args.path}`);
        });
      },
    }],
  });
});

test('sanctions ingestion publishes entity lookup rather than private pressure projections', () => {
  const source = readFileSync(new URL('scripts/seed-sanctions-pressure.mjs', root), 'utf8')
    .replace(/^import .*$/gm, '')
    .replace(/loadEnvFile\(import\.meta\.url\);/, '')
    .replace(/^export /gm, '');
  let publication;
  vm.runInNewContext(source, {
    ...sanctionsSource,
    loadEnvFile() {},
    runSeed(domain, name, key, fetcher, options) { publication = { domain, name, key, options }; },
    console,
  });
  assert.equal(publication.key, 'sanctions:entities:v1');
  assert.equal(publication.name, 'entities');
  const index = [{ id: 'SDN:1', name: 'Example', et: 'entity', cc: ['RU'], pr: ['TEST'] }];
  const payload = publication.options.publishTransform({ totalCount: 1, _entityIndex: index });
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), index);
  assert.equal(publication.options.validateFn(payload), true);
  assert.equal(publication.options.declareRecords(payload), 1);
  assert.equal(publication.options.validateFn([]), true);
  assert.equal(publication.options.declareRecords([]), 0);
  assert.equal(publication.options.validateFn([{ id: 'invalid', name: 'Example' }]), false);
  assert.ok(!publication.options.extraKeys.some(item => item.key === 'sanctions:pressure:state:v1'));
});

test('Sunday education priority preserves all public macro sections', () => {
  const education = { label: 'education' };
  const macro = [{ label: 'markets' }, { label: 'energy' }];
  assert.deepEqual(orderMacroSections(new Date('2026-10-11T08:15:00Z'), education, macro), [education, ...macro]);
  assert.deepEqual(orderMacroSections(new Date('2026-10-11T09:15:00Z'), education, macro), [...macro, education]);
  assert.deepEqual(orderMacroSections(new Date('2026-10-12T08:15:00Z'), education, macro), [...macro, education]);
});

test('real sanctions publication writes the entity envelope and public companions', async () => {
  const source = readFileSync(new URL('scripts/seed-sanctions-pressure.mjs', root), 'utf8')
    .replace(/^import .*$/gm, '')
    .replace(/loadEnvFile\(import\.meta\.url\);/, '')
    .replace(/^export /gm, '');
  let options;
  vm.runInNewContext(source, {
    ...sanctionsSource, Buffer, gzipSync, console, writeExtraKeyWithMeta,
    runSeed(_domain, _name, _key, _fetcher, config) { options = config; },
  });
  const original = { fetch: globalThis.fetch, exit: process.exit, log: console.log, warn: console.warn };
  const env = Object.fromEntries(['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'WM_SEED_RETRY_DELAY_MS'].map(key => [key, process.env[key]]));
  const listeners = new Set(process.rawListeners('SIGTERM'));
  const store = new Map();
  const now = Date.now();
  const index = [{ id: 'SDN:1', name: 'Example', et: 'entity', cc: ['RU'], pr: ['TEST'] }];
  const data = {
    totalCount: 1, sdnCount: 1, consolidatedCount: 0, semaCount: 0, datasetDate: String(now),
    _entityIndex: index, _countryCounts: { RU: 1 },
    _state: { observedAt: String(now), entryIds: ['SDN:1'] },
    _sourceSnapshots: { SDN: { records: [{ id: 'SDN:1' }] } },
    _sourceHealth: { SDN: { status: 'ok' } },
  };
  process.env.UPSTASH_REDIS_REST_URL = 'https://public-seed-fixture.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture-token';
  process.env.WM_SEED_RETRY_DELAY_MS = '0';
  process.exit = code => { throw Object.assign(new Error('fixture exit'), { exitCode: code }); };
  console.log = console.warn = () => {};
  function command([op, key, value]) {
    if (op === 'SET') { store.set(key, value); return 'OK'; }
    if (op === 'GET') return store.get(key) ?? null;
    if (op === 'DEL') return Number(store.delete(key));
    if (op === 'EXPIRE' || op === 'EVAL') return 1;
    throw new Error(`Unexpected fixture command ${op}`);
  }
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(new URL(url).hostname, 'public-seed-fixture.test', 'real network is prohibited');
    const match = String(url).match(/\/get\/([^/?#]+)$/);
    if (match) return Response.json({ result: store.get(decodeURIComponent(match[1])) ?? null });
    const body = JSON.parse(init.body);
    return Response.json(Array.isArray(body[0])
      ? body.map(item => ({ result: command(item) }))
      : { result: command(body) });
  };
  try {
    await assert.rejects(runSeed('sanctions', 'entities', 'sanctions:entities:v1', async () => data, options),
      error => error.exitCode === 0);
    const publication = JSON.parse(store.get('sanctions:entities:v1'));
    assert.deepEqual(publication.data, index);
    assert.equal(publication._seed.recordCount, 1);
    assert.deepEqual(JSON.parse(store.get('sanctions:country-counts:v1')), { RU: 1 });
    assert.ok(store.has('sanctions:source-snapshots:v1'));
    assert.ok(store.has('sanctions:entity-state:v1'));
    assert.equal(store.has('sanctions:pressure:v1'), false);
  } finally {
    globalThis.fetch = original.fetch;
    process.exit = original.exit;
    console.log = original.log;
    console.warn = original.warn;
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    for (const listener of process.rawListeners('SIGTERM')) if (!listeners.has(listener)) process.removeListener('SIGTERM', listener);
  }
});
