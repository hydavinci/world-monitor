import { denyRetiredRpc } from '../../../../api/_retired-routes.js';
import type { AviationServiceHandler } from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';

import { listAirportDelays } from './list-airport-delays';
import { getAirportOpsSummary } from './get-airport-ops-summary';
import { trackAircraft } from './track-aircraft';
import { listAviationNews } from './list-aviation-news';
import { getYoutubeLiveStreamInfo } from './get-youtube-live-stream-info';
import { searchGoogleFlights } from './search-google-flights';
import { searchGoogleDates } from './search-google-dates';

export const aviationHandler: AviationServiceHandler = {
  listAirportDelays,
  getAirportOpsSummary,
  listAirportFlights: denyRetiredRpc,
  getCarrierOps: denyRetiredRpc,
  getFlightStatus: denyRetiredRpc,
  trackAircraft,
  searchFlightPrices: denyRetiredRpc,
  listAviationNews,
  getYoutubeLiveStreamInfo,
  searchGoogleFlights,
  searchGoogleDates,
};
