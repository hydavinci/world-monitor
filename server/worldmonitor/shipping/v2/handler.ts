import { denyRetiredRpc } from '../../../../api/_retired-routes.js';
import type { ShippingV2ServiceHandler } from '../../../../src/generated/server/worldmonitor/shipping/v2/service_server';

export const shippingV2Handler: ShippingV2ServiceHandler = {
  routeIntelligence: denyRetiredRpc,
  registerWebhook: denyRetiredRpc,
  listWebhooks: denyRetiredRpc,
};
