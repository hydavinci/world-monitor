export const RETIRED_DATA_PATHS = new Set([
  '/api/aviation/v1/get-carrier-ops',
  '/api/aviation/v1/get-flight-status',
  '/api/aviation/v1/list-airport-flights',
  '/api/aviation/v1/search-flight-prices',
  '/api/chat-analyst',
  '/api/economic/v1/get-national-debt',
  '/api/economic/v1/list-global-tenders',
  '/api/forecast/v1/trigger-simulation',
  '/api/intelligence/v1/classify-event',
  '/api/intelligence/v1/deduct-situation',
  '/api/intelligence/v1/get-country-coverage',
  '/api/intelligence/v1/get-country-intel-brief',
  '/api/intelligence/v1/get-intel-timeline',
  '/api/intelligence/v1/get-regime-history',
  '/api/intelligence/v1/get-regional-brief',
  '/api/intelligence/v1/get-regional-snapshot',
  '/api/intelligence/v1/get-similar-events',
  '/api/intelligence/v1/list-market-implications',
  '/api/intelligence/v1/list-wsb-tickers',
  '/api/intelligence/v1/search-intel-history',
  '/api/market/v1/analyze-stock',
  '/api/market/v1/backtest-stock',
  '/api/market/v1/get-insider-transactions',
  '/api/market/v1/get-physical-divergence-index',
  '/api/market/v1/get-physical-premiums',
  '/api/market/v1/get-stock-analysis-history',
  '/api/market/v1/list-stored-stock-backtests',
  '/api/mcp-proxy',
  '/api/military/v1/get-aircraft-details',
  '/api/military/v1/get-defense-industrial-base',
  '/api/resilience/v1/get-demographics-capability',
  '/api/resilience/v1/get-food-stocks',
  '/api/resilience/v1/get-resilience-indicators',
  '/api/resilience/v1/get-resilience-ranking',
  '/api/resilience/v1/get-resilience-score',
  '/api/sanctions/v1/list-sanctions-pressure',
  '/api/scenario/v1/get-scenario-status',
  '/api/scenario/v1/run-scenario',
  '/api/scorecard/v1/get-bloc-scorecard',
  '/api/scorecard/v1/get-five-factor-scorecard',
  '/api/scorecard/v1/list-five-factor-scorecards',
  '/api/supply-chain/v1/get-bypass-options',
  '/api/supply-chain/v1/get-chokepoint-dependencies',
  '/api/supply-chain/v1/get-country-chokepoint-index',
  '/api/supply-chain/v1/get-country-cost-shock',
  '/api/supply-chain/v1/get-country-products',
  '/api/supply-chain/v1/get-country-vulnerabilities',
  '/api/supply-chain/v1/get-mineral-production',
  '/api/supply-chain/v1/get-multi-sector-cost-shock',
  '/api/supply-chain/v1/get-route-explorer-lane',
  '/api/supply-chain/v1/get-route-impact',
  '/api/supply-chain/v1/get-sector-dependency',
  '/api/supply-chain/v1/list-vulnerability-rankings',
  '/api/trade/v1/get-tariff-trends',
  '/api/trade/v1/list-comtrade-flows',
  '/api/v2/shipping/route-intelligence',
  '/api/v2/shipping/webhooks',
  '/api/latest-brief',
  '/api/widget-agent',
  '/api/scenario/v1/run',
  '/api/scenario/v1/status',
  '/api/supply-chain/v1/country-products',
  '/api/supply-chain/v1/multi-sector-cost-shock',
]);

export const RETIRED_ACCOUNT_PATHS = new Set([
  '/api/create-checkout',
  '/api/customer-portal',
  '/api/user-prefs',
  '/api/notification-channels',
  '/api/notify',
  '/api/invalidate-user-api-key-cache',
  '/api/me',
  '/api/user',
  '/api/oauth',
  '/api/referral',
  '/api/mcp',
  '/api/discord/oauth',
  '/api/slack/oauth',
  '/api/brief',
  '/api/embed',
  '/api/product-catalog',
  '/api/oauth-protected-resource',
  '/api/oauth-authorization-server',
  '/api/agent-auth',
  '/api/a2a',
  '/api/ask',
  '/api/internal/brief-why-matters',
  '/api/http-message-signatures-directory',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-authorization-server',
  '/.well-known/http-message-signatures-directory',
  '/api/leads/v1/register-interest',
  '/api/register-interest',
  '/api/internal/mcp-grant-context',
  '/api/internal/mcp-grant-mint',
  '/api/notification-suppressions',
]);

export const RETIRED_BOOTSTRAP_KEYS = new Set(['nationalDebt', 'sanctionsPressure']);
const RETIRED_SITE_PATHS = new Set(['/pro', '/pricing', '/oauth', '/mcp', '/mcp-grant', '/mcp-grant.html', '/widget-agent', '/ask', '/a2a', '/agent/auth']);
const RETIRED_DISCOVERY_PATHS = new Set(['/.well-known/mcp', '/.well-known/mcp/server', '/.well-known/mcp/server-card']);

function normalizeRoutePath(pathname) {
  return pathname.replace(/\/+$/, '').replace(/\.(?:md|json)$/, '');
}

function isRetiredPath(pathname) {
  const path = normalizeRoutePath(pathname);
  if (RETIRED_DISCOVERY_PATHS.has(path)) return true;
  const candidates = [
    path,
    path.replace(/^\/api\/(v\d+)\/([^/]+)(\/.*)$/, '/api/$2/$1$3'),
    path.replace(/^\/api\/([^/]+)\/(v\d+)(\/.*)$/, '/api/$2/$1$3'),
  ];
  for (const candidate of candidates) {
    for (const retired of [...RETIRED_DATA_PATHS, ...RETIRED_ACCOUNT_PATHS, ...RETIRED_SITE_PATHS]) {
      if (candidate === retired || candidate.startsWith(`${retired}/`)) return true;
    }
  }
  return false;
}

export function retiredRouteResponse(request, headers) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url).pathname);
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
    return new Response(request.method === 'HEAD' ? null : JSON.stringify({ error: 'malformed_request' }), {
      status: 400,
      headers: { ...Object.fromEntries(new Headers(headers)), 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
    });
  }
  const url = new URL(request.url);
  const bootstrapPath = normalizeRoutePath(pathname).replace(/^\/api\/(v\d+)\/([^/]+)(\/.*)$/, '/api/$2/$1$3');
  const retiredBootstrapSelection = (bootstrapPath === '/api/bootstrap'
    || bootstrapPath === '/api/infrastructure/v1/get-bootstrap-data')
    && url.searchParams.getAll('keys').some(value => value.split(',').some(key => RETIRED_BOOTSTRAP_KEYS.has(key.trim())));
  if (!isRetiredPath(pathname) && !retiredBootstrapSelection) return null;
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Type', 'application/json');
  responseHeaders.set('Cache-Control', 'private, no-store');
  responseHeaders.set('CDN-Cache-Control', 'no-store');
  responseHeaders.set('Vercel-CDN-Cache-Control', 'no-store');
  return new Response(request.method === 'HEAD' ? null : JSON.stringify({
    error: 'feature_removed',
    message: 'This feature is not available in the public-only fork.',
  }), { status: 403, headers: responseHeaders });
}

export async function denyRetiredRpc() {
  const error = new Error('This feature is not available in the public-only fork.');
  throw Object.assign(error, { statusCode: 403, code: 'feature_removed' });
}
