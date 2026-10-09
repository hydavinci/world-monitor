import { denyRetiredRpc } from '../../../../api/_retired-routes.js';
/**
 * Market service handler -- thin composition of per-RPC modules.
 *
 * RPCs:
 *   - ListMarketQuotes      (Finnhub + Yahoo Finance for stocks/indices)
 *   - ListCryptoQuotes      (CoinGecko markets API)
 *   - ListCommodityQuotes   (Yahoo Finance for commodity futures)
 *   - GetSectorSummary      (Finnhub for sector ETFs)
 *   - ListStablecoinMarkets (CoinGecko stablecoin peg health)
 *   - ListEtfFlows          (Yahoo Finance BTC spot ETF flow estimates)
 *   - GetCountryStockIndex  (Yahoo Finance national stock indices)
 *   - GetPriceHistory       (Yahoo Finance dated daily closes for tracked symbols)
 *   - ListGulfQuotes        (Yahoo Finance GCC indices, currencies, oil)
 */

import type { MarketServiceHandler } from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { listMarketQuotes } from './list-market-quotes';
import { listCryptoQuotes } from './list-crypto-quotes';
import { listCommodityQuotes } from './list-commodity-quotes';
import { getSectorSummary } from './get-sector-summary';
import { listStablecoinMarkets } from './list-stablecoin-markets';
import { listEtfFlows } from './list-etf-flows';
import { getCountryStockIndex } from './get-country-stock-index';
import { getPriceHistory } from './get-price-history';
import { listGulfQuotes } from './list-gulf-quotes';
import { listCryptoSectors } from './list-crypto-sectors';
import { listDefiTokens } from './list-defi-tokens';
import { listAiTokens } from './list-ai-tokens';
import { listOtherTokens } from './list-other-tokens';
import { getFearGreedIndex } from './get-fear-greed-index';
import { listEarningsCalendar } from './list-earnings-calendar';
import { getCotPositioning } from './get-cot-positioning';
import { getMarketBreadthHistory } from './get-market-breadth-history';
import { getGoldIntelligence } from './get-gold-intelligence';
import { getHyperliquidFlow } from './get-hyperliquid-flow';

export const marketHandler: MarketServiceHandler = {
  listMarketQuotes,
  listCryptoQuotes,
  listCommodityQuotes,
  getPhysicalPremiums: denyRetiredRpc,
  getPhysicalDivergenceIndex: denyRetiredRpc,
  getSectorSummary,
  listStablecoinMarkets,
  listEtfFlows,
  getCountryStockIndex,
  getPriceHistory,
  listGulfQuotes,
  analyzeStock: denyRetiredRpc,
  getStockAnalysisHistory: denyRetiredRpc,
  backtestStock: denyRetiredRpc,
  listStoredStockBacktests: denyRetiredRpc,
  listCryptoSectors,
  listDefiTokens,
  listAiTokens,
  listOtherTokens,
  getFearGreedIndex,
  listEarningsCalendar,
  getCotPositioning,
  getInsiderTransactions: denyRetiredRpc,
  getMarketBreadthHistory,
  getGoldIntelligence,
  getHyperliquidFlow,
};
