import { denyRetiredRpc } from '../../../../api/_retired-routes.js';
import type { SanctionsServiceHandler } from '../../../../src/generated/server/worldmonitor/sanctions/v1/service_server';
import { lookupSanctionEntity } from './lookup-entity';

export const sanctionsHandler: SanctionsServiceHandler = {
  listSanctionsPressure: denyRetiredRpc,
  lookupSanctionEntity,
};
