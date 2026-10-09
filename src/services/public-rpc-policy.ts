/** Frozen retirement inventory. Credentials never change a route's status. */
export const RETIRED_RPC_PATHS = new Set([
  '/api/aviation/v1/get-carrier-ops', '/api/aviation/v1/get-flight-status',
  '/api/aviation/v1/list-airport-flights', '/api/aviation/v1/search-flight-prices',
  '/api/chat-analyst', '/api/economic/v1/get-national-debt', '/api/economic/v1/list-global-tenders',
  '/api/forecast/v1/trigger-simulation', '/api/intelligence/v1/classify-event',
  '/api/intelligence/v1/deduct-situation', '/api/intelligence/v1/get-country-coverage',
  '/api/intelligence/v1/get-country-intel-brief', '/api/intelligence/v1/get-intel-timeline',
  '/api/intelligence/v1/get-regime-history', '/api/intelligence/v1/get-regional-brief',
  '/api/intelligence/v1/get-regional-snapshot', '/api/intelligence/v1/get-similar-events',
  '/api/intelligence/v1/list-market-implications', '/api/intelligence/v1/list-wsb-tickers',
  '/api/intelligence/v1/search-intel-history', '/api/market/v1/analyze-stock',
  '/api/market/v1/backtest-stock', '/api/market/v1/get-insider-transactions',
  '/api/market/v1/get-physical-divergence-index', '/api/market/v1/get-physical-premiums',
  '/api/market/v1/get-stock-analysis-history', '/api/market/v1/list-stored-stock-backtests',
  '/api/mcp-proxy', '/api/military/v1/get-aircraft-details',
  '/api/military/v1/get-defense-industrial-base', '/api/resilience/v1/get-demographics-capability',
  '/api/resilience/v1/get-food-stocks', '/api/resilience/v1/get-resilience-indicators',
  '/api/resilience/v1/get-resilience-ranking', '/api/resilience/v1/get-resilience-score',
  '/api/sanctions/v1/list-sanctions-pressure', '/api/scenario/v1/get-scenario-status',
  '/api/scenario/v1/run-scenario', '/api/scorecard/v1/get-bloc-scorecard',
  '/api/scorecard/v1/get-five-factor-scorecard', '/api/scorecard/v1/list-five-factor-scorecards',
  '/api/supply-chain/v1/get-bypass-options', '/api/supply-chain/v1/get-chokepoint-dependencies',
  '/api/supply-chain/v1/get-country-chokepoint-index', '/api/supply-chain/v1/get-country-cost-shock',
  '/api/supply-chain/v1/get-country-products', '/api/supply-chain/v1/get-country-vulnerabilities',
  '/api/supply-chain/v1/get-mineral-production', '/api/supply-chain/v1/get-multi-sector-cost-shock',
  '/api/supply-chain/v1/get-route-explorer-lane', '/api/supply-chain/v1/get-route-impact',
  '/api/supply-chain/v1/get-sector-dependency', '/api/supply-chain/v1/list-vulnerability-rankings',
  '/api/trade/v1/get-tariff-trends', '/api/trade/v1/list-comtrade-flows',
  '/api/v2/shipping/route-intelligence', '/api/v2/shipping/webhooks',
]);

export function assertPublicRpc(input: RequestInfo | URL): void {
  const raw = input instanceof Request ? input.url : String(input);
  const path = decodeURIComponent(new URL(raw, 'https://public.invalid').pathname).replace(/\/+$/, '');
  if (RETIRED_RPC_PATHS.has(path)) throw new Error(`Retired RPC: ${path}`);
}
