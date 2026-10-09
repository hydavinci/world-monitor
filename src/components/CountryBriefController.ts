import { CountrySectionError } from '@/services/country-brief-error';
import type { CountryBriefSource } from '@/services/country-brief-source';
import { buildImfEconomicIndicators,getImfCountryBundle,type ImfCountryBundle,type ImfExternalEntry,type ImfGrowthEntry,type ImfLaborEntry,type ImfMacroEntry } from '@/services/imf-country-data';
import { fetchCountryMarkets,protoToMarket } from '@/services/prediction';
import { toApiUrl } from '@/services/runtime';
import { combineAbortSignals } from '@/services/timeout-signal';
import { IS_EMBEDDED_PREVIEW } from '@/utils/embedded-preview';
import type { ChinaDecisionSignalSnapshot } from '../../shared/china-decision-signals';
import type { BriefSectionId } from '../../shared/country-brief-sections';
import type { ChinaCountrySummaryData,CountryBriefPanel,StockIndexData } from './CountryBriefPanel';

export type CountrySectionStatus =
  | { state: 'loading' }
  | { state: 'ready'; value: unknown }
  | { state: 'locked' | 'unavailable'; reason: string };
export type CountryBriefSnapshot = { countryCode: string; revision: number; sections: Partial<Record<BriefSectionId | 'stock', CountrySectionStatus>> };

type HousingPayload = { data?: {
  bisDsr?: { entries?: Array<{ countryCode: string; dsrPct: number; change: number | null; period: string }> };
  bisPropertyResidential?: { entries?: Array<{ countryCode: string; indexValue: number; qoqChange: number | null; yoyChange: number | null; period: string }> };
  bisPropertyCommercial?: { entries?: Array<{ countryCode: string; indexValue: number; qoqChange: number | null; yoyChange: number | null; period: string }> };
} };
const EURO_AREA = new Set(['DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'AT', 'IE', 'PT', 'GR', 'FI', 'SK', 'SI', 'LV', 'LT', 'EE', 'CY', 'MT', 'LU', 'HR']);
export function projectCountryHousing(body: HousingPayload, code: string) {
  const pick = <T extends { countryCode: string }>(entries: T[] | undefined): T | null => entries?.find(e => e.countryCode === code) ?? (EURO_AREA.has(code) ? entries?.find(e => e.countryCode === 'XM') : null) ?? null;
  const res = pick(body.data?.bisPropertyResidential?.entries);
  const com = pick(body.data?.bisPropertyCommercial?.entries);
  const dsr = pick(body.data?.bisDsr?.entries);
  return {
    residential: res ? { indexValue: res.indexValue, qoqChange: res.qoqChange, yoyChange: res.yoyChange, period: res.period } : null,
    commercial: com ? { indexValue: com.indexValue, qoqChange: com.qoqChange, yoyChange: com.yoyChange, period: com.period } : null,
    dsr: dsr ? { dsrPct: dsr.dsrPct, change: dsr.change, period: dsr.period } : null,
  };
}

export class CountryBriefController {
  private request = new AbortController();
  private premiumRequest = new AbortController();
  private snapshot: CountryBriefSnapshot = { countryCode: '', revision: 0, sections: {} };
  constructor(private readonly source: CountryBriefSource, private readonly panel: CountryBriefPanel, private readonly changed: (snapshot: CountryBriefSnapshot) => void = () => {}) {}

  dispose(): void { this.request.abort(); this.premiumRequest.abort(); this.snapshot.revision++; }

  private async read<T>(id: BriefSectionId | 'stock', load: (signal: AbortSignal) => Promise<T>, apply: (value: T) => void, premium = false): Promise<T | null> {
    const revision = this.snapshot.revision;
    const signal = combineAbortSignals([this.request.signal, this.panel.signal ?? new AbortController().signal, ...(premium ? [this.premiumRequest.signal] : [])]);
    const current = () => !signal.aborted && revision === this.snapshot.revision && this.panel.getCode() === this.snapshot.countryCode;
    this.snapshot.sections[id] = { state: 'loading' };
    this.changed(this.snapshot);
    try {
      const value = await load(signal);
      if (!current()) return null;
      apply(value);
      this.snapshot.sections[id] = { state: 'ready', value };
      return value;
    } catch (error) {
      if (!current()) return null;
      const state = error instanceof CountrySectionError ? error.state : 'unavailable';
      const reason = state === 'locked' ? 'This section is not authorized by the current connection.' : 'This section could not be loaded. Retry to refresh it.';
      this.snapshot.sections[id] = { state, reason };
      if (id !== 'stock') this.panel.setSectionFailure?.(id, state, reason);
      if (id === 'trade') this.panel.setSectionFailure?.('scenario', state, 'Trade exposure is unavailable, so this calculator cannot be loaded.');
      return null;
    } finally { if (current()) this.changed(this.snapshot); }
  }

  hydrate(countryCode: string, countryName: string, updated?: { stock?: (stock: StockIndexData & { fetchedAt: string }) => void; imf?: (bundle: ImfCountryBundle) => void }) {
    this.dispose();
    this.request = new AbortController();
    this.premiumRequest = new AbortController();
    this.snapshot = { countryCode, revision: this.snapshot.revision, sections: {} };
    const code = countryCode.toUpperCase();
    let latestStock: StockIndexData | null = null;
    const stockPromise = this.read('stock', async signal => {
      const stock = await this.source.market.getCountryStockIndex({ countryCode: code }, { signal });
      return { ...stock, price: String(stock.price), weekChangePercent: String(stock.weekChangePercent) };
    }, stock => { latestStock = stock; this.panel.updateStock(stock); updated?.stock?.(stock); });
    const imfPromise = this.read<ImfCountryBundle & { missing?: string[] }>('economic', async signal => {
      if (this.source.mode === 'website') return getImfCountryBundle(code);
      const body = await this.source.fetch('https://www.worldmonitor.app/api/bootstrap?keys=imfMacro,imfGrowth,imfLabor,imfExternal', { signal }).then(res => res.json()) as { data?: {
        imfMacro?: { countries?: Record<string, ImfMacroEntry> }; imfGrowth?: { countries?: Record<string, ImfGrowthEntry> }; imfLabor?: { countries?: Record<string, ImfLaborEntry> }; imfExternal?: { countries?: Record<string, ImfExternalEntry> };
      }; missing?: string[] };
      return { macro: body.data?.imfMacro?.countries?.[code] ?? null, growth: body.data?.imfGrowth?.countries?.[code] ?? null, labor: body.data?.imfLabor?.countries?.[code] ?? null, external: body.data?.imfExternal?.countries?.[code] ?? null, fetchedAt: 0, missing: body.missing ?? [] };
    }, bundle => { this.panel.updateEconomicIndicators?.(buildImfEconomicIndicators(bundle)); this.panel.setSectionCoverage?.('economic', bundle.missing ?? []); if (latestStock) this.panel.updateStock(latestStock); updated?.imf?.(bundle); });
    void this.read('facts', signal => this.source.intelligence.getCountryFacts({ countryCode: code }, { signal }), facts => this.panel.updateCountryFacts?.({ ...facts, population: Number(facts.population) }));
    void this.read('energy', signal => this.source.intelligence.getCountryEnergyProfile({ countryCode: code }, { signal }), energy => this.panel.updateEnergyProfile?.(energy));
    void this.read('maritime', signal => this.source.intelligence.getCountryPortActivity({ countryCode: code }, { signal }), maritime => this.panel.updateMaritimeActivity?.(maritime));
    void this.read('markets', async signal => {
      if (this.source.mode === 'website') return fetchCountryMarkets(countryName, code);
      const response = await this.source.prediction.listPredictionMarkets({ category: `country:${code}`, query: '', pageSize: 5, cursor: '' }, { signal });
      if (!response.dataAvailable) throw new Error('Country markets unavailable');
      return response.markets.map(protoToMarket).filter(m => !m.endDate || Date.parse(m.endDate) > Date.now()).slice(0, 5);
    }, markets => this.panel.updateMarkets(markets));
    if (this.source.mode === 'host' || !IS_EMBEDDED_PREVIEW) void this.read('housing', async signal => {
      const url = this.source.mode === 'host' ? 'https://www.worldmonitor.app/api/bootstrap?keys=bisDsr,bisPropertyResidential,bisPropertyCommercial' : toApiUrl('/api/bootstrap?keys=bisDsr,bisPropertyResidential,bisPropertyCommercial');
      const response = await this.source.fetch(url, { signal });
      if (!response.ok) throw new Error('Housing unavailable');
      const body = await response.json() as HousingPayload & { missing?: string[] };
      return { ...projectCountryHousing(body, code), missing: body.missing ?? [] };
    }, housing => { this.panel.updateHousingCycle?.(housing); this.panel.setSectionCoverage?.('housing', housing.missing); });
    return { stockPromise, imfPromise };
  }
}

export function projectChinaCountrySummary(snapshot: ChinaDecisionSignalSnapshot): ChinaCountrySummaryData {
  return { groups: snapshot.groups.map(group => ({
    id: group.id, state: group.state, unavailableReason: group.reason ?? undefined,
    signals: group.items.map(item => {
      const translation = item.metadata.translation as { state?: unknown } | null;
      const supersession = item.metadata.supersession as { state?: unknown } | null;
      return {
        label: item.label, value: item.summary, source: `${item.sourceName} · ${item.publisherType.replace(/_/g, ' ')}`,
        sourceUrl: item.sourceUrl ?? undefined, observedAt: item.observedAt ?? undefined, publishedAt: item.publishedAt ?? undefined, effectiveAt: item.effectiveAt ?? undefined,
        status: typeof supersession?.state === 'string' ? supersession.state : undefined,
        translationState: typeof translation?.state === 'string' ? translation.state.replace(/_/g, ' ') : undefined,
        publisherType: item.publisherType, lineageId: item.lineageId, provenance: item.provenance, stale: item.stale,
      };
    }),
  })) };
}
