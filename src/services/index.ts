// market: not re-exported (#4571) — eager service client; kept tree-shakeable out of main.js
export * from './canada-alerts';
export * from './canada-roads';
export * from './clustering';
export * from './correlation';
export * from './earthquakes';
export * from './prediction';
export * from './related-assets';
export * from './storage';
export * from './velocity';
export * from './weather';
// economic is NOT re-exported here (#4571): it runs a module-load side effect
// (new EconomicServiceClient() + circuit breakers), so an `export *` re-export
// keeps it un-tree-shakeable in eager main.js. Its consumers import it directly
// (`@/services/economic`) or dynamically (data-loader), so it tree-shakes out.
export * from './infrastructure';
// cyber: not re-exported (#4649) — eager service client; kept tree-shakeable out of main.js
export * from './maritime';
// cable-activity: not re-exported (#4649) — eager service client; kept tree-shakeable out of main.js
export * from './cable-health';
export * from './conflict';
export * from './displacement';
// research: not re-exported (#4649) — eager service client; kept tree-shakeable out of main.js
export * from './climate';
export * from './unrest';
export * from './wildfires';
// aviation: not re-exported (#4571) — eager service client; kept tree-shakeable out of main.js
export { activityTracker } from './activity-tracker';
export { analysisWorker } from './analysis-worker';
export * from './cached-theater-posture';
export * from './country-instability';
export * from './data-freshness';
export * from './eonet';
export * from './geo-convergence';
export * from './infrastructure-cascade';
export * from './military-flights';
export * from './pizzint';
export { generateSummary,translateText } from './summarization';
export * from './usa-spending';
export * from './usni-fleet';
// trade: not re-exported (#4571) — eager service client; kept tree-shakeable out of main.js
// supply-chain: not re-exported (#4571 review) — eager service client; kept tree-shakeable out of main.js
export * from './breaking-news-alerts';
export * from './imagery';
export * from './radiation';
export * from './thermal-escalation';
