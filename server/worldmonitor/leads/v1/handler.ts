import type { LeadsServiceHandler } from '../../../../src/generated/server/worldmonitor/leads/v1/service_server';

import { denyRetiredRpc } from '../../../../api/_retired-routes.js';
import { submitContact } from './submit-contact';

export const leadsHandler: LeadsServiceHandler = {
  submitContact,
  registerInterest: denyRetiredRpc,
};
