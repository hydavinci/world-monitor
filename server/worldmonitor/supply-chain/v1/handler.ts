import { denyRetiredRpc } from '../../../../api/_retired-routes.js';
import type { SupplyChainServiceHandler } from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

import { getShippingRates } from './get-shipping-rates';
import { getChokepointStatus } from './get-chokepoint-status';
import { getChokepointHistory } from './get-chokepoint-history';
import { getCriticalMinerals } from './get-critical-minerals';
import { getShippingStress } from './get-shipping-stress';
import { listPipelines } from './list-pipelines';
import { getPipelineDetail } from './get-pipeline-detail';
import { listStorageFacilities } from './list-storage-facilities';
import { getStorageFacilityDetail } from './get-storage-facility-detail';
import { listFuelShortages } from './list-fuel-shortages';
import { getFuelShortageDetail } from './get-fuel-shortage-detail';
import { listEnergyDisruptions } from './list-energy-disruptions';
import { getChinaCorridorControlTowers } from './get-china-corridor-control-towers';

export const supplyChainHandler: SupplyChainServiceHandler = {
  getShippingRates,
  getChokepointStatus,
  getChokepointHistory,
  getCriticalMinerals,
  getMineralProduction: denyRetiredRpc,
  getShippingStress,
  getCountryChokepointIndex: denyRetiredRpc,
  getBypassOptions: denyRetiredRpc,
  getCountryCostShock: denyRetiredRpc,
  getCountryProducts: denyRetiredRpc,
  getMultiSectorCostShock: denyRetiredRpc,
  getSectorDependency: denyRetiredRpc,
  getRouteExplorerLane: denyRetiredRpc,
  getRouteImpact: denyRetiredRpc,
  listPipelines,
  getPipelineDetail,
  listStorageFacilities,
  getStorageFacilityDetail,
  listFuelShortages,
  getFuelShortageDetail,
  listEnergyDisruptions,
  getChinaCorridorControlTowers,
  getCountryVulnerabilities: denyRetiredRpc,
  getChokepointDependencies: denyRetiredRpc,
  listVulnerabilityRankings: denyRetiredRpc,
};
