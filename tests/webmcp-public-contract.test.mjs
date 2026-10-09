import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const parse = (path) => ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true);

// Independently audited public contract: never derive the expected inventory
// from the production builder or its canonical-name configuration.
const PUBLIC_TOOLS = [
  'apply_mission_preset',
  'create_dashboard_tab',
  'delete_dashboard_tab',
  'focus_country',
  'get_access_context',
  'get_dashboard_context',
  'get_panel_layout',
  'list_dashboard_panels',
  'list_dashboard_tabs',
  'list_followed_countries',
  'list_map_layers',
  'list_mission_presets',
  'move_panel',
  'openCountryBrief',
  'openSearch',
  'open_alerts',
  'open_dashboard_panel',
  'open_mission_picker',
  'open_search_result',
  'open_settings',
  'rename_dashboard_tab',
  'search_dashboard',
  'select_dashboard_tab',
  'set_country_followed',
  'set_map_layers',
  'set_map_mode',
  'set_map_view',
  'set_panel_collapsed',
  'set_panel_enabled',
  'set_panel_fullscreen',
  'set_time_range',
  'switch_monitor',
];

function findNode(root, predicate) {
  if (predicate(root)) return root;
  return ts.forEachChild(root, (child) => findNode(child, predicate));
}

function variable(root, name) {
  const declaration = findNode(root, (node) => (
    ts.isVariableDeclaration(node) && node.name.getText() === name
  ));
  assert.ok(declaration?.initializer, `${name} must have an initializer`);
  return declaration.initializer;
}

test('browser and production inventories independently match the 32 public tools', () => {
  const browserNames = variable(parse('e2e/webmcp.spec.ts'), 'DASHBOARD_TOOL_NAMES');
  assert.ok(ts.isArrayLiteralExpression(browserNames), 'browser fixture must remain a literal');
  assert.deepEqual(browserNames.elements.map((node) => {
    assert.ok(ts.isStringLiteral(node), 'browser expectations must not use production constants');
    return node.text;
  }), PUBLIC_TOOLS);

  const canonical = variable(parse('src/config/webmcp.ts'), 'WEBMCP_SPA_TOOL');
  assert.ok(ts.isCallExpression(canonical));
  const argument = canonical.arguments[0];
  const names = ts.isAsExpression(argument) ? argument.expression : argument;
  assert.ok(ts.isObjectLiteralExpression(names));
  const byKey = new Map(names.properties.map((property) => {
    assert.ok(ts.isPropertyAssignment(property) && ts.isStringLiteral(property.initializer));
    return [property.name.getText(), property.initializer.text];
  }));
  assert.deepEqual([...byKey.values()].sort(), PUBLIC_TOOLS);
  const builder = findNode(parse('src/services/webmcp.ts'), (node) => (
    ts.isFunctionDeclaration(node) && node.name?.text === 'buildWebMcpTools'
  ));
  assert.ok(builder?.body);
  const tools = variable(builder.body, 'tools');
  assert.ok(ts.isArrayLiteralExpression(tools));
  const builtNames = tools.elements.map((tool) => {
    assert.ok(ts.isObjectLiteralExpression(tool));
    const name = tool.properties.find((property) => property.name?.getText() === 'name');
    assert.ok(name && ts.isPropertyAssignment(name));
    assert.ok(ts.isPropertyAccessExpression(name.initializer));
    assert.equal(name.initializer.expression.getText(), 'WEBMCP_SPA_TOOL');
    assert.ok(byKey.has(name.initializer.name.text));
    return byKey.get(name.initializer.name.text);
  });
  assert.deepEqual(builtNames.sort(), PUBLIC_TOOLS);
  assert.equal(new Set(builtNames).size, 32);
});

// Execute only reviewed pure modules in a closed VM. Unexpected dependencies
// fail rather than importing the app, Vite config, or environment loaders.
function loadPureModule(path, globals = {}, dependencies = {}) {
  const exports = {};
  const compiled = ts.transpileModule(read(path), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(compiled, {
    ...globals,
    exports,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `unreviewed dependency: ${name}`);
      return dependencies[name];
    },
  }, { filename: path });
  return exports;
}

const plain = (value) => JSON.parse(JSON.stringify(value));

test('panels fixture survives the public tab loader without overwriting live preferences or reload state', () => {
  const helper = parse('e2e/helpers/webmcp-cancellation.ts');
  const recorder = findNode(helper, (node) => (
    ts.isFunctionDeclaration(node) && node.name?.text === 'installReadinessRecorder'
  ));
  assert.ok(recorder?.body);
  const registration = findNode(recorder.body, (node) => (
    ts.isCallExpression(node) && node.expression.getText() === 'page.addInitScript'
  ));
  assert.ok(registration?.arguments[0]);
  const compiled = ts.transpileModule(
    `const init = ${registration.arguments[0].getText()}; init(panelsWorkspace);`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const preferences = {
    markets: { name: 'Markets', enabled: true, priority: 1 },
    giving: { name: 'Global Giving', enabled: false, priority: 2 },
  };
  const storage = new Map([
    ['worldmonitor-panels', JSON.stringify(preferences)],
    ['worldmonitor-panel-order', JSON.stringify(['markets', 'giving'])],
  ]);
  const localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  };
  const seed = (panelsWorkspace) => runInNewContext(compiled, { localStorage, panelsWorkspace });
  seed(false);
  assert.equal(localStorage.getItem('worldmonitor-tabs-v1:full'), null,
    'map-only scenarios must retain the production default');
  seed(true);
  const snapshot = JSON.parse(localStorage.getItem('worldmonitor-tabs-v1:full'));
  assert.ok(snapshot, 'visible-panel scenarios must seed a panels workspace before boot');
  assert.equal(snapshot.tabs.length, 1);
  const tab = snapshot.tabs[0];
  assert.equal(snapshot.activeTabId, tab.id);
  assert.match(tab.id, /^tab-[a-z0-9]+-[a-z0-9]+$/);
  assert.equal(tab.view, 'panels');
  assert.ok(tab.panelSettings && typeof tab.panelSettings === 'object');
  assert.ok(Array.isArray(tab.panelOrder));
  assert.ok(Array.isArray(tab.bottomSet));

  const publicPreferences = loadPureModule('src/services/public-preferences.ts', {}, {
    '@/config/panels': { ALL_PANELS: preferences },
  });
  const { loadTabsState } = loadPureModule('src/services/tab-store.ts', { localStorage }, {
    '@/config/variant': { SITE_VARIANT: 'full' },
    '@/services/public-preferences': publicPreferences,
  });
  assert.equal(loadTabsState().tabs[0].view, 'panels',
    'the actual public loader must preserve the explicit panels view');
  assert.deepEqual(JSON.parse(localStorage.getItem('worldmonitor-panels')), preferences);
  assert.deepEqual(JSON.parse(localStorage.getItem('worldmonitor-panel-order')), ['markets', 'giving']);

  snapshot.tabs[0].name = 'Renamed after mutation';
  snapshot.tabs[0].panelOrder = ['giving', 'markets'];
  localStorage.setItem('worldmonitor-tabs-v1:full', JSON.stringify(snapshot));
  const persisted = localStorage.getItem('worldmonitor-tabs-v1:full');
  seed(true);
  assert.equal(localStorage.getItem('worldmonitor-tabs-v1:full'), persisted,
    'reload must not reset the workspace under test');
  localStorage.setItem('worldmonitor-panels', JSON.stringify({
    ...preferences, giving: { ...preferences.giving, enabled: true },
  }));
  seed(true);
  assert.equal(JSON.parse(localStorage.getItem('worldmonitor-panels')).giving.enabled, true,
    'reload must not reset live panel mutations');
});

test('panel-dependent browser scenarios opt in to the fixture before navigation without storage resets', () => {
  const browser = parse('e2e/webmcp.spec.ts');
  for (const title of [
    'persists a first-session panel move through reload',
    'persists set_panel_enabled in dashboard settings across reload',
    'applies panel layout mutations and proves visible order and state',
  ]) {
    const scenario = findNode(browser, (node) => (
      ts.isCallExpression(node) && node.expression.getText() === 'test'
      && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === title
    ));
    assert.ok(scenario);
    const body = scenario.arguments[1].body;
    const setup = findNode(body, (node) => (
      ts.isCallExpression(node) && node.expression.getText() === 'installReadinessRecorder'
      && node.arguments[1]?.kind === ts.SyntaxKind.TrueKeyword
    ));
    const navigation = findNode(body, (node) => (
      ts.isCallExpression(node) && node.expression.getText() === 'page.goto'
    ));
    assert.ok(setup && navigation && setup.pos < navigation.pos, `${title}: opt in before boot`);
  }
  const helper = parse('e2e/helpers/webmcp-cancellation.ts');
  const cancellation = findNode(helper, (node) => (
    ts.isFunctionDeclaration(node) && node.name?.text === 'runWebMcpCancellationScenario'
  ));
  const setup = findNode(cancellation.body, (node) => (
    ts.isCallExpression(node) && node.expression.getText() === 'installReadinessRecorder'
    && node.arguments[1]?.kind === ts.SyntaxKind.TrueKeyword
  ));
  const navigation = findNode(cancellation.body, (node) => (
    ts.isCallExpression(node) && node.expression.getText() === 'page.goto'
  ));
  assert.ok(setup && navigation && setup.pos < navigation.pos, 'cancellation: opt in before boot');
  for (const source of [browser, helper]) {
    assert.equal(findNode(source, (node) => (
      ts.isCallExpression(node) && node.expression.getText() === 'localStorage.clear'
    )), undefined, 'independent init scripts must not erase the fixture');
  }
});

test('anonymous access stays public and uncapped above the historical quotas', () => {
  const { getWebMcpAccessContext } = loadPureModule('src/app/webmcp-access.ts');
  assert.deepEqual(plain(getWebMcpAccessContext({
    enabledPanelUsed: 48,
    dashboardTabCount: 8,
  })), {
    mode: 'public',
    capabilities: { dataExport: true },
    limits: {
      enabledPanels: { used: 48, cap: null },
      dashboardTabs: { used: 8, cap: null, canCreate: true },
    },
  });
});

test('anonymous follows exceed the former quota and retain validation and persistence errors', async () => {
  const numericCodes = loadPureModule('shared/country-numeric-codes.ts', {}, {
    '../scripts/shared/comtrade-reporter-overrides.json': {
      default: JSON.parse(read('scripts/shared/comtrade-reporter-overrides.json')),
    },
  });
  const codes = loadPureModule('src/utils/country-codes.ts', {}, {
    '../../shared/country-numeric-codes': numericCodes,
  });
  const storage = new Map();
  let storageFull = false;
  const events = [];
  const localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem(key, value) {
      if (storageFull) throw new Error('storage full');
      storage.set(key, value);
    },
  };
  const globals = {
    localStorage,
    Event,
    window: {
      addEventListener() {},
      dispatchEvent: (event) => events.push(event.type),
    },
  };
  const dependencies = { '@/utils/country-codes': codes };
  const follows = loadPureModule('src/services/followed-countries.ts', globals, dependencies);
  assert.equal(follows.isFollowFeatureEnabled(), true);
  const countries = ['DE', 'FR', 'GB', 'US', 'CA', 'JP', 'AU', 'BR', 'IN', 'IT', 'ES', 'NZ'];
  for (const code of countries) assert.deepEqual(plain(await follows.addCountry(code)), { ok: true });
  assert.deepEqual(plain(follows.getFollowed()), countries);
  await follows.addCountry(' de ');
  assert.deepEqual(plain(follows.getFollowed()), countries, 'following is idempotent');
  const reloaded = loadPureModule('src/services/followed-countries.ts', globals, dependencies);
  assert.deepEqual(plain(reloaded.getFollowed()), countries, 'fresh module reads persisted countries');
  assert.deepEqual(plain(await reloaded.removeCountry('DE')), { ok: true });
  assert.equal(reloaded.isFollowed('DE'), false);
  const beforeDenied = plain(reloaded.getFollowed());
  assert.deepEqual(plain(await reloaded.addCountry('ZZ')), { ok: false, reason: 'INVALID_INPUT' });
  storageFull = true;
  assert.deepEqual(plain(await reloaded.addCountry('DE')), { ok: false, reason: 'STORAGE_FULL' });
  assert.deepEqual(plain(reloaded.getFollowed()), beforeDenied);
  assert.ok(events.every((event) => event === 'wm-followed-countries-changed'));
  assert.equal(events.length, countries.length + 2, 'failed writes never publish a change');
});
