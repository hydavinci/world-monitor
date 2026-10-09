import { denyRetiredRpc } from '../../../../api/_retired-routes.js';
import type { ScenarioServiceHandler } from '../../../../src/generated/server/worldmonitor/scenario/v1/service_server';
import { listScenarioTemplates } from './list-scenario-templates';

export const scenarioHandler: ScenarioServiceHandler = {
  runScenario: denyRetiredRpc,
  getScenarioStatus: denyRetiredRpc,
  listScenarioTemplates,
};
