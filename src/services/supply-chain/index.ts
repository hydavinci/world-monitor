import type { BypassOption,ChokepointDependency,ChokepointExposureEntry,ChokepointInfo,CommodityVulnerability,CountryProduct,CriticalMineral,GetBypassOptionsResponse,GetChokepointDependenciesResponse,GetChokepointHistoryResponse,GetChokepointStatusResponse,GetCountryChokepointIndexResponse,GetCountryCostShockResponse,GetCountryProductsResponse,GetCountryVulnerabilitiesResponse,GetCriticalMineralsResponse,GetMineralProductionResponse,GetMultiSectorCostShockResponse,GetRouteExplorerLaneResponse,GetRouteImpactResponse,GetSectorDependencyResponse,GetShippingRatesResponse,GetShippingStressResponse,ListVulnerabilityRankingsResponse,MineralProducer,MultiSectorCostShock,ProductExporter,ShippingIndex,ShippingRatePoint,TransitDayCount,VulnerabilityInput } from '@/generated/client/worldmonitor/supply_chain/v1/service_client';
import { getHydratedData } from '@/services/bootstrap';
import { SupplyChainServiceClient } from '@/services/generated-rpc-clients';
import { createHydrationHandoff } from '@/services/hydration-handoff';
import { getRpcBaseUrl,rpcFetch } from '@/services/rpc-client';
import { createCircuitBreaker } from '@/utils/circuit-breaker';
import {
type ChinaCorridorControlTowerResponse,
} from '../../../shared/china-corridor-control-towers';
import {
CHINA_CORRIDOR_BREAKER_CACHE_POLICY,
fetchChinaCorridorControlTowers as fetchChinaCorridorControlTowersWithDependencies,
} from './china-corridor-control-towers';

export { parseChinaCorridorResponse } from './china-corridor-control-towers';

export type {
ChinaCorridorCondition,
ChinaCorridorControlTower,
ChinaCorridorControlTowerResponse,
CorridorAvailability,
CorridorSourceSignal
} from '../../../shared/china-corridor-control-towers';

export type {
BypassOption,ChokepointDependency,ChokepointExposureEntry,ChokepointInfo,CommodityVulnerability,CountryProduct,CriticalMineral,GetBypassOptionsResponse,GetChokepointDependenciesResponse,GetChokepointHistoryResponse,GetChokepointStatusResponse,GetCountryChokepointIndexResponse,GetCountryCostShockResponse,
GetCountryProductsResponse,GetCountryVulnerabilitiesResponse,GetCriticalMineralsResponse,
GetMineralProductionResponse,GetMultiSectorCostShockResponse,GetRouteExplorerLaneResponse,
GetRouteImpactResponse,GetSectorDependencyResponse,GetShippingRatesResponse,GetShippingStressResponse,ListVulnerabilityRankingsResponse,MineralProducer,MultiSectorCostShock,ProductExporter,ShippingIndex,ShippingRatePoint,TransitDayCount,VulnerabilityInput
};

// Legacy aliases consumed by CountryBriefPanel + CountryDeepDivePanel — match the
// proto-generated shapes exactly so callsites compile without churn.
export type CountryProductsResponse = GetCountryProductsResponse;
export type MultiSectorShockResponse = GetMultiSectorCostShockResponse;
export type MultiSectorShock = MultiSectorCostShock;



// rpcFetch for the whole client: 8 of 13 methods target paths in
// PREMIUM_RPC_PATHS. The gateway runs validateApiKey with forceKey=true on
// those paths *before* isCallerPremium; globalThis.fetch here would 401 for
// signed-in browser pros (no Clerk bearer / no WM key injected) and the
// generated client's try/catch would swallow the 401, returning the empty
// fallbacks below. rpcFetch no-ops safely when no credentials are
// available, so the public methods (shippingRates, chokepointStatus,
// chokepointHistory, criticalMinerals, mineralProduction, shippingStress) keep working as before.
const client = new SupplyChainServiceClient(getRpcBaseUrl(), { fetch: rpcFetch });

const shippingBreaker = createCircuitBreaker<GetShippingRatesResponse>({ name: 'Shipping Rates', cacheTtlMs: 60 * 60 * 1000, persistCache: true });
const chokepointBreaker = createCircuitBreaker<GetChokepointStatusResponse>({ name: 'Chokepoint Status', cacheTtlMs: 90 * 60 * 1000, persistCache: true });
const mineralsBreaker = createCircuitBreaker<GetCriticalMineralsResponse>({ name: 'Critical Minerals', cacheTtlMs: 24 * 60 * 60 * 1000, persistCache: true });
const chinaCorridorBreaker = createCircuitBreaker<ChinaCorridorControlTowerResponse>({
  name: 'China Corridor Control Towers',
  ...CHINA_CORRIDOR_BREAKER_CACHE_POLICY,
});

const emptyShipping: GetShippingRatesResponse = { indices: [], fetchedAt: '', upstreamUnavailable: false };
const emptyChokepoints: GetChokepointStatusResponse = { chokepoints: [], fetchedAt: '', upstreamUnavailable: false };
const emptyMinerals: GetCriticalMineralsResponse = { minerals: [], fetchedAt: '', upstreamUnavailable: false };
const isCacheableChokepointStatus = (value: GetChokepointStatusResponse): boolean =>
  value.chokepoints.length > 0 && !value.upstreamUnavailable;

// A hydrated response is returned immediately for first paint, then refreshed
// once in the background. The breaker coalesces the normal cached case; this
// service-owned promise also coalesces degraded hydration, which is deliberately
// not admitted to the breaker cache.
const chokepointHydrationRefreshes = new WeakMap<
  GetChokepointStatusResponse,
  Promise<GetChokepointStatusResponse>
>();
let activeChokepointHydrationHandoff: {
  response: GetChokepointStatusResponse;
  refresh: Promise<GetChokepointStatusResponse>;
} | null = null;

export async function fetchChinaCorridorControlTowers(): Promise<ChinaCorridorControlTowerResponse> {
  return fetchChinaCorridorControlTowersWithDependencies({
    now: () => new Date(),
    getResponse: () => client.getChinaCorridorControlTowers({}),
    execute: (operation, fallback) =>
      chinaCorridorBreaker.execute(operation, fallback),
  });
}

export async function fetchShippingRates(): Promise<GetShippingRatesResponse> {
  const hydrated = getHydratedData('shippingRates') as GetShippingRatesResponse | undefined;
  if (hydrated?.indices?.length) {
    shippingBreaker.recordSuccess(hydrated);
    return hydrated;
  }

  try {
    return await shippingBreaker.execute(async () => {
      return client.getShippingRates({});
    }, emptyShipping);
  } catch {
    return emptyShipping;
  }
}

function loadLiveChokepointStatus(forceRefresh = false): Promise<GetChokepointStatusResponse> {
  return chokepointBreaker.execute(async () => {
    return client.getChokepointStatus({});
  }, emptyChokepoints, {
    shouldCache: isCacheableChokepointStatus,
    forceRefresh,
  });
}

function startChokepointHydrationRefresh(
  response: GetChokepointStatusResponse,
): Promise<GetChokepointStatusResponse> {
  if (activeChokepointHydrationHandoff) return activeChokepointHydrationHandoff.refresh;

  const refresh = loadLiveChokepointStatus(true);
  const handoff = { response, refresh };
  activeChokepointHydrationHandoff = handoff;
  const clearActiveRefresh = (): void => {
    if (activeChokepointHydrationHandoff === handoff) {
      activeChokepointHydrationHandoff = null;
    }
  };
  void refresh.then(clearActiveRefresh, clearActiveRefresh);
  return refresh;
}

export async function fetchChokepointStatus(): Promise<GetChokepointStatusResponse> {
  if (activeChokepointHydrationHandoff) {
    return activeChokepointHydrationHandoff.response;
  }

  const hydrated = getHydratedData('chokepoints') as GetChokepointStatusResponse | undefined;
  if (hydrated?.chokepoints?.length) {
    if (isCacheableChokepointStatus(hydrated)) {
      chokepointBreaker.recordSuccess(hydrated);
    }
    chokepointHydrationRefreshes.set(hydrated, startChokepointHydrationRefresh(hydrated));
    return hydrated;
  }

  try {
    return await loadLiveChokepointStatus();
  } catch {
    return emptyChokepoints;
  }
}

/**
 * Let any caller holding the active bootstrap response join its single live
 * refresh. Responses from normal live loads return `null`, so callers do not
 * issue a second RPC after their normal load.
 */
export function refreshChokepointStatusAfterHydration(
  response: GetChokepointStatusResponse,
): Promise<GetChokepointStatusResponse | null> {
  const refresh = chokepointHydrationRefreshes.get(response);
  if (!refresh) return Promise.resolve(null);
  return refresh;
}

/**
 * Lazy-load transit history for a single chokepoint. Main status RPC returns
 * transitSummary.history = [] to keep the payload under the 1.5s Redis read
 * budget; this call pulls the ~35KB per-id history key only when a card is
 * expanded. See docs/plans/chokepoint-rpc-payload-split.md.
 */
export async function fetchChokepointHistory(
  chokepointId: string,
): Promise<GetChokepointHistoryResponse> {
  try {
    return await client.getChokepointHistory({ chokepointId });
  } catch {
    return { chokepointId, history: [], fetchedAt: '0' };
  }
}

export async function fetchCriticalMinerals(): Promise<GetCriticalMineralsResponse> {
  const hydrated = getHydratedData('minerals') as GetCriticalMineralsResponse | undefined;
  if (hydrated?.minerals?.length) {
    mineralsBreaker.recordSuccess(hydrated);
    return hydrated;
  }

  try {
    return await mineralsBreaker.execute(async () => {
      return client.getCriticalMinerals({});
    }, emptyMinerals);
  } catch {
    return emptyMinerals;
  }
}

const emptyShippingStress: GetShippingStressResponse = { carriers: [], stressScore: 0, stressLevel: 'low', fetchedAt: 0, upstreamUnavailable: false };

// No breaker or TTL cache owns this loader's results, so the accepted
// bootstrap value is preserved in a service-owned bounded handoff (#7048);
// before this, every recurring call after the consume-once read refetched
// the RPC.
const shippingStressHandoff = createHydrationHandoff<GetShippingStressResponse>(
  'shippingStress',
  (value) => {
    const payload = value as GetShippingStressResponse;
    return payload?.carriers?.length ? payload : null;
  },
);

export async function fetchShippingStress(): Promise<GetShippingStressResponse> {
  return shippingStressHandoff.getOrLoad(
    () => client.getShippingStress({}),
    emptyShippingStress,
  );
}


/** Top 10 HS2 sectors seeded for chokepoint exposure. */
export const SEEDED_HS2_CODES = ['27', '84', '85', '87', '30', '72', '39', '29', '10', '62'] as const;

/** Short labels for display. */
export const HS2_SHORT_LABELS: Record<string, string> = {
  '27': 'Energy', '84': 'Machinery', '85': 'Electronics', '87': 'Vehicles',
  '30': 'Pharma', '72': 'Iron & Steel', '39': 'Plastics', '29': 'Chemicals',
  '10': 'Cereals', '62': 'Apparel',
};

export interface SectorExposureSummary {
  hs2: string;
  label: string;
  primaryChokepointId: string;
  primaryChokepointName: string;
  exposureScore: number;
  vulnerabilityIndex: number;
  dependencyFlag: string;
  primaryExporterIso2: string;
  primaryExporterShare: number;
  fetchedAt?: string;
}
