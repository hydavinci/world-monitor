import { denyRetiredRpc } from '../../../../api/_retired-routes.js';
import type { ScorecardServiceHandler } from '../../../../src/generated/server/worldmonitor/scorecard/v1/service_server';

export const scorecardHandler: ScorecardServiceHandler = {
  getFiveFactorScorecard: denyRetiredRpc,
  listFiveFactorScorecards: denyRetiredRpc,
  getBlocScorecard: denyRetiredRpc,
};
