import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { retiredRouteResponse } from '../api/_retired-routes.js';
import {
  ACQUISITION_CLAIM_ROOTS,
  collectCurrentAcquisitionClaimFiles,
  computeStats,
  retainedExactContractCoverageFailures,
  validateVolatileInventoryClaims,
  VOLATILE_INVENTORY_CLAIM_RE,
} from '../scripts/docs-stats.mjs';
import { buildInventoryFacts, generateInventoryFacts, loadStatsForInventoryFacts } from '../scripts/generate-inventory-facts.mjs';
import { buildSourceAttributionStats, checkSourceAttribution } from '../scripts/source-attribution.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8');
const readJson = (path) => JSON.parse(read(path));

function makeInventoryFixture({ malformed = false } = {}) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'wm-inventory-fixture-'));
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  for (const path of tracked.split('\0').filter(Boolean)) {
    mkdirSync(dirname(join(fixtureRoot, path)), { recursive: true });
    cpSync(join(ROOT, path), join(fixtureRoot, path), { recursive: true, verbatimSymlinks: true });
  }
  const manifest = readJson('shared/source-attribution-manifest.json');
  const entry = manifest.entries.find((row) => row.observed && row.kind === 'structured');
  assert.ok(entry, 'fixture needs an observed structured source');
  entry.references = [{ path: 'scripts/stale-source.mjs' }];
  if (malformed) entry.kind = 'not-a-source-kind';
  writeFileSync(join(fixtureRoot, 'shared/source-attribution-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return fixtureRoot;
}

function runInventoryFixture(fixtureRoot, script = 'scripts/generate-inventory-facts.mjs', args = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: fixtureRoot,
    encoding: 'utf8',
    timeout: 30_000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
  });
}

const REQUIRED_ACQUISITION_CLAIM_ROOTS = [
  'README.ja-JP.md',
  'README.md',
  'README.zh-CN.md',
  'blog-site/src/content/blog',
  'cli',
  'docs',
  'index.html',
  'public',
  'public/.well-known/agent-skills',
  'public/.well-known/ai-catalog.json',
  'public/api/llms.txt',
  'scripts/build-agent-skills-index.mjs',
  'server.json',
];

function assertAcquisitionClaimRootClosure(actualRoots) {
  assert.deepEqual([...actualRoots].sort(), REQUIRED_ACQUISITION_CLAIM_ROOTS);
}

const REQUIRED_CURRENT_DOC_EXCLUDES = [
  'docs/Docs_To_Review/',
  'docs/api/',
  'docs/archive/',
  'docs/audits/',
  'docs/brainstorms/',
  'docs/generated/',
  'docs/ideation/',
  'docs/internal/',
  'docs/perf/',
  'docs/plans/',
  'docs/research/',
  'docs/solutions/',
];

function independentlyCollectCurrentDocs() {
  const paths = [];
  const visit = (path) => {
    if (REQUIRED_CURRENT_DOC_EXCLUDES.some((prefix) => path.startsWith(prefix))) return;
    if (['docs/changelog.mdx', 'docs/desktop-parity-matrix.md', 'docs/railway-seed-consolidation-runbook.md', 'docs/source-attribution.mdx', 'docs/zh/changelog.mdx'].includes(path)) return;
    const stat = statSync(join(ROOT, path));
    if (stat.isDirectory()) {
      for (const entry of readdirSync(join(ROOT, path))) visit(`${path}/${entry}`);
      return;
    }
    if (/\.(?:md|mdx)$/.test(path)) paths.push(path);
  };
  visit('docs');
  return paths.sort();
}

describe('public inventory facts generation contract', () => {

  it('keeps the acquisition claim scan on the complete registered root set', () => {
    assertAcquisitionClaimRootClosure(ACQUISITION_CLAIM_ROOTS);
    assert.throws(
      () => assertAcquisitionClaimRootClosure(
        ACQUISITION_CLAIM_ROOTS.filter((path) => path !== 'README.ja-JP.md'),
      ),
      /Expected values to be strictly deep-equal/,
      'deleting one registered acquisition root must fail closed',
    );
  });

  it('keeps recursive current documentation in the exact acquisition scan closure', () => {
    const expected = independentlyCollectCurrentDocs();
    const actual = collectCurrentAcquisitionClaimFiles().filter((path) => path.startsWith('docs/'));
    assert.deepEqual(actual, expected);
    assert.ok(actual.includes('docs/panels/news-feeds.mdx'), 'nested panel docs must be scanned');
    assert.throws(
      () => assert.deepEqual(actual.filter((path) => path !== 'docs/panels/news-feeds.mdx'), expected),
      /Expected values to be strictly deep-equal/,
      'deleting one nested current documentation surface must fail closed',
    );
  });

  it('fails closed when a retained exact contract disappears', () => {
    const contract = { path: 'docs/fixed-protocol.mdx', text: /six fixed fields/ };
    assert.deepEqual(retainedExactContractCoverageFailures([contract], new Set([contract])), []);
    assert.deepEqual(
      retainedExactContractCoverageFailures([contract], new Set()),
      ['docs/fixed-protocol.mdx: retained exact count contract is missing or changed: /six fixed fields/'],
    );
  });

  it('fails closed when any retained public inventory extractor collapses to zero', () => {
    const stats = computeStats();
    const capabilityStatKeys = [
      'locales',
      'variantCount',
      'layerDefinitions',
      'panelClasses',
      'feedDefinitions',
      'freshnessSources',
      'sourceAttributionHosts',
    ];
    for (const key of capabilityStatKeys) {
      assert.throws(
        () => buildInventoryFacts({ ...stats, [key]: 0 }),
        /must be an integer >= 1/,
        `${key} parser collapse must fail generation`,
      );
    }
    assert.throws(
      () => buildInventoryFacts({
        ...stats,
        sourceAttribution: { ...stats.sourceAttribution, providerCount: 0 },
      }),
      /must be an integer >= 1/,
      'provider parser collapse must fail generation',
    );
    assert.throws(
      () => buildInventoryFacts({ ...stats, localeCodes: [] }),
      /localeCodes must be a non-empty unique locale-code registry/,
      'locale membership extraction must not collapse while its count stays positive',
    );
  });

  it('allows zero retired product MCP tools without weakening retained inventory validation', () => {
    const stats = computeStats();
    assert.equal(stats.mcpToolCount, 0);
    assert.equal(buildInventoryFacts(stats).capabilities.mcpTools, 0);
    for (const invalid of [-1, 0.5, undefined, NaN]) {
      assert.throws(
        () => buildInventoryFacts({ ...stats, mcpToolCount: invalid }),
        /inventory capability mcpTools must be an integer >= 0/,
      );
    }
  });

  it('keeps retired product MCP discovery and account routes explicitly denied', async () => {
    for (const path of ['/api/mcp', '/mcp', '/a2a', '/.well-known/mcp/server-card.json']) {
      const response = retiredRouteResponse(new Request(`https://worldmonitor.app${path}`));
      assert.ok(response, path);
      assert.equal(response.status, 403, path);
      assert.equal((await response.json()).error, 'feature_removed', path);
      assert.match(response.headers.get('Cache-Control'), /private.*no-store/);
    }
  });

  it('fails the inventory check for missing or stale build outputs', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'wm-inventory-facts-'));
    mkdirSync(join(tempRoot, 'api'));
    mkdirSync(join(tempRoot, 'public'));
    const expected = new Map([
      ['api/_inventory-facts.generated.js', 'edge'],
      ['public/product-facts.json', 'public'],
    ]);
    try {
      assert.throws(
        () => generateInventoryFacts({ check: true, outputs: expected, rootDir: tempRoot }),
        /missing or stale: api\/_inventory-facts\.generated\.js, public\/product-facts\.json/,
      );
      generateInventoryFacts({ outputs: expected, rootDir: tempRoot });
      assert.doesNotThrow(() => (
        generateInventoryFacts({ check: true, outputs: expected, rootDir: tempRoot })
      ));
      writeFileSync(join(tempRoot, 'api/_inventory-facts.generated.js'), 'stale');
      assert.throws(
        () => generateInventoryFacts({ check: true, outputs: expected, rootDir: tempRoot }),
        /missing or stale: api\/_inventory-facts\.generated\.js/,
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('stops consumers on an interrupted publication and repairs it on the next run', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'wm-inventory-facts-interrupted-'));
    mkdirSync(join(tempRoot, 'api'));
    mkdirSync(join(tempRoot, 'public'));
    const expected = new Map([
      ['api/_inventory-facts.generated.js', 'edge'],
      ['public/product-facts.json', 'public'],
    ]);
    let renames = 0;
    let consumerRan = false;
    const interruptedFileOps = {
      mkdirSync,
      writeFileSync,
      unlinkSync,
      renameSync(from, to) {
        renames += 1;
        if (renames === 2) throw new Error('simulated publication interruption');
        renameSync(from, to);
      },
    };
    try {
      assert.throws(() => {
        generateInventoryFacts({ outputs: expected, rootDir: tempRoot, fileOps: interruptedFileOps });
        consumerRan = true;
      }, /simulated publication interruption/);
      assert.equal(consumerRan, false, 'a failed generator must stop the next consumer command');
      assert.equal(readFileSync(join(tempRoot, 'api/_inventory-facts.generated.js'), 'utf8'), 'edge');
      assert.equal(existsSync(join(tempRoot, `public/product-facts.json.tmp-${process.pid}`)), false);
      assert.throws(
        () => generateInventoryFacts({ check: true, outputs: expected, rootDir: tempRoot }),
        /public\/product-facts\.json/,
      );
      generateInventoryFacts({ outputs: expected, rootDir: tempRoot });
      assert.doesNotThrow(() => generateInventoryFacts({ check: true, outputs: expected, rootDir: tempRoot }));
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('publishes all default inventory outputs from a stale but structurally valid attribution ledger', () => {
    const fixtureRoot = makeInventoryFixture();
    try {
      const strict = checkSourceAttribution(fixtureRoot);
      assert.ok(strict.errors.length > 0, 'strict source attribution checking must remain red for parity drift');
      assert.match(strict.errors.join('\n'), /stale manifest entry/);

      const result = runInventoryFixture(fixtureRoot);
      assert.equal(result.status, 0, result.stderr);
      const outputs = [
        'public/product-facts.json',
        'scripts/shared/inventory-facts.generated.json',
        'api/_inventory-facts.generated.js',
        'docs/generated/stats.json',
      ];
      const original = outputs.map((path) => readFileSync(join(fixtureRoot, path), 'utf8'));
      const publicFacts = JSON.parse(original[0]);
      const relayFacts = JSON.parse(original[1]);
      const stats = JSON.parse(original[3]);
      assert.deepEqual(publicFacts.capabilities, relayFacts.capabilities);
      assert.equal(publicFacts.capabilities.sourceAttributionHosts, stats.sourceAttributionHosts);
      assert.equal(stats.sourceAttributionHosts, buildSourceAttributionStats({ rootDir: fixtureRoot, validate: false }).activeHosts);
      const edge = runInventoryFixture(fixtureRoot, '--input-type=module', ['-e',
        "import { PUBLIC_INVENTORY_FACTS } from './api/_inventory-facts.generated.js'; console.log(JSON.stringify(PUBLIC_INVENTORY_FACTS));",
      ]);
      assert.equal(edge.status, 0, edge.stderr);
      assert.deepEqual(JSON.parse(edge.stdout), relayFacts);
      assert.match(result.stderr, /proceeding with committed attribution counts/);
      for (const args of [[], ['--check']]) {
        const replay = runInventoryFixture(fixtureRoot, 'scripts/generate-inventory-facts.mjs', args);
        assert.equal(replay.status, 0, replay.stderr);
        assert.deepEqual(outputs.map((path) => readFileSync(join(fixtureRoot, path), 'utf8')), original);
      }
      const strictCli = runInventoryFixture(fixtureRoot, 'scripts/source-attribution.mjs', ['--check']);
      assert.notEqual(strictCli.status, 0, 'bootstrap must not weaken the strict attribution gate');
      assert.match(strictCli.stderr + strictCli.stdout, /stale manifest entry/);

      writeFileSync(join(fixtureRoot, 'src/config/finance-geo.ts'), 'export const UNRELATED = [];\n');
      const brokenInventory = runInventoryFixture(fixtureRoot);
      assert.notEqual(brokenInventory.status, 0);
      assert.match(brokenInventory.stderr, /could not isolate STOCK_EXCHANGES/);
      assert.deepEqual(outputs.map((path) => readFileSync(join(fixtureRoot, path), 'utf8')), original);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('does not swallow non-attribution inventory failures', () => {
    assert.throws(
      () => loadStatsForInventoryFacts({
        compute: () => {
          throw new Error('docs-stats: could not isolate STOCK_EXCHANGES block');
        },
      }),
      /STOCK_EXCHANGES/,
    );
  });

  it('does not publish inventory outputs from a malformed attribution ledger', () => {
    const fixtureRoot = makeInventoryFixture({ malformed: true });
    try {
      const strict = checkSourceAttribution(fixtureRoot);
      assert.ok(strict.errors.length > 0, 'strict source attribution checking must reject malformed ledger entries');
      assert.match(strict.errors.join('\n'), /invalid manifest kind/);

      const result = runInventoryFixture(fixtureRoot);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /invalid manifest kind/);
      for (const path of [
        'public/product-facts.json',
        'scripts/shared/inventory-facts.generated.json',
        'api/_inventory-facts.generated.js',
        'docs/generated/stats.json',
      ]) {
        assert.equal(existsSync(join(fixtureRoot, path)), false, `malformed ledger published ${path}`);
      }
      assert.doesNotMatch(result.stderr, /proceeding with committed attribution counts/);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('publishes public metadata and registry-derived build-owned inventory facts', () => {
    const publicFacts = readJson('public/product-facts.json');
    const relayInventory = readJson('scripts/shared/inventory-facts.generated.json');
    const stats = computeStats();

    assert.deepEqual(
      Object.fromEntries(Object.entries(publicFacts).filter(([key]) => key !== 'capabilities')),
      { name: 'World Monitor', version: readJson('package.json').version, publicOnly: true },
    );
    assert.deepEqual(publicFacts.capabilities, relayInventory.capabilities);
    assert.deepEqual(publicFacts.capabilities, {
      mcpTools: stats.mcpToolCount,
      locales: stats.locales,
      variants: stats.variantCount,
      mapLayers: stats.layerDefinitions,
      panelImplementations: stats.panelClasses,
      feedDefinitions: stats.feedDefinitions,
      freshnessTrackedSourceGroups: stats.freshnessSources,
      sourceAttributionHosts: stats.sourceAttributionHosts,
      sourceAttributionProviders: stats.sourceAttribution.providerCount,
      localeCodes: stats.localeCodes,
    });
  });

  it('keeps volatile inventory totals out of hand-authored acquisition copy', () => {
    const violations = validateVolatileInventoryClaims();
    assert.deepEqual(
      violations,
      [],
      `hand-authored acquisition copy must use registry-derived or semantic inventory wording:\n${violations.join('\n')}`,
    );
    for (const claim of [
      '30+ live services',
      '500+ curated news feeds',
      '25+ other live services',
      '12+ data source credentials',
      'MCP offers 52 tools',
      'There are 445 API handlers',
      '80+ Vercel Edge Functions',
      '190+ documented operations',
      '24 typed services',
      '26 OSINT channels',
      '31 live webcams',
      'seven live news channels',
      'Panels: 102',
      'six specialized variants',
      'five dashboard variants',
      'five interchangeable surfaces',
      '34 proto-backed domains',
      '27 positive-news feeds',
      '28 supported languages',
      '44 data layers',
      '44 other intelligence layers',
      '20+ separate services',
      '| Live video streams | 8 |',
      '| Languages supported | 27 (including RTL) |',
      '| Airports monitored | 111 |',
      '52個のMCPツール',
      '52個のMCPツールも使える',
      '52個のMCPツールから選べる',
      '52個のMCPツールまで対応',
      '52個のMCPツールより多い',
      '60以上のVercel Edge Functions',
      '6つのダッシュボード',
      '313のAIデータセンターを電力・運営者メタデータ付きでマッピング',
      '26 个 OSINT 频道',
      '210+ military bases',
      '38+ associated military bases',
      '9 strategic theaters',
      '210+ 基地数据库',
      '56-channel Telegram OSINT feed',
      '62 strategic ports',
      '88 mapped pipelines',
      '13 monitored waterways',
      '~100 tracked satellites',
      '80–120 intelligence satellites',
      '25 installable agent skills',
      '跨 30+ 实时服务',
      '500 多个实时数据源',
      '25 个可安装智能体技能',
      '25 个公开智能体配方',
      'Vercel Edge Functions（60+）',
      'Vercel Edge Functions (60 以上)',
    ]) {
      assert.match(claim, VOLATILE_INVENTORY_CLAIM_RE, `modifier form must remain guarded: ${claim}`);
    }
  });

  it('keeps build-owned generated inventory facts fresh', () => {
    assert.doesNotThrow(() => {
      execFileSync(
        process.execPath,
        ['scripts/generate-inventory-facts.mjs', '--check'],
        { cwd: ROOT, stdio: 'pipe' },
      );
    });
  });

  it('derives published source counts from active source provenance, not retired marketing facts', async () => {
    const { loadManifest, scanUpstreamHosts, sourceAttributionStats } = await import('../scripts/source-attribution.mjs');
    const stats = sourceAttributionStats(scanUpstreamHosts(ROOT), loadManifest(ROOT));
    const facts = readJson('public/product-facts.json');
    assert.equal(facts.capabilities.sourceAttributionHosts, stats.activeHosts);
    assert.equal(facts.capabilities.sourceAttributionProviders, stats.providerCount);
    const coverage = read('public/ai-search.md');
    assert.ok(coverage.includes(`- ${stats.providerCount.toLocaleString('en-US')} active data providers across ${stats.activeHosts.toLocaleString('en-US')} observed source hosts`));
    assert.ok(coverage.includes(`${stats.feedHosts.toLocaleString('en-US')} news & OSINT feed`));
  });

  it('derives public coverage counts from live registries, not retired depth proof stats', async () => {
    const { AI_DATA_CENTERS } = await import('../src/config/ai-datacenters.ts');
    const { CHOKEPOINT_REGISTRY } = await import('../src/config/chokepoint-registry.ts');
    const { UNDERSEA_CABLES } = await import('../src/config/geo-map.ts');
    const { getCompleteLayerCatalogKeys } = await import('../src/config/map-layer-definitions.ts');
    const { INTEL_HOTSPOTS } = await import('../shared/geo-data.ts');
    const { PIPELINES } = await import('../shared/pipelines-data.ts');
    const { lngFacilityCount } = await import('../scripts/_storage-facility-registry.mjs');
    const { publishedRankedCountries } = await import('../scripts/build-ai-search.mjs');
    const coverage = read('public/ai-search.md');
    const stats = computeStats();
    const fullLayers = getCompleteLayerCatalogKeys('full').length;
    assert.ok(coverage.includes(`- ${stats.layerDefinitions} map layer types in the shared registry`));
    assert.ok(coverage.includes(stats.layerDefinitions === fullLayers
      ? 'all of them reachable in the full variant'
      : `${fullLayers} of them reachable in the full variant`));
    for (const [count, label] of [
      [CHOKEPOINT_REGISTRY.length, 'maritime chokepoints'],
      [stats.tier1Countries, 'countries scored by the Country Instability Index'],
      [UNDERSEA_CABLES.length, 'submarine cable routes'],
      [PIPELINES.length + lngFacilityCount(), 'pipelines and LNG assets'],
      [AI_DATA_CENTERS.length, 'AI datacenters mapped'],
      [INTEL_HOTSPOTS.length, 'scored geopolitical hotspots'],
      [stats.stockExchangeCount, 'stock exchanges in the markets registry'],
      [stats.mcpToolCount, 'MCP tools'],
      [stats.locales, 'supported interface languages'],
    ]) {
      assert.ok(coverage.includes(`- ${count.toLocaleString('en-US')} ${label}`), label);
    }
    assert.ok(coverage.includes(`${publishedRankedCountries(ROOT).ranked} are ranked in the published snapshot`));
  });

  it('counts command palette entries and per-country commands without silent census collapse', async () => {
    const { commandPaletteCommandCount } = await import('../scripts/lib/command-palette-count.mjs');
    const source = `export const COMMANDS: Command[] = [
  { id: 'map', icon: 'map' },
  { id: 'news', icon: 'news' },
];
const ISO_CODES = [
  'US', 'JP',
];`;
    assert.equal(commandPaletteCommandCount({ source }), 6);
    assert.throws(
      () => commandPaletteCommandCount({ source: source.replace("icon: 'news'", "label: 'News'") }),
      /counted 2 id entries but 1 icon entries/,
    );
    assert.throws(
      () => commandPaletteCommandCount({ source: source.replace("'JP'", "'invalid'") }),
      /ISO_CODES yielded 1 two-letter codes of 2 quoted strings/,
    );
  });

  it('fails closed when the command palette registry cannot be counted', async () => {
    const { commandPaletteCommandCount } = await import('../scripts/lib/command-palette-count.mjs');
    assert.throws(
      () => commandPaletteCommandCount({ source: 'export const UNRELATED = 1;' }),
      /could not isolate the COMMANDS array/,
    );
  });
});
