import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { CONTENT_ATTRIBUTION_STORAGE_KEY } from '../shared/content-attribution.ts';
import { FakeWebMcpModelContext } from './helpers/fake-webmcp-model-context.mjs';
import { WEBMCP_SPA_TOOL_NAMES } from '../src/config/webmcp.ts';
import {
  DashboardBindingError,
  buildWebMcpTools as buildProductionWebMcpTools,
  registerWebMcpTools,
} from '../src/services/webmcp.ts';

class MemoryStorage {
  #values = new Map();

  getItem(key) { return this.#values.get(key) ?? null; }
  setItem(key, value) { this.#values.set(key, value); }
  removeItem(key) { this.#values.delete(key); }
}

const settlePromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
};

function buildWebMcpTools(app, track) {
  return buildProductionWebMcpTools(app, track).map((tool) => ({
    ...tool,
    execute(input, context = { signal: new AbortController().signal }) {
      return tool.execute(input, context);
    },
  }));
}

function createBindings(overrides = {}) {
  return {
    openCountryBriefByCode: async () => true,
    resolveCountryName: (code) => `Country ${code}`,
    openSearch: async () => true,
    getDashboardContext: async () => ({
      variant: 'full',
      map: {
        view: 'global',
        center: { lat: 0, lon: 0 },
        zoom: 2,
        timeRange: '7d',
        enabledLayers: [],
      },
      panels: { mounted: ['map'], enabled: ['map'] },
    }),
    listMapLayerCatalog: async () => ({
      variant: 'full',
      rendererKind: 'deck',
      enabledLayers: [],
      liveLayerKeys: ['conflicts', 'weather'],
      hasPremium: false,
      deckGlActive: true,
    }),
    listDashboardPanels: async () => ({
      variant: 'full',
      total: 1,
      hasMore: false,
      nextCursor: null,
      panels: [{
        id: 'map',
        label: 'Map',
        category: 'core',
        variants: ['full'],
        enabled: true,
        mounted: true,
        entitled: true,
        available: true,
      }],
    }),
    switchMonitor: async (monitor) => ({
      ok: true,
      status: 'applied',
      destination: monitor,
      navigation: 'none',
      message: 'Already on that monitor.',
      context: {
        variant: monitor,
        map: {
          view: 'global',
          center: { lat: 0, lon: 0 },
          zoom: 2,
          timeRange: '7d',
          enabledLayers: [],
        },
        panels: { mounted: ['map'], enabled: ['map'] },
      },
    }),
    openSettings: async () => ({
      ok: true,
      status: 'applied',
      destination: 'settings',
      overlay: 'open',
      tab: 'settings',
      message: 'Opened settings.',
      context: {
        variant: 'full',
        map: {
          view: 'global',
          center: { lat: 0, lon: 0 },
          zoom: 2,
          timeRange: '7d',
          enabledLayers: [],
        },
        panels: { mounted: ['map'], enabled: ['map'] },
      },
    }),
    openAlerts: async () => ({
      ok: true,
      status: 'applied',
      destination: 'alerts',
      overlay: 'open',
      tab: 'notifications',
      message: 'Opened alerts.',
      context: {
        variant: 'full',
        map: {
          view: 'global',
          center: { lat: 0, lon: 0 },
          zoom: 2,
          timeRange: '7d',
          enabledLayers: [],
        },
        panels: { mounted: ['map'], enabled: ['map'] },
      },
    }),
    applyDashboardAction: async (action) => ({
      ok: true,
      status: 'applied',
      actionType: action.type,
      message: 'Applied.',
      targets: [],
    }),
    searchDashboard: async (query) => ({
      queryLength: query.length,
      results: [],
      resultCount: 0,
      truncated: false,
    }),
    openSearchResult: async () => ({ ok: true, status: 'opened' }),
    listMissionPresets: async () => ({
      ok: true,
      variant: 'full',
      activePresetId: null,
      presets: [],
      count: 0,
    }),
    applyMissionPreset: async () => ({
      ok: true,
      status: 'applied',
      presetId: 'supply-chain-risk',
      label: 'Supply-Chain Risk',
      changed: false,
      monitor: 'full',
      message: 'Unused mission preset binding.',
    }),
    openMissionPicker: async () => ({
      ok: true,
      status: 'applied',
      destination: 'mission_picker',
      overlay: 'open',
      message: 'Opened mission presets.',
      context: {
        variant: 'full',
        map: {
          view: 'global',
          center: { lat: 0, lon: 0 },
          zoom: 2,
          timeRange: '7d',
          enabledLayers: [],
        },
        panels: { mounted: ['map'], enabled: ['map'] },
      },
    }),
    listFollowedCountries: async () => ({
      ok: true,
      enabled: true,
      countries: ['DE'],
      count: 1,
      access: 'free',
      limit: 3,
    }),
    setCountryFollowed: async (iso2, followed) => ({
      ok: true,
      status: 'accepted',
      iso2,
      followed,
      message: 'Followed-country state accepted.',
    }),

    getPanelLayout: async () => ({
      regions: {
        sidebar: { available: true, panelCount: 1 },
        bottom: { available: false, panelCount: 0 },
      },
      panels: [{
        id: 'giving',
        region: 'sidebar',
        index: 0,
        collapsed: false,
        fullscreen: false,
        collapsible: false,
        fullscreenCapable: false,
        fixed: false,
      }],
      panelCount: 1,
    }),
    setPanelCollapsed: async () => ({
      ok: true,
      status: 'applied',
      actionType: 'set_collapsed',
      panelId: 'live-news',
      requestedCollapsed: true,
      effectiveCollapsed: true,
      changed: true,
      message: 'Panel collapsed.',
      persisted: true,
    }),
    movePanel: async () => ({
      ok: true,
      status: 'applied',
      actionType: 'move',
      panelId: 'giving',
      region: 'sidebar',
      index: 0,
      changed: true,
      message: 'Moved panel.',
      persisted: true,
    }),
    setPanelFullscreen: async () => ({
      ok: true,
      status: 'applied',
      actionType: 'set_fullscreen',
      panelId: 'live-news',
      requestedFullscreen: true,
      effectiveFullscreen: true,
      changed: true,
      message: 'Panel entered fullscreen.',
    }),
    getAccessContext: async () => ({
      accountState: 'signed_out',
      clerk: 'unavailable',
      productTier: 'anonymous',
      capabilities: {
        premiumAccess: false,
        apiAccess: false,
        mcpAccess: false,
        dataExport: false,
      },
      limits: {
        enabledPanels: { used: 1, cap: 40 },
        dashboardTabs: { used: 1, cap: 3, canCreate: true },
      },
    }),
    openSignIn: async () => ({ ok: false, status: 'denied', reason: 'clerk_unavailable' }),
    ...overrides,
  };
}

async function executeRegistered(provider, name, inputJson = '{}') {
  const descriptor = (await provider.getTools()).find((tool) => tool.name === name);
  assert.ok(descriptor, `missing registered WebMCP tool ${name}`);
  return provider.executeTool(descriptor, inputJson);
}

afterEach(() => {
  delete globalThis.window;
  delete globalThis.location;
});

describe('WebMCP analytics privacy policy', () => {
  it('keeps registration and tool execution independent of an ambient external tracker', async () => {
    const storage = new MemoryStorage();
    storage.setItem(CONTENT_ATTRIBUTION_STORAGE_KEY, JSON.stringify({
      source: 'PRIVATE_CONTENT_SOURCE',
      medium: 'PRIVATE_CONTENT_MEDIUM',
      campaign: 'PRIVATE_CONTENT_CAMPAIGN',
      destination: 'dashboard',
      placement: 'PRIVATE_CONTENT_PLACEMENT',
      landingPageFamily: 'PRIVATE_LANDING_FAMILY',
      capturedAt: Date.now(),
    }));
    const collected = [];
    const runtimeWindow = {
      sessionStorage: storage,
      localStorage: storage,
      addEventListener() {},
      umami: {
        track: (event, data) => { collected.push({ event, data }); },
        identify() {},
      },
    };
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: runtimeWindow,
    });
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { hostname: 'worldmonitor.app' },
    });
    const provider = new FakeWebMcpModelContext({
      supportsTargetExecutionSignal: true,
      registrationFailure: new Map([
        ['set_map_view', new DOMException('PRIVATE_HOST_FAILURE', 'AbortError')],
      ]),
    });
    const document = { modelContext: provider, addEventListener() {} };
    registerWebMcpTools(createBindings({
      searchDashboard: async (query) => ({
        queryLength: query.length,
        results: [{
          key: `sr_${'a'.repeat(32)}`,
          type: 'PRIVATE_UNBOUNDED_RESULT_TYPE',
          title: 'PRIVATE_RESULT_TITLE',
          subtitle: 'PRIVATE_RESULT_SUBTITLE',
          executable: true,
        }],
        resultCount: 1,
        truncated: false,
      }),
      openSearchResult: async () => ({
        ok: false,
        status: 'denied',
        reason: 'result_no_longer_available',
      }),
    }), { document, window: runtimeWindow });
    await settlePromises();

    await executeRegistered(provider, 'openSearch');
    await executeRegistered(provider, 'list_dashboard_panels', JSON.stringify({ limit: 1 }));
    await executeRegistered(provider, 'search_dashboard', JSON.stringify({
      query: 'PRIVATE_QUERY_TEXT',
      scope: 'all',
      limit: 1,
    }));
    await executeRegistered(provider, 'open_search_result', JSON.stringify({
      resultKey: `sr_${'a'.repeat(32)}`,
    }));
    assert.deepEqual(collected, [], "No registration or invocation reaches the ambient tracker.");
  });

  it('maps success, validation, entitlement, unavailable, stale, cancellation, and internal outcomes', async () => {
    const events = [];
    const tools = buildWebMcpTools(createBindings({
      openSearch: async () => { throw new DOMException('cancelled by host', 'AbortError'); },
      getDashboardContext: async () => {
        throw new DashboardBindingError('map_unavailable', 'Map unavailable.');
      },
      applyDashboardAction: async (action) => action.panelId === 'premium'
        ? ({
            ok: false,
            status: 'denied',
            reason: 'panel_not_entitled',
            message: 'Denied.',
            targets: [{ target: 'premium', status: 'denied', reason: 'panel_not_entitled' }],
          })
        : ({
            ok: false,
            status: 'denied',
            reason: 'panel_not_live',
            message: 'Unavailable.',
            targets: [],
          }),
      openSearchResult: async () => ({
        ok: false,
        status: 'denied',
        reason: 'search_state_changed',
      }),
      applyMissionPreset: async () => ({
        ok: false,
        status: 'denied',
        reason: 'preset_not_entitled',
        message: 'That mission preset requires a higher plan.',
      }),
      searchDashboard: async () => { throw new Error('private internal failure'); },
    }), (event, data) => events.push({ event, data }));

    await tools.find(({ name }) => name === 'openCountryBrief').execute({ iso2: 'DE' });
    await assert.rejects(
      tools.find(({ name }) => name === 'openCountryBrief').execute({ iso2: 'USA' }),
    );
    await assert.rejects(
      tools.find(({ name }) => name === 'openSearch').execute({}),
      (error) => error.name === 'AbortError',
    );
    await assert.rejects(tools.find(({ name }) => name === 'get_dashboard_context').execute({}));
    await tools.find(({ name }) => name === 'open_dashboard_panel')
      .execute({ panelId: 'premium' });
    await tools.find(({ name }) => name === 'open_dashboard_panel')
      .execute({ panelId: 'missing' });
    await tools.find(({ name }) => name === 'open_search_result')
      .execute({ resultKey: `sr_${'b'.repeat(32)}` });
    await tools.find(({ name }) => name === 'open_search_result')
      .execute({ resultKey: `sr_${'c'.repeat(32)}`, extra: true });
    await tools.find(({ name }) => name === 'apply_mission_preset')
      .execute({ presetId: 'supply-chain-risk' });
    await assert.rejects(
      tools.find(({ name }) => name === 'search_dashboard').execute({ query: 'safe' }),
    );

    assert.deepEqual(events.map(({ data }) => [data.outcome, data.reason]), [
      ['success', 'completed'],
      ['failure', 'validation'],
      ['failure', 'cancelled'],
      ['failure', 'unavailable'],
      ['denied', 'entitlement'],
      ['denied', 'unavailable'],
      ['denied', 'stale'],
      ['denied', 'validation'],
      ['denied', 'entitlement'],
      ['failure', 'internal'],
    ]);
    assert.deepEqual(
      [...new Set(events.map(({ data }) => data.outcome))].sort(),
      ['denied', 'failure', 'success'],
    );
    assert.ok(events.every(({ data }) => (
      ['completed', 'validation', 'entitlement', 'unavailable', 'stale', 'cancelled', 'internal']
        .includes(data.reason)
    )));
  });
});
