import { denyRetiredRpc } from '../../../../api/_retired-routes.js';
import type { ResilienceServiceHandler } from '../../../../src/generated/server/worldmonitor/resilience/v1/service_server';
import { getResilienceRuntimeManifest } from './get-resilience-runtime-manifest';

export const resilienceHandler: ResilienceServiceHandler = {
  getResilienceScore: denyRetiredRpc,
  getResilienceIndicators: denyRetiredRpc,
  getFoodStocks: denyRetiredRpc,
  getDemographicsCapability: denyRetiredRpc,
  getResilienceRanking: denyRetiredRpc,
  getResilienceRuntimeManifest,
};
