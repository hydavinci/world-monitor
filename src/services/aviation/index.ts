import type { AirportDelayAlert as ProtoAlert,AviationNewsItem as ProtoAviationNews,DatePriceEntry as ProtoDatePriceEntry,GoogleFlightResult as ProtoGoogleFlightResult,AirportOpsSummary as ProtoOpsSummary,PositionSample as ProtoPosition } from '@/generated/client/worldmonitor/aviation/v1/service_client';
import { ensureHydrated,getHydratedData } from '@/services/bootstrap';
import { AviationServiceClient } from '@/services/generated-rpc-clients';
import { getRpcBaseUrl,rpcFetch } from '@/services/rpc-client';
import { createCircuitBreaker } from '@/utils/circuit-breaker';

// ---- Consumer-friendly display types ----

export type FlightDelaySource = 'faa' | 'eurocontrol' | 'computed' | 'aviationstack' | 'notam' | 'unspecified';
export type FlightDelaySeverity = 'normal' | 'minor' | 'moderate' | 'major' | 'severe' | 'unknown';
export type FlightDelayType = 'ground_stop' | 'ground_delay' | 'departure_delay' | 'arrival_delay' | 'general' | 'closure';
export type AirportRegion = 'americas' | 'europe' | 'apac' | 'mena' | 'africa';
export type FlightStatus = 'scheduled' | 'boarding' | 'departed' | 'airborne' | 'landed' | 'arrived' | 'cancelled' | 'diverted' | 'unknown';

export interface AirportDelayAlert {
  id: string;
  iata: string;
  icao: string;
  name: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  region: AirportRegion;
  delayType: FlightDelayType;
  severity: FlightDelaySeverity;
  avgDelayMinutes: number;
  delayedFlightsPct?: number;
  cancelledFlights?: number;
  totalFlights?: number;
  reason?: string;
  source: FlightDelaySource;
  updatedAt: Date;
}

export interface AirportOpsSummary {
  iata: string;
  icao: string;
  name: string;
  delayPct: number;
  avgDelayMinutes: number;
  cancellationRate: number;
  totalFlights: number;
  closureStatus: boolean;
  notamFlags: string[];
  severity: FlightDelaySeverity;
  topDelayReasons: string[];
  source: string;
  updatedAt: Date;
}

export interface FlightInstance {
  flightNumber: string;
  date: string;
  carrier: { iata: string; name: string };
  origin: { iata: string; name: string };
  destination: { iata: string; name: string };
  scheduledDeparture: Date | null;
  scheduledArrival: Date | null;
  estimatedDeparture: Date | null;
  estimatedArrival: Date | null;
  status: FlightStatus;
  delayMinutes: number;
  cancelled: boolean;
  diverted: boolean;
  gate: string;
  terminal: string;
  aircraftType: string;
  source: string;
}

export interface CarrierOps {
  carrierIata: string;
  carrierName: string;
  airport: string;
  totalFlights: number;
  delayedCount: number;
  cancelledCount: number;
  avgDelayMinutes: number;
  delayPct: number;
  cancellationRate: number;
  updatedAt: Date;
}

export interface PositionSample {
  icao24: string;
  callsign: string;
  lat: number;
  lon: number;
  altitudeFt: number;
  groundSpeedKts: number;
  trackDeg: number;
  onGround: boolean;
  source: string;
  observedAt: Date;
}

export interface PriceQuote {
  id: string;
  origin: string;
  destination: string;
  departureDate: string;
  carrierIata: string;
  carrierName: string;
  priceAmount: number;
  currency: string;
  cabin: string;
  stops: number;
  durationMinutes: number;
  isIndicative: boolean;
  provider: string;          // 'travelpayouts_data' | 'demo'
  expiresAt: Date | null;   // null means no known expiry
  checkoutRef: string;       // empty for cached/demo
}

/** Returns true if a quote has a known expiry that has passed. */
export function isPriceExpired(q: PriceQuote): boolean {
  return q.expiresAt !== null && q.expiresAt.getTime() < Date.now();
}

export interface AviationNewsItem {
  id: string;
  title: string;
  url: string;
  sourceName: string;
  publishedAt: Date;
  snippet: string;
  matchedEntities: string[];
}

export interface GoogleFlightLeg {
  airlineCode: string;
  flightNumber: string;
  departureAirport: string;
  arrivalAirport: string;
  departureDatetime: string;  // local ISO datetime, no UTC offset
  arrivalDatetime: string;
  durationMinutes: number;
}

export interface GoogleFlightItinerary {
  legs: GoogleFlightLeg[];
  price: number;
  durationMinutes: number;
  stops: number;
}

export interface GoogleFlightsResult {
  flights: GoogleFlightItinerary[];
  degraded: boolean;
  error: string;
}

export interface DatePrice {
  date: string;       // YYYY-MM-DD
  returnDate: string; // YYYY-MM-DD or ''
  price: number;
}

export interface GoogleDatesResult {
  dates: DatePrice[];
  degraded: boolean;
  error: string;
}

// ---- Enum maps ----

const SEVERITY_MAP: Record<string, FlightDelaySeverity> = {
  FLIGHT_DELAY_SEVERITY_NORMAL: 'normal',
  FLIGHT_DELAY_SEVERITY_MINOR: 'minor',
  FLIGHT_DELAY_SEVERITY_MODERATE: 'moderate',
  FLIGHT_DELAY_SEVERITY_MAJOR: 'major',
  FLIGHT_DELAY_SEVERITY_SEVERE: 'severe',
  FLIGHT_DELAY_SEVERITY_UNKNOWN: 'unknown',
};

const DELAY_TYPE_MAP: Record<string, FlightDelayType> = {
  FLIGHT_DELAY_TYPE_GROUND_STOP: 'ground_stop',
  FLIGHT_DELAY_TYPE_GROUND_DELAY: 'ground_delay',
  FLIGHT_DELAY_TYPE_DEPARTURE_DELAY: 'departure_delay',
  FLIGHT_DELAY_TYPE_ARRIVAL_DELAY: 'arrival_delay',
  FLIGHT_DELAY_TYPE_GENERAL: 'general',
  FLIGHT_DELAY_TYPE_CLOSURE: 'closure',
};

const REGION_MAP: Record<string, AirportRegion> = {
  AIRPORT_REGION_AMERICAS: 'americas',
  AIRPORT_REGION_EUROPE: 'europe',
  AIRPORT_REGION_APAC: 'apac',
  AIRPORT_REGION_MENA: 'mena',
  AIRPORT_REGION_AFRICA: 'africa',
};

const SOURCE_MAP: Record<string, FlightDelaySource> = {
  FLIGHT_DELAY_SOURCE_UNSPECIFIED: 'unspecified',
  FLIGHT_DELAY_SOURCE_FAA: 'faa',
  FLIGHT_DELAY_SOURCE_EUROCONTROL: 'eurocontrol',
  FLIGHT_DELAY_SOURCE_COMPUTED: 'computed',
  FLIGHT_DELAY_SOURCE_AVIATIONSTACK: 'aviationstack',
  FLIGHT_DELAY_SOURCE_NOTAM: 'notam',
};


// ---- Normalizers ----


function toDisplayAlert(p: ProtoAlert): AirportDelayAlert {
  return {
    id: p.id, iata: p.iata, icao: p.icao, name: p.name, city: p.city, country: p.country,
    lat: p.location?.latitude ?? 0, lon: p.location?.longitude ?? 0,
    region: REGION_MAP[p.region] ?? 'americas',
    delayType: DELAY_TYPE_MAP[p.delayType] ?? 'general',
    severity: SEVERITY_MAP[p.severity] ?? 'normal',
    avgDelayMinutes: p.avgDelayMinutes,
    delayedFlightsPct: p.delayedFlightsPct || undefined,
    cancelledFlights: p.cancelledFlights || undefined,
    totalFlights: p.totalFlights || undefined,
    reason: p.reason || undefined,
    source: SOURCE_MAP[p.source] ?? 'computed',
    updatedAt: new Date(p.updatedAt),
  };
}

function toDisplayOps(p: ProtoOpsSummary): AirportOpsSummary {
  return {
    iata: p.iata, icao: p.icao, name: p.name,
    delayPct: p.delayPct, avgDelayMinutes: p.avgDelayMinutes, cancellationRate: p.cancellationRate,
    totalFlights: p.totalFlights, closureStatus: p.closureStatus,
    notamFlags: p.notamFlags ?? [], severity: SEVERITY_MAP[p.severity] ?? 'normal',
    topDelayReasons: p.topDelayReasons ?? [], source: p.source, updatedAt: new Date(p.updatedAt),
  };
}



function toDisplayPosition(p: ProtoPosition): PositionSample {
  return {
    icao24: p.icao24, callsign: p.callsign, lat: p.lat, lon: p.lon,
    altitudeFt: Math.round(p.altitudeM * 3.281),
    groundSpeedKts: p.groundSpeedKts, trackDeg: p.trackDeg, onGround: p.onGround,
    source: p.source, observedAt: new Date(p.observedAt),
  };
}


function toDisplayNewsItem(p: ProtoAviationNews): AviationNewsItem {
  return {
    id: p.id, title: p.title, url: p.url, sourceName: p.sourceName,
    publishedAt: new Date(p.publishedAt), snippet: p.snippet,
    matchedEntities: p.matchedEntities ?? [],
  };
}

function toDisplayGoogleFlight(p: ProtoGoogleFlightResult): GoogleFlightItinerary {
  return {
    legs: (p.legs ?? []).map(l => ({
      airlineCode: l.airlineCode ?? '',
      flightNumber: l.flightNumber ?? '',
      departureAirport: l.departureAirport ?? '',
      arrivalAirport: l.arrivalAirport ?? '',
      departureDatetime: l.departureDatetime ?? '',
      arrivalDatetime: l.arrivalDatetime ?? '',
      durationMinutes: l.durationMinutes ?? 0,
    })),
    price: p.price ?? 0,
    durationMinutes: p.durationMinutes ?? 0,
    stops: p.stops ?? 0,
  };
}

function toDisplayDatePrice(p: ProtoDatePriceEntry): DatePrice {
  return { date: p.date ?? '', returnDate: p.returnDate ?? '', price: p.price ?? 0 };
}

// ---- Client + circuit breakers ----

// rpcFetch, not raw fetch: the three AviationStack-metered routes are in
// PREMIUM_RPC_PATHS, and only rpcFetch attaches the Clerk Bearer for them.
// Injection is path-gated inside rpcFetch, so the free aviation methods on
// this same client (delays, ops summary, news, tracking) are unaffected.
const client = new AviationServiceClient(getRpcBaseUrl(), { fetch: rpcFetch });

function reviveDate(value: unknown): Date {
  if (value instanceof Date) {
    if (Number.isFinite(value.getTime())) return value;
  } else if (
    value !== null
    && (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)))
  ) {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return date;
  }
  throw new TypeError('Invalid persisted date');
}

const breakerDelays = createCircuitBreaker<AirportDelayAlert[]>({
  name: 'Flight Delays v2',
  cacheTtlMs: 2 * 60 * 60 * 1000,
  persistCache: true,
  revivePersistedData: (alerts) => alerts.map((alert) => ({
    ...alert,
    updatedAt: reviveDate(alert.updatedAt),
  })),
});

const breakerOps = createCircuitBreaker<AirportOpsSummary[]>({
  name: 'Airport Ops',
  cacheTtlMs: 6 * 60 * 1000,
  persistCache: true,
  revivePersistedData: (summaries) => summaries.map((summary) => ({
    ...summary,
    updatedAt: reviveDate(summary.updatedAt),
  })),
});

const breakerTrack = createCircuitBreaker<PositionSample[]>({ name: 'Track Aircraft', cacheTtlMs: 15 * 1000, persistCache: false });
const breakerNews = createCircuitBreaker<AviationNewsItem[]>({
  name: 'Aviation News',
  cacheTtlMs: 15 * 60 * 1000,
  persistCache: true,
  revivePersistedData: (items) => items.map((item) => ({
    ...item,
    publishedAt: reviveDate(item.publishedAt),
  })),
});
// No client-side cache for Google Flights search (gateway is no-store, prices change rapidly)
const breakerGoogleFlights = createCircuitBreaker<GoogleFlightsResult>({ name: 'Google Flights', cacheTtlMs: 0, persistCache: false });
// 5-min client cache (server has 10-min Redis + medium gateway cache)
const breakerGoogleDates = createCircuitBreaker<GoogleDatesResult>({ name: 'Google Dates', cacheTtlMs: 5 * 60 * 1000, persistCache: false });

// ---- Public API ----

export async function fetchFlightDelays(): Promise<AirportDelayAlert[]> {
  const hydrated = getHydratedData('flightDelays') as { alerts?: ProtoAlert[] } | undefined;
  if (hydrated?.alerts?.length) {
    // Warm the delays breaker under the same key a later recurring call reads
    // (#7048); the non-empty guard mirrors its shouldCache.
    const alerts = hydrated.alerts.map(toDisplayAlert);
    breakerDelays.recordSuccess(alerts);
    return alerts;
  }

  return breakerDelays.execute(async () => {
    const onDemand = await ensureHydrated('flightDelays') as { alerts?: ProtoAlert[] } | undefined;
    if (onDemand?.alerts?.length) return onDemand.alerts.map(toDisplayAlert);

    const r = await client.listAirportDelays({ region: 'AIRPORT_REGION_UNSPECIFIED', minSeverity: 'FLIGHT_DELAY_SEVERITY_UNSPECIFIED', pageSize: 0, cursor: '' });
    return r.alerts.map(toDisplayAlert);
  }, [], { shouldCache: (r) => r.length > 0 });
}

export async function fetchAirportOpsSummary(airports: string[]): Promise<AirportOpsSummary[]> {
  return breakerOps.execute(async () => {
    const r = await client.getAirportOpsSummary({ airports });
    return r.summaries.map(toDisplayOps);
  }, [], { cacheKey: airports.join(',') });
}

export async function fetchAircraftPositions(
  opts: { icao24?: string; callsign?: string; swLat?: number; swLon?: number; neLat?: number; neLon?: number },
  signal?: AbortSignal,
): Promise<PositionSample[]> {
  return breakerTrack.execute(async () => {
    const r = await client.trackAircraft(
      { icao24: opts.icao24 ?? '', callsign: opts.callsign ?? '', swLat: opts.swLat ?? 0, swLon: opts.swLon ?? 0, neLat: opts.neLat ?? 0, neLon: opts.neLon ?? 0 },
      { signal },
    );
    return r.positions.map(toDisplayPosition);
  }, [], {
    cacheKey: `${opts.icao24 ?? ''}:${opts.callsign ?? ''}:${opts.swLat ?? 0}:${opts.swLon ?? 0}:${opts.neLat ?? 0}:${opts.neLon ?? 0}`,
    ignoreError: () => signal?.aborted === true,
  });
}

export async function fetchAviationNews(entities: string[], windowHours = 24, maxItems = 20): Promise<AviationNewsItem[]> {
  const cacheKey = `${entities.join(',')}:${windowHours}:${maxItems}`;
  return breakerNews.execute(async () => {
    const r = await client.listAviationNews({ entities, windowHours, maxItems });
    return r.items.map(toDisplayNewsItem);
  }, [], { cacheKey });
}

export async function fetchGoogleFlights(opts: {
  origin: string; destination: string; departureDate: string;
  returnDate?: string; cabinClass?: string; maxStops?: string;
  sortBy?: string; passengers?: number;
}): Promise<GoogleFlightsResult> {
  const cacheKey = `${opts.origin}:${opts.destination}:${opts.departureDate}:${opts.returnDate ?? ''}:${opts.cabinClass ?? 'ECONOMY'}:${opts.maxStops ?? ''}:${opts.sortBy ?? ''}:${opts.passengers ?? 1}`;
  return breakerGoogleFlights.execute(async () => {
    const r = await client.searchGoogleFlights({
      origin: opts.origin, destination: opts.destination,
      departureDate: opts.departureDate, returnDate: opts.returnDate ?? '',
      cabinClass: opts.cabinClass ?? 'ECONOMY', maxStops: opts.maxStops ?? '',
      departureWindow: '', airlines: [], sortBy: opts.sortBy ?? '',
      passengers: opts.passengers ?? 1,
    });
    return { flights: r.flights.map(toDisplayGoogleFlight), degraded: r.degraded ?? false, error: r.error ?? '' };
  }, { flights: [], degraded: true, error: 'Request failed' }, { cacheKey });
}

export async function fetchGoogleDates(opts: {
  origin: string; destination: string; startDate: string; endDate: string;
  tripDuration?: number; isRoundTrip?: boolean; cabinClass?: string;
  maxStops?: string; passengers?: number;
}): Promise<GoogleDatesResult> {
  const cacheKey = `${opts.origin}:${opts.destination}:${opts.startDate}:${opts.endDate}:${opts.tripDuration ?? 0}:${opts.isRoundTrip ?? false}:${opts.cabinClass ?? 'ECONOMY'}:${opts.maxStops ?? ''}:${opts.passengers ?? 1}`;
  return breakerGoogleDates.execute(async () => {
    const r = await client.searchGoogleDates({
      origin: opts.origin, destination: opts.destination,
      startDate: opts.startDate, endDate: opts.endDate,
      tripDuration: opts.tripDuration ?? 0, isRoundTrip: opts.isRoundTrip ?? false,
      cabinClass: opts.cabinClass ?? 'ECONOMY', maxStops: opts.maxStops ?? '',
      departureWindow: '', airlines: [], sortByPrice: true,
      passengers: opts.passengers ?? 1,
    });
    return { dates: r.dates.map(toDisplayDatePrice), degraded: r.degraded ?? false, error: r.error ?? '' };
  }, { dates: [], degraded: true, error: 'Request failed' }, { cacheKey });
}
