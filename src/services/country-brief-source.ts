import {
EconomicServiceClient,
IntelligenceServiceClient,
MaritimeServiceClient,
MarketServiceClient,MilitaryServiceClient,
PredictionServiceClient,
SupplyChainServiceClient,
TradeServiceClient
} from '@/services/generated-rpc-clients';
import { getRpcBaseUrl,rpcFetch } from '@/services/rpc-client';
import { fetchChokepointStatus } from '@/services/supply-chain';
import { RAW_SIGNAL_PATH } from '../../shared/country-raw-signals-model';
import type { createHostCountryFetch } from './country-brief-host-transport';
import { combineAbortSignals } from './timeout-signal';

function createCountryBriefSource(fetcher: typeof fetch & { clear?: () => void }, mode: 'website' | 'host') {
  const base = mode === 'host' ? 'https://www.worldmonitor.app' : getRpcBaseUrl();
  const options = { fetch: fetcher };
  const supply = new SupplyChainServiceClient(base, options);
  return {
    mode, fetch: fetcher, clearLoadedData: fetcher.clear ?? (() => {}),
    intelligence: new IntelligenceServiceClient(base, options),
    market: new MarketServiceClient(base, options), economic: new EconomicServiceClient(base, options),
    trade: new TradeServiceClient(base, options), military: new MilitaryServiceClient(base, options),
    vessels: new MaritimeServiceClient(base, options), prediction: new PredictionServiceClient(base, options), supply,
    signalsRaw: async (code: string, signal: AbortSignal) => {
      if (mode !== 'host') throw new Error('Raw Signals reader requires a country host connection.');
      const requestSignal = combineAbortSignals([signal, AbortSignal.timeout(30_000)]);
      requestSignal.throwIfAborted();
      const { rawSignalsValueSchema } = await import('../../shared/country-raw-signals');
      const response = await fetcher(`${base}${RAW_SIGNAL_PATH}?country_code=${code}`, { signal: requestSignal });
      const value = rawSignalsValueSchema.parse(await response.json());
      requestSignal.throwIfAborted();
      if (value.countryCode !== code) throw new Error('Signals country identity mismatch');
      return value;
    },
    atlas: (code: string, signal: AbortSignal) => {
      const client = new SupplyChainServiceClient(base, { fetch: (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input), base || location.origin);
        if (mode === 'host') url.searchParams.set('country_code', code);
        return fetcher(url, { ...init, signal });
      } });
      return {
        getPipelineDetail: (args: Parameters<typeof supply.getPipelineDetail>[0]) => client.getPipelineDetail(args, { signal }),
        getStorageFacilityDetail: (args: Parameters<typeof supply.getStorageFacilityDetail>[0]) => client.getStorageFacilityDetail(args, { signal }),
        getFuelShortageDetail: (args: Parameters<typeof supply.getFuelShortageDetail>[0]) => client.getFuelShortageDetail(args, { signal }),
        listEnergyDisruptions: (args: Parameters<typeof supply.listEnergyDisruptions>[0]) => client.listEnergyDisruptions(args, { signal }),
      };
    },
    chokepoints: (signal: AbortSignal) => mode === 'website' ? fetchChokepointStatus() : supply.getChokepointStatus({}, { signal }),
  };
}
export type CountryBriefSource = ReturnType<typeof createCountryBriefSource>;
export const createWebsiteCountryBriefSource = () => createCountryBriefSource(rpcFetch, 'website');
export async function createHostCountryBriefSource(call: Parameters<typeof createHostCountryFetch>[0]) {
  const { createHostCountryFetch } = await import('./country-brief-host-transport');
  return createCountryBriefSource(createHostCountryFetch(call), 'host');
}
