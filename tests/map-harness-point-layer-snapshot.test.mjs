import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/e2e/map-harness.ts', import.meta.url), 'utf8');
const start = source.indexOf('const normalizeLayerSnapshotId =');
const end = source.indexOf('const waitAnimationFrames =', start);
assert.ok(start >= 0 && end > start, 'the real map harness snapshot implementation must be present');
const script = ts.transpileModule(`${source.slice(start, end)}\ngetDeckLayerSnapshot();`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

const snapshot = (layers) => JSON.parse(JSON.stringify(runInNewContext(script, {
  internals: { buildLayers: () => layers },
  getDataCount: (data) => data.length,
})));
const layer = (id, count) => ({ id, props: { data: Array.from({ length: count }, () => ({})) } });
const diagnosticStart = source.indexOf('const getLayerFirstScreenTransform =');
const diagnosticEnd = source.indexOf('const getProtestClusterCount =', diagnosticStart);
assert.ok(diagnosticStart >= 0 && diagnosticEnd > diagnosticStart, 'the real point-layer diagnostics must be present');
const diagnosticScript = ts.transpileModule(
  `${source.slice(start, end)}\n${source.slice(diagnosticStart, diagnosticEnd)}
  ({ title: getFirstProtestTitle(), transform: getLayerFirstScreenTransform('protest-clusters-layer') });`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;
const diagnostics = (layers) => JSON.parse(JSON.stringify(runInNewContext(diagnosticScript, {
  internals: {
    buildLayers: () => layers,
    maplibreMap: { project: ([x, y]) => ({ x, y }) },
  },
  getDataCount: (data) => data.length,
})));

test('singleton pictograms remain visible through their logical layer snapshot', () => {
  assert.deepEqual(snapshot([
    layer('protest-clusters-layer', 0),
    layer('protest-clusters-layer-singletons', 3),
    layer('protest-clusters-layer', 0),
  ]), [{ id: 'protest-clusters-layer', dataCount: 3 }]);
});

test('mixed cluster and singleton counts are combined without counting ghost duplicates', () => {
  assert.deepEqual(snapshot([
    layer('protest-clusters-layer', 2),
    layer('protest-clusters-layer-singletons', 3),
    layer('protest-clusters-layer', 0),
    layer('protest-clusters-layer-singletons', 3),
  ]), [{ id: 'protest-clusters-layer', dataCount: 5 }]);
});

test('an empty ghost and empty pictogram do not certify a ready visual scenario', () => {
  assert.deepEqual(snapshot([
    layer('protest-clusters-layer', 0),
    layer('protest-clusters-layer-singletons', 0),
  ]), []);
});

test('country geometry retains its existing conflict-layer identity and population', () => {
  assert.deepEqual(snapshot([
    layer('conflict-zones-layer', 0),
    layer('conflict-zones-layer-country-geometry', 4),
    layer('conflict-zones-layer', 0),
  ]), [{ id: 'conflict-zones-layer', dataCount: 4 }]);
});

test('point-layer diagnostics use the actual singleton when the cluster parent is empty', () => {
  assert.deepEqual(diagnostics([
    layer('protest-clusters-layer', 0),
    {
      id: 'protest-clusters-layer-singletons',
      props: { data: [{ lon: 11, lat: 22, items: [{ title: 'Public protest fixture' }] }] },
    },
    layer('protest-clusters-layer', 0),
  ]), { title: 'Public protest fixture', transform: 'translate(11.00px, 22.00px)' });
});

test('point-layer diagnostics do not invent a location or title for empty layers', () => {
  assert.deepEqual(diagnostics([
    layer('protest-clusters-layer', 0),
    layer('protest-clusters-layer-singletons', 0),
  ]), { title: null, transform: null });
});
