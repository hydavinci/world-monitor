import { denyRetiredRpc } from '../../../../api/_retired-routes.js';
import type { TradeServiceHandler } from '../../../../src/generated/server/worldmonitor/trade/v1/service_server';

import { getTradeRestrictions } from './get-trade-restrictions';
import { getTradeFlows } from './get-trade-flows';
import { getTradeBarriers } from './get-trade-barriers';
import { getCustomsRevenue } from './get-customs-revenue';

export const tradeHandler: TradeServiceHandler = {
  getTradeRestrictions,
  getTariffTrends: denyRetiredRpc,
  getTradeFlows,
  getTradeBarriers,
  getCustomsRevenue,
  listComtradeFlows: denyRetiredRpc,
};
