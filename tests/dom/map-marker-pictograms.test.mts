import * as d3 from 'd3';
import { IconLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeckGLMap } from '@/components/DeckGLMap';
import { MapComponent } from '@/components/Map';
import type { MapLayers } from '@/types';
import { preloadCountryGeometry } from '@/services/country-geometry';
import { TRADE_ROUTES } from '@/config/trade-routes';
import { LAYER_REGISTRY, resolveLayerIcon } from '@/config/map-layer-definitions';
import { initTestI18n } from './helpers/i18n.mts';
import {
  setCachedStorageFacilityRegistry,
  __resetStorageFacilityRegistryStoreForTests,
} from '@/shared/storage-facility-registry-store';
import {
  setCachedFuelShortageRegistry,
  __resetFuelShortageRegistryStoreForTests,
} from '@/shared/fuel-shortage-registry-store';

// Prototype fixtures avoid constructor-owned GPU/network boot. The production
// factories, deck.gl classes, budget, projection, and DOM render loops stay real.
type Harness = Record<string, any>;
const point = { id: 'fixture', lon: 12, lat: 34 };
const projection = d3.geoEquirectangular().scale(100).translate([400, 300]);
const accessor = (value: any, datum: any) => typeof value === 'function' ? value(datum) : value;

function deck(): Harness {
  return Object.assign(Object.create(DeckGLMap.prototype), {
    state: { layers: {}, timeRange: 'all' },
    maplibreMap: null,
    pulseTime: 1000,
    lastSCZoom: 2,
    layerCache: new Map(),
    liveTankersTimer: null,
    newsLocationFirstSeen: new Map(),
    highlightedAssets: { base: new Set(), nuclear: new Set(), datacenter: new Set() },
    aptGroups: [point],
    liveTankers: [{ ...point, speed: 2 }],
    aisDisruptions: [{ ...point, severity: 'high', type: 'spoofing' }],
    repairShips: [point],
    hotspots: [{ ...point, level: 'high', escalationScore: 4 }],
    newsLocations: [{ ...point, title: 'Local report', threatLevel: 'critical' }],
    renewableInstallations: [{ ...point, type: 'solar' }],
    speciesRecoveryZones: [{ id: 'species', recoveryZone: { name: 'Habitat', lon: 12, lat: 34 } }],
    tradeRouteSegments: TRADE_ROUTES.map(route => ({ routeId: route.id })),
    highlightedMarkers: [{ ...point, score: 80 }],
    tradeAnimationTime: 0,
  });
}

function factory(map: Harness, method: string, input?: any[]): any {
  const result = input ? map[method](input) : map[method]();
  return Array.isArray(result) ? result[0] : result;
}

function svgDocument(url: string): Document {
  expect(url, 'icons must be built-in SVG, not a remote asset').toMatch(/^data:image\/svg\+xml[;,]/);
  const payload = url.slice(url.indexOf(',') + 1);
  const xml = url.slice(0, url.indexOf(',')).includes(';base64') ? atob(payload) : decodeURIComponent(payload);
  const document = new DOMParser().parseFromString(xml, 'image/svg+xml');
  expect(document.querySelector('svg')).not.toBeNull();
  return document;
}

function pictogramGeometry(svg: Element): string {
  // Different labels, colors, or registry keys do not make different symbols.
  const attributes = ['d', 'points', 'x', 'y', 'width', 'height', 'cx', 'cy', 'r', 'rx', 'ry', 'x1', 'y1', 'x2', 'y2', 'transform'];
  return Array.from(svg.querySelectorAll('path, polygon, polyline, line, rect, circle, ellipse'))
    .map(shape => `${shape.tagName}:${attributes.map(name => shape.getAttribute(name) ?? '').join(':')}`)
    .join('|');
}

function iconSvg(layer: any, datum = layer.props.data[0]): string {
  expect(layer, `${layer.id}: an ordinary location must render an SVG pictogram, not a circular point`).toBeInstanceOf(IconLayer);
  const icon = accessor(layer.props.getIcon, datum);
  // Without GPU initialization deck.gl has not resolved the async atlas prop.
  // Inspect the real constructor's retained input, not a replacement layer.
  const original = Object.getOwnPropertySymbols(layer.props).find(symbol => symbol.description === 'asyncPropOriginal');
  const url = typeof icon === 'object' ? icon.url : (layer.props.iconAtlas ?? layer.props[original!]?.iconAtlas);
  const svg = svgDocument(url).querySelector('svg')!;
  const cell = typeof icon === 'string' ? layer.props.iconMapping[icon] : undefined;
  // Read the selected atlas cell, not every category in the whole atlas.
  const geometry = cell && svg.querySelector('g[transform]')
    ? svg.querySelector(`g[transform="translate(${cell.x} ${cell.y})"]`)!
    : svg;
  expect(geometry, `${layer.id}: selected icon must exist in its atlas`).not.toBeNull();
  expect(geometry.querySelector('path, polygon, polyline, line, rect'), `${layer.id}: circle-only SVG is not a pictogram`).not.toBeNull();
  return pictogramGeometry(geometry);
}

describe('retained native marker and control correspondence', () => {
  it('datacenter outline symbols retain their full hit target, status colors and size clamps', () => {
    const map = deck();
    const site = { ...point, status: 'existing' };
    map.getActiveDatacenters = () => [site];
    const layer = map.createDatacentersLayer();
    expect(layer.props.alphaCutoff).toBe(0);
    expect(layer.props.pickable).toBe(true);
    expect(accessor(layer.props.getSize, site)).toBe(10);
    expect(layer.props.sizeMinPixels).toBe(6);
    expect(layer.props.sizeMaxPixels).toBe(14);
    expect(accessor(layer.props.getColor, site)).toEqual([136, 68, 255, 140]);
    expect(accessor(layer.props.getColor, { ...site, status: 'planned' })).toEqual([136, 68, 255, 100]);
  });

  it('military base UI unification preserves map category colors and picking', () => {
    const map = deck();
    map.maplibreMap = { getZoom: () => 5 };
    map.getBasesData = () => [point];
    const layer = map.createBasesLayer();
    expect(layer.props.pickable).toBe(true);
    expect(accessor(layer.props.getSize, point)).toBe(11);
    for (const [type, color] of [
      ['us-nato', [68, 136, 255, 160]],
      ['russia', [255, 68, 68, 160]],
      ['france', [0, 85, 164, 160]],
      ['italy', [0, 146, 70, 160]],
    ] as const) {
      expect(accessor(layer.props.getColor, { ...point, type })).toEqual(color);
    }
    map.highlightedAssets.base.add(point.id);
    expect(accessor(layer.props.getSize, point)).toBe(16);
    expect(accessor(layer.props.getColor, point)).toEqual([255, 100, 100, 220]);
  });

  it('nuclear symbols retain their hit target, severity colors and size clamps', () => {
    const map = deck();
    const site = { ...point, status: 'active' };
    map.getActiveNuclearFacilities = () => [site];
    const layer = map.createNuclearLayer();
    expect(layer.props.alphaCutoff).toBe(0);
    expect(layer.props.pickable).toBe(true);
    expect(accessor(layer.props.getSize, site)).toBe(11);
    expect(layer.props.sizeMinPixels).toBe(6);
    expect(layer.props.sizeMaxPixels).toBe(15);
    expect(accessor(layer.props.getColor, site)).toEqual([255, 220, 0, 200]);
    expect(accessor(layer.props.getColor, { ...site, status: 'contested' })).toEqual([255, 50, 50, 200]);
  });

  for (const [key, method] of [
    ['bases', 'createBasesLayer'],
    ['nuclear', 'createNuclearLayer'],
    ['datacenters', 'createDatacentersLayer'],
    ['flights', 'createAircraftPositionsLayer'],
  ] as const) {
    it(`${key} shows its real map shape instead of an unrelated catalog emoji`, () => {
      const map = deck();
      map.getBasesData = () => [point];
      map.getActiveNuclearFacilities = () => [point];
      const layer = factory(map, method);
      const symbol = new DOMParser().parseFromString(resolveLayerIcon(LAYER_REGISTRY[key]!, 'deck'), 'image/svg+xml');
      expect(symbol.querySelector('svg'), `${key}: picker must show the actual marker geometry`).not.toBeNull();
      expect(pictogramGeometry(symbol.documentElement)).toBe(iconSvg(layer));
    });
  }
});

const catalogFactories = [
  ['createIrradiatorsLayer', 'irradiators-layer'],
  ['createSpaceportsLayer', 'spaceports-layer'],
  ['createPortsLayer', 'ports-layer'],
  ['createWaterwaysLayer', 'waterways-layer'],
  ['createEconomicCentersLayer', 'economic-centers-layer'],
  ['createStockExchangesLayer', 'stock-exchanges-layer'],
  ['createFinancialCentersLayer', 'financial-centers-layer'],
  ['createCentralBanksLayer', 'central-banks-layer'],
  ['createCommodityHubsLayer', 'commodity-hubs-layer'],
  ['createMineralsLayer', 'minerals-layer'],
  ['createMiningSitesLayer', 'mining-sites-layer'],
  ['createProcessingPlantsLayer', 'processing-plants-layer'],
  ['createCommodityPortsLayer', 'commodity-ports-layer'],
  ['createStartupHubsLayer', 'startup-hubs-layer'],
  ['createAcceleratorsLayer', 'accelerators-layer'],
  ['createCloudRegionsLayer', 'cloud-regions-layer'],
  ['createGulfInvestmentsLayer', 'gulf-investments-layer'],
  ['createAPTGroupsLayer', 'apt-groups-layer'],
  ['createLiveTankersLayer', 'live-tankers-layer'],
  ['createAisDisruptionsLayer', 'ais-disruptions-layer'],
  ['createRepairShipsLayer', 'repair-ships-layer'],
  ['createRenewableInstallationsLayer', 'renewable-installations-layer'],
] as const;

// Literals are hand-derived from fixture severity/tier, not an icon helper.
const eventFactories = [
  ['createEarthquakesLayer', 'earthquakes-layer', { id: 'quake', location: { longitude: 12, latitude: 34 }, magnitude: 6 }, [255, 0, 0, 200], 4, 30],
  ['createNaturalEventsLayers', 'natural-events-layer', { ...point, title: 'Volcano', category: 'volcanoes' }, [255, 150, 50, 180], 5, 18],
  ['createNaturalEventsLayers', 'storm-centers-layer', { ...point, title: 'Cyclone', stormName: 'Storm', windKt: 60 }, null, 6, 20],
  ['createFiresLayer', 'fires-layer', { ...point, frp: 20, brightness: 410 }, [255, 30, 0, 220], 3, 12],
  ['createIranEventsLayer', 'iran-events-layer', { id: 'iran', longitude: 12, latitude: 34, severity: 'high', category: 'military' }, null, 4, 16],
  ['createCanadaRoadsLayers', 'canada-roads-layer', { id: 'road', centroid: [12, 34], kind: 'event', isFullClosure: true }, null, 6, 18],
  ['createCanadaAlertsLayer', 'canada-alerts-layer', { id: 'alert', centroid: [12, 34], severity: 'Extreme' }, [255, 0, 0, 200], 8, 20],
  ['createWeatherLayer', 'weather-layer', { id: 'weather', centroid: [12, 34], severity: 'Severe' }, [255, 100, 0, 180], 8, 20],
  ['createOutagesLayer', 'outages-layer', point, null, 6, 18],
  ['createTrafficAnomaliesLayer', 'traffic-anomalies-layer', { id: 'traffic', longitude: 12, latitude: 34 }, null, 5, 14],
  ['createDdosLocationsLayer', 'ddos-locations-layer', { id: 'ddos', longitude: 12, latitude: 34, percentage: 10 }, null, 5, 16],
  ['createCyberThreatsLayer', 'cyber-threats-layer', { ...point, severity: 'critical' }, [255, 61, 0, 225], 6, 18],
  ['createRadiationLayer', 'radiation-watch-layer', { ...point, severity: 'spike', confidence: 'high', corroborated: true }, [255, 48, 48, 220], 6, 20],
  ['createDiseaseOutbreaksLayer', 'disease-outbreaks-layer', { id: 'disease', lat: 34, lng: 12, alertLevel: 'alert' }, [231, 76, 60, 200], 5, 22],
  ['createCableAdvisoriesLayer', 'cable-advisories-layer', { ...point, severity: 'fault' }, [255, 50, 50, 220], 5, 12],
  ['createFlightDelaysLayer', 'flight-delays-layer', { ...point, severity: 'severe' }, [255, 50, 50, 200], 4, 15],
  ['createMilitaryVesselsLayer', 'military-vessels-layer', { ...point, usniSource: true }, [255, 160, 60, 160], 4, 10],
  ['createMilitaryFlightsLayer', 'military-flights-layer', { ...point, onGround: true }, [120, 120, 120, 160], 4, 12],
  ['createUcdpEventsLayer', 'ucdp-events-layer', { id: 'ucdp', longitude: 12, latitude: 34, deaths_best: 5, type_of_violence: 'state-based' }, null, 3, 20],
  ['createPositiveEventsLayers', 'positive-events-layer', { ...point, category: 'science-health', count: 1 }, [234, 179, 8, 200], 5, 10],
  ['createKindnessLayers', 'kindness-layer', { ...point, type: 'real' }, [74, 222, 128, 200], 5, 10],
] as const;

const pointLayerKeys: Partial<Record<string, keyof MapLayers>> = {
  'irradiators-layer': 'irradiators', 'spaceports-layer': 'spaceports',
  'waterways-layer': 'waterways', 'economic-centers-layer': 'economic',
  'stock-exchanges-layer': 'stockExchanges', 'financial-centers-layer': 'financialCenters',
  'central-banks-layer': 'centralBanks', 'commodity-hubs-layer': 'commodityHubs',
  'minerals-layer': 'minerals', 'mining-sites-layer': 'miningSites',
  'processing-plants-layer': 'processingPlants', 'commodity-ports-layer': 'commodityPorts',
  'startup-hubs-layer': 'startupHubs', 'accelerators-layer': 'accelerators',
  'cloud-regions-layer': 'cloudRegions', 'gulf-investments-layer': 'gulfInvestments',
  'live-tankers-layer': 'liveTankers', 'fires-layer': 'fires',
  'iran-events-layer': 'iranAttacks', 'canada-roads-layer': 'canadaRoads',
  'canada-alerts-layer': 'canadaAlerts', 'weather-layer': 'weather',
  'outages-layer': 'outages', 'cyber-threats-layer': 'cyberThreats',
  'radiation-watch-layer': 'radiationWatch', 'disease-outbreaks-layer': 'diseaseOutbreaks',
  'ucdp-events-layer': 'ucdpEvents', 'kindness-layer': 'kindness',
};

describe('real DeckGL ordinary point factories', () => {
  for (const [method, id, input] of [...catalogFactories, ...eventFactories]) {
    const key = pointLayerKeys[id];
    if (!key) continue;
    it(`${id} matches its layer control across the complete point catalog`, () => {
      const layer = factory(deck(), method, input ? [input] : undefined);
      const symbol = new DOMParser().parseFromString(resolveLayerIcon(LAYER_REGISTRY[key]!, 'deck'), 'image/svg+xml');
      expect(pictogramGeometry(symbol.documentElement)).toBe(iconSvg(layer));
    });
  }

  it('a labor strike uses a protest glyph, not a military missile glyph', () => {
    const map = deck();
    map.protestClusters = [{ ...point, count: 1, hasRiot: false, maxSeverity: 'low', items: [{ eventType: 'strike' }] }];
    const layer = map.createProtestClusterLayers().find((item: any) => item instanceof IconLayer);
    const symbol = new DOMParser().parseFromString(resolveLayerIcon(LAYER_REGISTRY.protests!, 'deck'), 'image/svg+xml');
    expect(iconSvg(layer)).toBe(pictogramGeometry(symbol.documentElement));
  });

  it('a datacenter singleton matches the native server rack rather than changing shape with clustering', () => {
    const map = deck();
    map.datacenterClusters = [{ ...point, count: 1, majorityExisting: true, items: [] }];
    const layer = map.createDatacenterClusterLayers().find((item: any) => item instanceof IconLayer);
    expect(iconSvg(layer)).toBe(iconSvg(map.createDatacentersLayer()));
  });

  it('datacenter aggregates omit map count labels while retaining server racks, status colors and popup counts', () => {
    const map = deck();
    const existing = { ...point, count: 5, majorityExisting: true, items: [], country: 'Saudi Arabia', totalChips: 100, totalPowerMW: 20 };
    const planned = { ...existing, id: 'planned', count: 3, majorityExisting: false };
    map.datacenterClusters = [existing, planned];
    map.popup = { show: vi.fn() };
    const layers = map.createDatacenterClusterLayers();
    const markers = layers.find((layer: any) => layer.props.pickable && layer.props.data.includes(existing));
    expect(markers).toBeInstanceOf(IconLayer);
    expect(markers.id).toBe('datacenter-clusters-layer');
    expect(iconSvg(markers, existing)).toBe(iconSvg(map.createDatacentersLayer()));
    expect(accessor(markers.props.getColor, existing)).toEqual([160, 80, 255, 180]);
    expect(accessor(markers.props.getColor, planned)).toEqual([80, 160, 255, 180]);
    expect(accessor(markers.props.getPosition, existing)).toEqual([12, 34]);
    expect(accessor(markers.props.getSize, existing)).toBe(12);
    expect(accessor(markers.props.getSize, planned)).toBe(12);
    expect(accessor(markers.props.getSize, { ...existing, count: 137 })).toBe(12);
    expect(markers.props.sizeUnits).toBe('pixels');
    expect(markers.props.sizeMinPixels).toBe(12);
    expect(markers.props.sizeMaxPixels).toBe(12);
    expect(layers.filter((layer: any) => layer instanceof TextLayer)).toHaveLength(0);
    map.handleClick({ layer: markers, object: existing, x: 120, y: 90 });
    expect(map.popup.show.mock.calls.at(-1)[0]).toMatchObject({
      type: 'datacenterCluster', data: { count: 5, totalChips: 100, totalPowerMW: 20 }, x: 120, y: 90,
    });
  });

  it.each(catalogFactories)('%s renders a built-in pictogram and preserves its location/ID/picking', (method, id) => {
    const layer = factory(deck(), method);
    expect(layer.id).toBe(id);
    expect(layer.props.data.length).toBeGreaterThan(0);
    const datum = layer.props.data[0];
    expect(accessor(layer.props.getPosition, datum)).toEqual([datum.lon, datum.lat]);
    expect(layer.props.pickable).toBe(true);
    iconSvg(layer);
  });

  it.each(eventFactories)('%s (%s) renders an SVG pictogram', (method, id, datum) => {
    const layer = factory(deck(), method, [datum]);
    expect(layer.id).toBe(id);
    iconSvg(layer);
  });

  it.each(eventFactories)('%s (%s) preserves data, coordinates, severity color and screen-size clamps', (method, id, datum, color, min, max) => {
    const layer = factory(deck(), method, [datum]);
    const rendered = layer.props.data[0];
    // Outbreaks deliberately wrap their source record after geolocation.
    expect(rendered.item ?? rendered).toBe(datum);
    expect(accessor(layer.props.getPosition, rendered)).toEqual([12, 34]);
    expect(layer.props.pickable).toBe(id !== 'ucdp-events-layer');
    const isIcon = layer instanceof IconLayer;
    if (color) expect(accessor(isIcon ? layer.props.getColor : layer.props.getFillColor, rendered)).toEqual(color);
    // Icon size is a diameter; Scatterplot radius is half the visual footprint.
    expect(isIcon ? layer.props.sizeMinPixels / 2 : layer.props.radiusMinPixels).toBe(min);
    expect(isIcon ? layer.props.sizeMaxPixels / 2 : layer.props.radiusMaxPixels).toBe(max);
  });

  it('financial categories cannot collapse to one generic symbol', () => {
    const map = deck();
    const svgs = ['createStockExchangesLayer', 'createFinancialCentersLayer', 'createCentralBanksLayer', 'createCommodityHubsLayer']
      .map(method => iconSvg(factory(map, method)));
    expect(new Set(svgs).size).toBe(4);
  });

  it.each([
    ['createEarthquakesLayer', { magnitude: 6, location: { longitude: 12, latitude: 34 } }, 128000],
    ['createFiresLayer', { ...point, frp: 20, brightness: 410 }, 8000],
    ['createCyberThreatsLayer', { ...point, severity: 'critical' }, 44000],
    ['createRadiationLayer', { ...point, severity: 'spike', confidence: 'high', corroborated: true }, 59800],
    ['createFlightDelaysLayer', { ...point, severity: 'severe' }, 30000],
  ])('%s uses the original radius as half its world-space icon diameter', (method, datum, diameter) => {
    const layer = factory(deck(), method, [datum]);
    expect(layer.props.sizeUnits).toBe('meters');
    expect(accessor(layer.props.getSize, layer.props.data[0])).toBeCloseTo(diameter, 6);
    expect(layer.props.alphaCutoff).toBe(0);
  });

  it('natural-event categories have distinct pictograms', () => {
    const svgs = ['volcanoes', 'wildfires', 'floods', 'earthquakes'].map(category =>
      iconSvg(factory(deck(), 'createNaturalEventsLayers', [{ ...point, title: category, category }])));
    expect(new Set(svgs).size).toBe(4);
  });

  it('renewable installation types have distinct pictograms without losing their type colors', () => {
    const map = deck();
    map.renewableInstallations = ['solar', 'wind', 'hydro', 'geothermal'].map(type => ({ ...point, type }));
    const layer = map.createRenewableInstallationsLayer();
    const colors = [[255, 200, 50, 200], [100, 200, 255, 200], [0, 180, 180, 200], [255, 150, 80, 200]];
    layer.props.data.forEach((datum: any, index: number) => {
      expect(accessor(layer instanceof IconLayer ? layer.props.getColor : layer.props.getFillColor, datum)).toEqual(colors[index]);
    });
    const svgs = layer.props.data.map((datum: any) => iconSvg(layer, datum));
    expect(new Set(svgs).size).toBe(4);
  });

  it('species recovery location markers render a pictogram at the recovery location', () => {
    const layer = deck().createSpeciesRecoveryLayer();
    expect(accessor(layer.props.getPosition, layer.props.data[0])).toEqual([12, 34]);
    expect(layer.props.pickable).toBe(true);
    iconSvg(layer);
  });

  it('trade chokepoint locations and selected chokepoint markers render pictograms without becoming pickable', () => {
    const map = deck();
    for (const layer of [map.createTradeChokepointsLayer(), map.createHighlightedChokepointMarkers()]) {
      expect(layer.props.data.length).toBeGreaterThan(0);
      const datum = layer.props.data[0];
      expect(accessor(layer.props.getPosition, datum)).toEqual([datum.lon, datum.lat]);
      expect(layer.props.pickable).toBe(false);
      iconSvg(layer);
    }
  });

  it('selected China corridor location nodes render pictograms while their boundary remains a polygon', () => {
    const layers = deck().createChinaCorridorSelectionLayers({
      id: 'fixture', polygon: [[10, 30], [14, 30], [14, 36], [10, 30]],
      nodes: [{ id: 'node', position: [12, 34], name: 'Transport node' }],
    });
    expect(layers[0].props.getPolygon(layers[0].props.data[0])).toEqual([[10, 30], [14, 30], [14, 36], [10, 30]]);
    expect(accessor(layers[1].props.getPosition, layers[1].props.data[0])).toEqual([12, 34]);
    expect(layers[1].props.pickable).toBe(false);
    iconSvg(layers[1]);
  });

  it('the real layer assembly converts webcam leaves but preserves count bubbles', () => {
    const map = deck();
    map.state.layers = { webcams: true };
    map.newsLocations = [];
    const camera = { id: 'camera', lng: 12, lat: 34, title: 'Fixture camera' };
    const cluster = { id: 'cluster', lng: 20, lat: 40, count: 4 };
    map.webcamData = [camera, cluster];
    map.handleWebcamLayerClick = vi.fn(() => true);
    const layers = map.buildLayers();
    const bubble = layers.find((layer: any) => layer instanceof ScatterplotLayer && layer.props.data.includes(cluster));
    expect(bubble).toBeDefined();
    const marker = layers.find((layer: any) => layer.props.data?.includes(camera) && layer.props.pickable);
    expect(marker).toBeDefined();
    expect(accessor(marker.props.getPosition, camera)).toEqual([12, 34]);
    expect(marker.props.onClick({ object: camera })).toBe(true);
    expect(map.handleWebcamLayerClick).toHaveBeenCalledWith({ object: camera });
    iconSvg(marker, camera);
  });

  it.each([
    ['createProtestClusterLayers', 'protestClusters', { ...point, count: 1, hasRiot: false, maxSeverity: 'low', items: [] }],
    ['createTechHQClusterLayers', 'techHQClusters', { ...point, count: 1, primaryType: 'faang', items: [{ company: 'Fixture' }] }],
    ['createTechEventClusterLayers', 'techEventClusters', { ...point, count: 1, soonestDaysUntil: 30, items: [] }],
  ])('%s converts singleton dots but leaves aggregate bubbles circular', (method, field, single) => {
    const map = deck();
    const aggregate = { ...single, id: 'aggregate', count: 3 };
    map[field] = [single, aggregate];
    const layers = map[method]();
    const bubble = layers.find((layer: any) => layer instanceof ScatterplotLayer && layer.props.data.includes(aggregate));
    expect(bubble, 'count > 1 remains an aggregate bubble').toBeDefined();
    const marker = layers.find((layer: any) => layer.props.data?.includes(single) && layer.props.pickable);
    expect(marker).toBeDefined();
    expect(accessor(marker.props.getPosition, single)).toEqual([12, 34]);
    iconSvg(marker, single);
  });

  it('singleton layer picks retain central tooltip and popup forwarding', () => {
    const map = deck();
    const company = { company: 'Fixture company', city: 'Fixture city' };
    const single = { ...point, count: 1, primaryType: 'faang', items: [company] };
    const aggregate = { ...single, id: 'aggregate', count: 3 };
    map.techHQClusters = [single, aggregate];
    map.popup = { show: vi.fn() };
    const layers = map.createTechHQClusterLayers();
    const icon = layers.find((layer: any) => layer instanceof IconLayer)!;
    expect(map.getTooltip({ layer: icon, object: single }).html).toContain('Fixture company');
    map.handleClick({ layer: icon, object: single, x: 100, y: 80 });
    expect(map.popup.show).toHaveBeenCalledWith({ type: 'techHQ', data: company, x: 100, y: 80 });
    map.handleClick({ layer: layers[0], object: aggregate, x: 120, y: 90 });
    expect(map.popup.show.mock.calls.at(-1)[0]).toMatchObject({
      type: 'techHQCluster', data: { count: 3, items: [company] }, x: 120, y: 90,
    });
  });

  it('news keeps threat coding, position and picking while becoming a pictogram', () => {
    const layer = deck().createNewsLocationsLayer()[0];
    expect(layer.id).toBe('news-locations-layer');
    expect(accessor(layer.props.getPosition, layer.props.data[0])).toEqual([12, 34]);
    expect(layer.props.pickable).toBe(true);
    expect(accessor(layer instanceof IconLayer ? layer.props.getColor : layer.props.getFillColor, layer.props.data[0])).toEqual([239, 68, 68, 88]);
    iconSvg(layer);
  });

  it('hotspot dots become pictograms without replacing their pulse/ghost layers', () => {
    const layers = deck().createHotspotsLayers();
    expect(layers[1]).toBeInstanceOf(ScatterplotLayer);
    expect(layers[1].props.filled).toBe(false);
    expect(layers[1].props.pickable).toBe(false);
    expect(layers[2].props.visible).toBe(false);
    iconSvg(layers[0]);
  });

  it.each([
    ['createEnergyStorageLayer', 'storage-facilities-layer', 'energy:open-storage-facility-detail', { facilityId: 'store' }],
    ['createEnergyShortagePinsLayer', 'fuel-shortages-layer', 'energy:open-fuel-shortage-detail', { shortageId: 'shortage' }],
  ])('%s retains its detail event and renders an SVG', (method, id, eventName, detail) => {
    setCachedStorageFacilityRegistry({ facilities: { store: { id: 'store', name: 'Store', facilityType: 'ugs', location: { lon: 12, lat: 34 }, capacityTwh: 10 } } });
    setCachedFuelShortageRegistry({ shortages: { shortage: { id: 'shortage', country: 'US', product: 'diesel', severity: 'confirmed', resolvedAt: null } } });
    const layer = deck()[method]();
    expect(layer.id).toBe(id);
    const observed: unknown[] = [];
    const listener = (event: Event) => observed.push((event as CustomEvent).detail);
    window.addEventListener(eventName, listener);
    try {
      expect(layer.props.onClick({ object: layer.props.data[0] })).toBe(true);
      expect(observed).toEqual([detail]);
    } finally {
      window.removeEventListener(eventName, listener);
    }
    iconSvg(layer);
  });

  it('leaves density, heatmap, closure coverage and invisible hit targets as circles', () => {
    const map = deck();
    map.aisDensity = [{ ...point, intensity: 0.5 }];
    map.climateAnomalies = [{ ...point, tempDelta: 2, precipDelta: 0 }];
    for (const layer of [
      map.createAisDensityLayer(), map.createClimateHeatmapLayer(),
      map.createNotamOverlayLayer([point]), map.createGhostLayer('fixture', [point], (d: any) => [d.lon, d.lat]),
    ]) expect(layer).toBeInstanceOf(ScatterplotLayer);
    expect(map.createEmptyGhost('fixture').props.visible).toBe(false);
  });

  it('retains the useful aircraft SVG with heading, on-ground color and picking', () => {
    const map = deck();
    const aircraft = { ...point, onGround: true, trackDeg: 90, altitudeFt: 0 };
    map.aircraftPositions = [aircraft];
    const layer = map.createAircraftPositionsLayer();
    expect(layer.id).toBe('aircraft-positions-layer');
    expect(accessor(layer.props.getPosition, aircraft)).toEqual([12, 34]);
    expect(accessor(layer.props.getAngle, aircraft)).toBe(-90);
    expect(accessor(layer.props.getColor, aircraft)).toEqual([120, 120, 120, 160]);
    expect(accessor(layer.props.getSize, aircraft)).toBe(14);
    expect(layer.props.sizeMinPixels).toBe(8);
    expect(layer.props.sizeMaxPixels).toBe(28);
    expect(layer.props.pickable).toBe(true);
    iconSvg(layer, aircraft);
  });
});

function svgMap(layers: Record<string, boolean> = {}): Harness {
  const container = document.createElement('div');
  const overlays = document.createElement('div');
  container.append(overlays);
  document.body.append(container);
  return Object.assign(Object.create(MapComponent.prototype), {
    container, overlays, wrapper: container,
    popup: { show: vi.fn(), loadConflictHistory: vi.fn(), loadHotspotGdeltContext: vi.fn() },
    state: { layers, zoom: 3, timeRange: 'all', pan: { x: 0, y: 0 } },
    lastContainerSize: { width: 800, height: 600 },
    layerZoomOverrides: {}, highlightedAssets: { nuclear: new Set(), base: new Set(), datacenter: new Set() },
    overlayMarkerCut: new Set(), overlayMarkerTruncation: {}, overlayRenderCount: 0,
    overlayAppendTarget: null, markerSettleTimer: null, destroyed: false,
    earthquakes: [], iranEvents: [], aircraftPositions: [], protests: [], conflictEvents: [],
    weatherAlerts: [], newsLocations: [], naturalEvents: [], radiationObservations: [], outages: [],
    cableAdvisories: [], flightDelays: [], militaryFlights: [], militaryFlightClusters: [],
    militaryVessels: [], militaryVesselClusters: [], firmsFireData: [], webcamData: [],
    hotspots: [], techEvents: [], techActivities: [], geoActivities: [], aptGroups: [],
  });
}

function domPictogram(marker: HTMLElement): string {
  const svg = marker.querySelector('svg');
  expect(svg, `${marker.className}: ordinary marker must contain a real SVG pictogram`).not.toBeNull();
  expect(svg!.querySelector('path, polygon, polyline, line, rect'), 'not a circle-only SVG').not.toBeNull();
  return pictogramGeometry(svg!);
}

beforeAll(async () => {
  // Hydrate real country geometry through its HTTP boundary, without network
  // or constructor boot, so the real shortage factory has a country centroid.
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature', properties: { ISO_A2: 'US', name: 'United States' },
      geometry: { type: 'Polygon', coordinates: [[[11, 33], [13, 33], [13, 35], [11, 35], [11, 33]]] },
    }],
  }), { headers: { 'Content-Type': 'application/json' } }));
  try {
    await preloadCountryGeometry();
  } finally {
    fetch.mockRestore();
  }
});

beforeEach(() => {
  vi.useFakeTimers();
  document.body.replaceChildren();
  document.documentElement.style.setProperty('--semantic-critical', '#ff0000');
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.replaceChildren();
  document.documentElement.style.removeProperty('--semantic-critical');
  __resetStorageFacilityRegistryStoreForTests();
  __resetFuelShortageRegistryStoreForTests();
});

const domDots = [
  ['news', 'news-location-marker', {}, 'newsLocations', { ...point, title: 'Local report', threatLevel: 'critical' }, 'news'],
  ['Iran event', 'iran-event-marker', { iranAttacks: true }, 'iranEvents', { id: 'iran', longitude: 12, latitude: 34, title: 'Incident', category: 'military', severity: 'high' }, 'iranEvent'],
  ['earthquake', 'earthquake-marker', { natural: true }, 'earthquakes', { id: 'quake', magnitude: 6, place: 'Fixture', location: { longitude: 12, latitude: 34 } }, 'earthquake'],
  ['radiation', 'radiation-watch-marker', { radiationWatch: true }, 'radiationObservations', { ...point, severity: 'spike', value: 10, unit: 'nSv/h', location: 'Fixture' }, 'radiation'],
  ['fire', 'fire-dot', { fires: true }, 'firmsFireData', { ...point, brightness: 410, frp: 20, region: 'Fixture' }, null],
  ['hotspot', 'hotspot', { hotspots: true }, 'hotspots', { ...point, name: 'Fixture', level: 'high' }, 'hotspot'],
] as const;

describe('real SVG fallback overlay output', () => {
  it.each(domDots.filter(row => row[0] === 'earthquake' || row[0] === 'hotspot'))(
    '%s legend uses the actual overlay pictogram instead of a stale dot',
    async (name, className, layers, field, datum) => {
      await initTestI18n();
      const map = svgMap(layers);
      map[field] = [datum];
      map.renderOverlays(projection);
      const legend = map.createLegend();
      const symbol = legend.querySelector(name === 'earthquake'
        ? '.map-legend-icon.earthquake svg' : '.map-legend-icon.high svg');
      expect(symbol).not.toBeNull();
      expect(pictogramGeometry(symbol!)).toBe(domPictogram(map.overlays.querySelector(`.${className}`)!));
    },
  );

  it.each(domDots)('%s replaces the residual ordinary dot with SVG', (_name, className, layers, field, datum) => {
    const map = svgMap(layers);
    map[field] = [datum];
    map.renderOverlays(projection);
    const marker = map.overlays.querySelector(`.${className}`)!;
    expect(marker).not.toBeNull();
    expect(Number.parseFloat(marker.style.left)).toBeCloseTo(projection([12, 34])![0], 5);
    expect(Number.parseFloat(marker.style.top)).toBeCloseTo(projection([12, 34])![1], 5);
    domPictogram(marker);
  });

  it.each(domDots.filter(row => row[5] && row[0] !== 'hotspot'))('%s retains popup source identity and click propagation', (_name, className, layers, field, datum, popupType) => {
    const map = svgMap(layers);
    map[field] = [datum];
    map.renderOverlays(projection);
    const bubbled = vi.fn();
    map.container.addEventListener('click', bubbled);
    map.overlays.querySelector(`.${className}`).dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 100, clientY: 80 }));
    expect(map.popup.show).toHaveBeenCalledWith({ type: popupType, data: datum, x: 100, y: 80 });
    expect(bubbled).not.toHaveBeenCalled();
  });

  it('preserves earthquake magnitude size, radiation severity and fire size/color', () => {
    const map = svgMap({ natural: true, radiationWatch: true, fires: true });
    map.earthquakes = [domDots[2][4]];
    map.radiationObservations = [domDots[3][4]];
    map.firmsFireData = [domDots[4][4]];
    map.renderOverlays(projection);
    expect(map.overlays.querySelector('.earthquake-marker').style.width).toBe('18px');
    expect(map.overlays.querySelector('.radiation-watch-marker').classList.contains('radiation-watch-marker-spike')).toBe(true);
    expect(map.overlays.querySelector('.radiation-watch-marker').style.width).toBe('14px');
    expect(map.overlays.querySelector('.fire-dot').style.width).toBe('10px');
    expect(map.overlays.querySelector('.fire-dot').style.color).toBe('#ff0000');
    expect(map.overlays.querySelector('.fire-dot').style.backgroundColor).toBe('transparent');
  });

  it('gamma irradiators render a pictogram at their catalog location and retain popup identity', () => {
    const map = svgMap({ irradiators: true });
    map.renderOverlays(projection);
    const marker = map.overlays.querySelector('.irradiator-marker')!;
    marker.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const payload = map.popup.show.mock.calls[0][0];
    expect(payload.type).toBe('irradiator');
    expect(Number.parseFloat(marker.style.left)).toBeCloseTo(projection([payload.data.lon, payload.data.lat])![0], 5);
    domPictogram(marker);
  });

  it('cloud provider colored-dot emoji become cloud pictograms without losing provider classes or popup data', () => {
    const map = svgMap({ cloudRegions: true });
    map.renderOverlays(projection);
    for (const provider of ['aws', 'gcp', 'azure', 'cloudflare']) {
      const marker = map.overlays.querySelector(`.cloud-region-marker.${provider}`)!;
      expect(marker).not.toBeNull();
      marker.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const payload = map.popup.show.mock.calls.at(-1)[0];
      expect(payload.type).toBe('cloudRegion');
      expect(payload.data.provider).toBe(provider);
      expect(Number.parseFloat(marker.style.left)).toBeCloseTo(projection([payload.data.lon, payload.data.lat])![0], 5);
      domPictogram(marker);
    }
  });

  it('singleton tech events become calendar pictograms without changing count bubbles or popup routing', () => {
    const map = svgMap({ techEvents: true });
    const event = { id: 'conference', lng: 12, lat: 34, title: 'Fixture conference', location: 'Fixture', country: 'US', daysUntil: 30 };
    map.techEvents = [event, { ...event, id: 'nearby' }];
    map.renderOverlays(projection);
    const cluster = map.overlays.querySelector('.tech-event-marker.cluster')!;
    expect(cluster.querySelector('.cluster-badge').textContent).toBe('2');
    expect(cluster.querySelector('svg')).toBeNull();
    map.techEvents = [event];
    map.renderOverlays(projection);
    const marker = map.overlays.querySelector('.tech-event-marker')!;
    expect(marker.classList.contains('cluster')).toBe(false);
    marker.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 100, clientY: 80 }));
    expect(map.popup.show).toHaveBeenCalledWith({ type: 'techEvent', data: { ...event, lon: 12 }, x: 100, y: 80 });
    domPictogram(marker);
  });

  it('singleton conflict events become pictograms but counted clusters remain bubbles', () => {
    const map = svgMap();
    const event = { id: 'conflict', country: 'Fixture', eventType: 'Battles', fatalities: 1, location: { longitude: 12, latitude: 34 } };
    map.renderConflictEventMarkers(projection, [event, { ...event, id: 'nearby' }]);
    const cluster = map.overlays.querySelector('.conflict-event-marker.cluster')!;
    expect(cluster.querySelector('.conflict-event-count').textContent).toBe('2');
    expect(cluster.querySelector('svg')).toBeNull();
    map.overlays.replaceChildren();
    map.renderConflictEventMarkers(projection, [event]);
    domPictogram(map.overlays.querySelector('.conflict-event-marker')!);
  });

  it('individual webcams become camera pictograms while webcam count bubbles and click routing survive', () => {
    const map = svgMap({ webcams: true });
    const camera = { id: 'camera', lng: 12, lat: 34, title: 'Fixture camera', category: 'traffic' };
    const cluster = { id: 'cluster', lng: 20, lat: 40, count: 4 };
    map.webcamData = [camera, cluster];
    map.showWebcamTooltip = vi.fn();
    map.showWebcamClusterPopup = vi.fn();
    map.renderOverlays(projection);
    const [leaf, bubble] = map.overlays.querySelectorAll('.webcam-dot');
    leaf.dispatchEvent(new MouseEvent('click', { clientX: 100, clientY: 80 }));
    bubble.dispatchEvent(new MouseEvent('click', { clientX: 120, clientY: 90 }));
    expect(map.showWebcamTooltip).toHaveBeenCalledWith(camera, 100, 80);
    expect(map.showWebcamClusterPopup).toHaveBeenCalledWith(cluster, 120, 90);
    expect(bubble.title).toBe('4 webcams');
    expect(bubble.querySelector('svg')).toBeNull();
    expect(leaf.style.width).toBe('6px');
    domPictogram(leaf);
  });

  it('ordinary SVG categories cannot all share a generic pictogram', () => {
    const svgs = domDots.map(([_name, className, layers, field, datum]) => {
      const map = svgMap(layers);
      map[field] = [datum];
      map.renderOverlays(projection);
      return domPictogram(map.overlays.querySelector(`.${className}`)!);
    });
    expect(new Set(svgs).size).toBe(domDots.length);
  });

  it('leaves useful existing financial emoji icons intact', () => {
    const map = svgMap({ stockExchanges: true, financialCenters: true, centralBanks: true, commodityHubs: true });
    map.renderOverlays(projection);
    for (const [selector, icon] of [
      ['.exchange-marker.tier-mega', '🏛️'], ['.financial-center-marker.type-global', '💰'],
      ['.central-bank-marker.type-major', '🏛️'], ['.commodity-hub-marker.type-exchange', '📦'],
    ]) expect(map.overlays.querySelector(selector)?.textContent).toContain(icon);
  });

  it('leaves SVG AIS density sample circles intact', () => {
    const map = svgMap();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    map.dynamicLayerGroup = d3.select(svg);
    map.aisDensity = [{ ...point, intensity: 0.5, deltaPct: 0 }];
    map.renderAisDensity(projection);
    const circle = svg.querySelector('circle.ais-density-spot')!;
    expect(circle.getAttribute('r')).toBe('8');
    expect(Number(circle.getAttribute('cx'))).toBe(projection([12, 34])![0]);
  });
});
