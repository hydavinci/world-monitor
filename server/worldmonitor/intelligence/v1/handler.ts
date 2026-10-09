import { denyRetiredRpc } from '../../../../api/_retired-routes.js';
import type { IntelligenceServiceHandler } from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { getRiskScores } from './get-risk-scores';
import { getCountryRisk } from './get-country-risk';
import { getPizzintStatus } from './get-pizzint-status';
import { searchGdeltDocuments } from './search-gdelt-documents';
import { getCountryFacts } from './get-country-facts';
import { listSecurityAdvisories } from './list-security-advisories';
import { listSatellites } from './list-satellites';
import { listGpsInterference } from './list-gps-interference';
import { listOrefAlerts } from './list-oref-alerts';
import { listTelegramFeed } from './list-telegram-feed';
import { listXFeed } from './list-x-feed';
import { getCompanyEnrichment } from './get-company-enrichment';
import { listCompanySignals } from './list-company-signals';
import { searchSecFilings } from './search-sec-filings';
import { listMaterialEvents } from './list-material-events';
import { getGdeltTopicTimeline } from './get-gdelt-topic-timeline';
import { listCrossSourceSignals } from './list-cross-source-signals';
import { getSocialVelocity } from './get-social-velocity';
import { getCountryEnergyProfile } from './get-country-energy-profile';
import { computeEnergyShockScenario } from './compute-energy-shock';
import { getCountryPortActivity } from './get-country-port-activity';
import { getChinaDecisionSignals } from './get-china-decision-signals';

export const intelligenceHandler: IntelligenceServiceHandler = {
  getRiskScores,
  getCountryRisk,
  getPizzintStatus,
  classifyEvent: denyRetiredRpc,
  getCountryIntelBrief: denyRetiredRpc,
  getCountryCoverage: denyRetiredRpc,
  searchGdeltDocuments,
  deductSituation: denyRetiredRpc,
  getCountryFacts,
  listSecurityAdvisories,
  listSatellites,
  listGpsInterference,
  listOrefAlerts,
  listTelegramFeed,
  listXFeed,
  getCompanyEnrichment,
  listCompanySignals,
  searchSecFilings,
  listMaterialEvents,
  getGdeltTopicTimeline,
  listCrossSourceSignals,
  listMarketImplications: denyRetiredRpc,
  getSocialVelocity,
  listWsbTickers: denyRetiredRpc,
  getCountryEnergyProfile,
  computeEnergyShockScenario,
  getCountryPortActivity,
  getChinaDecisionSignals,
  getRegionalSnapshot: denyRetiredRpc,
  getRegimeHistory: denyRetiredRpc,
  getRegionalBrief: denyRetiredRpc,
  searchIntelHistory: denyRetiredRpc,
  getIntelTimeline: denyRetiredRpc,
  getSimilarEvents: denyRetiredRpc,
};
