import { denyRetiredRpc } from '../../../../api/_retired-routes.js';
import type { MilitaryServiceHandler } from '../../../../src/generated/server/worldmonitor/military/v1/service_server';

import { listMilitaryFlights } from './list-military-flights';
import { getTheaterPosture } from './get-theater-posture';
import { getAircraftDetailsBatch } from './get-aircraft-details-batch';
import { getWingbitsStatus } from './get-wingbits-status';
import { getUSNIFleetReport } from './get-usni-fleet-report';
import { listMilitaryBases } from './list-military-bases';
import { getWingbitsLiveFlight } from './get-wingbits-live-flight';
import { listDefensePatents } from './list-defense-patents';

export const militaryHandler: MilitaryServiceHandler = {
  listMilitaryFlights,
  getTheaterPosture,
  getAircraftDetails: denyRetiredRpc,
  getAircraftDetailsBatch,
  getWingbitsStatus,
  getUSNIFleetReport,
  listMilitaryBases,
  getWingbitsLiveFlight,
  listDefensePatents,
  getDefenseIndustrialBase: denyRetiredRpc,
};
