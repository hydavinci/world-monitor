const DATACENTER_GEOMETRY = '<rect x="5" y="3" width="22" height="26" rx="2"/><path d="M5 12h22M5 21h22M9 8h.01M9 17h.01M9 26h.01M15 8h8M15 17h8M15 26h8"/>';

const GEOMETRY = {
  storage: '<rect x="6" y="9" width="20" height="17" rx="2"/><path d="M11 9V6h10v3M16 12l-4 6h5l-2 5 6-8h-5"/>',
  'fuel-shortage': '<path d="M7 27V7h12v20M7 13h12M4 27h18M19 11h3l4 5v8a2 2 0 0 1-4 0v-5M23 6l4 4"/><path d="M11 18h4"/>',
  irradiator: '<rect x="5" y="5" width="22" height="22" rx="3"/><circle cx="16" cy="16" r="2"/><path d="M13 12l-3-5M19 12l3-5M11 17H6M21 17h5M13 20l-3 5M19 20l3 5"/>',
  spaceport: '<path d="M16 4c-5 5-6 10-5 16h10c1-6 0-11-5-16ZM11 14l-5 8h5M21 14l5 8h-5M13 25l3 4 3-4"/><circle cx="16" cy="12" r="2"/>',
  port: '<path d="M16 9v19M9 16h14M5 21c0 5 5 7 11 7s11-2 11-7M5 21l-2 4M27 21l2 4"/><circle cx="16" cy="6" r="3"/>',
  'airport-delay': '<path d="M4 16l9-3V5l3-2 3 2v8l9 3v3l-9-1-3 10-3-10-9 1Z"/><circle cx="24" cy="24" r="6"/><path d="M24 20v4l3 2"/>',
  earthquake: '<path d="M3 20h6l3-12 4 20 4-14 3 6h6M5 6h6M23 27h4"/>',
  volcano: '<path d="M3 28 12 13h8l9 15ZM12 13l4 5 4-5M16 8V3M9 9 6 5M23 9l3-4"/>',
  fire: '<path d="M17 3c2 7-6 9-5 14 0 0-4-2-4-6-7 10-2 18 8 18s15-9 7-19c1 6-3 7-3 7s3-8-3-14Z"/><path d="M16 20c-5 5-2 8 1 8s5-4-1-8Z"/>',
  flood: '<path d="M6 17V9l10-6 10 6v8M13 16v-5h6v5M3 21q3-4 6 0t6 0 6 0 6 0M3 27q3-4 6 0t6 0 6 0 6 0"/>',
  cyclone: '<path d="M28 9C16-4 3 8 8 18c4 8 16 7 18-1M4 23c12 13 25 1 20-9-4-8-16-7-18 1"/><circle cx="16" cy="16" r="4"/>',
  'natural-event': '<path d="M3 27 13 7l7 13 4-7 5 14ZM10 13l3 3 3-3"/><path d="M24 4v4M22 6h4"/>',
  'weather-alert': '<path d="M9 19a6 6 0 1 1 3-11 8 8 0 1 1 11 11M16 17l-7 12h14Z"/><path d="M16 21v3M16 27h.01"/>',
  'road-closure': '<path d="M8 28 11 4M24 28 21 4M16 5v5M16 23v5"/><rect x="4" y="13" width="24" height="7" rx="1"/><path d="m8 20 7-7M18 20l7-7"/>',
  'regional-alert': '<path d="M5 7 12 4l8 4 7-3v20l-7 3-8-4-7 3ZM12 4v10M20 8v6"/><path d="M16 14v6M16 23h.01"/>',
  radiation: '<circle cx="16" cy="16" r="2"/><path d="M13 12 8 4a13 13 0 0 1 16 0l-5 8M21 17h10a14 14 0 0 1-8 13l-5-9M11 17H1a14 14 0 0 0 8 13l5-9"/>',
  'disease-outbreak': '<circle cx="16" cy="16" r="8"/><path d="M16 8V3M16 24v5M8 16H3M24 16h5M10 10 6 6M22 22l4 4M22 10l4-4M10 22l-4 4M13 13h.01M20 15h.01M15 20h.01"/>',
  conflict: '<path d="m6 4 18 18 3-3L9 1ZM26 4 8 22l-3-3L23 1ZM3 22l7 7M22 29l7-7M6 25l-3 4M26 25l3 4"/>',
  strike: '<path d="m21 3 8 8-14 14-8-8ZM21 3l-2 8 10 0M7 17l-4 6 5-1-1 5 8-2M12 27l-3 3M4 18l-3 3"/>',
  protest: '<path d="M4 13h6L26 6v20l-16-7H4ZM10 13v6M9 19l3 10h5l-3-8M26 12h4M26 20h4"/>',
  outage: '<path d="M9 3v8M23 3v8M6 11h20v4a10 10 0 0 1-10 10v5M4 4l24 24"/>',
  'traffic-anomaly': '<path d="M4 7h24M4 16h24M4 25h24M23 3l5 4-5 4M9 12l-5 4 5 4M23 21l5 4-5 4"/><path d="m14 12 4 8M18 12l-4 8"/>',
  ddos: '<rect x="19" y="5" width="10" height="22" rx="2"/><path d="M22 11h4M22 17h4M22 23h4M2 5l12 7M2 16h12M2 27l12-7M10 9l4 3-5 1M10 13l4 3-4 3M9 19l5 1-4 3"/>',
  'cyber-threat': '<path d="m16 3 11 4v9c0 7-11 13-11 13S5 23 5 16V7ZM16 9v9M16 22h.01"/>',
  'threat-actor': '<path d="M4 15 10 5h12l6 10ZM2 15h28M6 20h7l2 4h2l2-4h7M10 28h12"/><path d="M9 20v3M23 20v3"/>',
  vessel: '<path d="M5 17h22l-4 9H9ZM9 17V9h12v8M13 9V5h6v4M2 29q4-4 8 0t8 0 8 0"/>',
  'repair-vessel': '<path d="M4 20h24l-5 7H9ZM9 20v-6h7M3 30h26M18 3a6 6 0 0 0 1 9l-7 7 3 3 7-7a6 6 0 0 0 7-8l-5 5-4-4Z"/>',
  'military-vessel': '<path d="M3 20h26l-6 8H9ZM9 20V12h11v8M13 12V7h5v5M18 7l9-3M3 30h26"/>',
  aircraft: '<path d="M14 3h4l1 10 10 6v3l-10-3-1 7 4 3v1H10v-1l4-3-1-7-10 3v-3l10-6Z"/>',
  'military-aircraft': '<path d="M16 2 19 14l10 10-1 3-9-5-1 7h-4l-1-7-9 5-1-3 10-10Z"/><path d="M9 19v7M23 19v7"/>',
  'ais-disruption': '<path d="M10 24h12M16 20v4M12 13a6 6 0 0 1 8 0M8 9a12 12 0 0 1 16 0M4 5a18 18 0 0 1 24 0M4 4l24 24"/><circle cx="16" cy="17" r="2"/>',
  'cable-fault': '<path d="M3 7v7a5 5 0 0 0 5 5h4M29 25v-7a5 5 0 0 0-5-5h-4M12 15v8M20 9v8M15 8l3-5M15 29l3-5"/>',
  waterway: '<path d="M4 3v26M28 3v26M10 8q3-4 6 0t6 0M10 16q3-4 6 0t6 0M10 24q3-4 6 0t6 0"/>',
  'stock-exchange': '<rect x="4" y="5" width="24" height="21" rx="2"/><path d="M8 21l5-7 5 3 6-8M20 9h4v4M10 30h12M16 26v4"/>',
  'financial-center': '<path d="M3 29h26M5 29V13h8v16M13 29V4h9v25M22 29V17h5v12M8 17h2M8 22h2M16 8h3M16 13h3M16 18h3M16 23h3"/>',
  'central-bank': '<path d="m3 11 13-8 13 8ZM5 29h22M5 25h22M8 14v11M16 14v11M24 14v11"/><circle cx="16" cy="8" r="1"/>',
  'commodity-hub': '<path d="m4 10 12-6 12 6v15l-12 6-12-6ZM4 10l12 6 12-6M16 16v15M10 7l12 6"/>',
  mineral: '<path d="m16 3 12 12-12 14L4 15ZM4 15h24M16 3l-5 12 5 14 5-14Z"/>',
  mine: '<path d="M5 12c5-8 14-8 22 0M16 7l8 21M4 28h14M6 28l5-14 5 14"/><path d="m4 17 7-3 7 3"/>',
  'processing-plant': '<path d="M4 28V15l8 5v-9l8 6V6h6v22ZM3 28h26M8 24h3M16 24h3M23 24h1"/>',
  'commodity-port': '<path d="M4 28h24M8 28V6h18M8 6l8 8h10M24 6v8M24 14v6M20 20h8v7h-8M3 20h13v7H3"/>',
  investment: '<path d="M4 27h24M7 23v-7M14 23V11M21 23V5M4 11l7-6 6 2 9-5M22 2h4v4"/>',
  startup: '<path d="M16 3c-5 5-6 10-5 16h10c1-6 0-11-5-16ZM11 13l-5 8h5M21 13l5 8h-5M12 25l4 4 4-4"/><path d="m14 12 2-3 2 3-2 3Z"/>',
  accelerator: '<path d="m17 2-9 16h8l-1 12 10-18h-8ZM3 10h5M2 16h4M3 22h5"/>',
  'cloud-region': '<path d="M9 23a7 7 0 1 1 3-13 9 9 0 1 1 11 13ZM11 27v3M16 27v3M21 27v3"/>',
  'tech-hq': '<path d="M7 28V5h18v23M3 28h26M11 9h3M18 9h3M11 14h3M18 14h3M11 19h3M18 19h3M14 28v-4h4v4"/>',
  datacenter: DATACENTER_GEOMETRY,
  calendar: '<rect x="4" y="7" width="24" height="22" rx="2"/><path d="M10 3v8M22 3v8M4 15h24M10 20h4M18 20h4M10 25h4"/>',
  news: '<path d="M7 5h22v22H7a4 4 0 0 1-4-4V10h4ZM7 10v13M11 10h14M11 15h5v6h-5M20 15h5M20 20h5M11 25h14"/>',
  kindness: '<path d="M16 27 5 16C-2 7 10 0 16 9c6-9 18-2 11 7ZM10 17h12M16 11v12"/>',
  wildlife: '<ellipse cx="16" cy="23" rx="8" ry="6"/><ellipse cx="6" cy="14" rx="3" ry="4"/><ellipse cx="13" cy="7" rx="3" ry="4"/><ellipse cx="21" cy="7" rx="3" ry="4"/><ellipse cx="28" cy="14" rx="3" ry="4"/>',
  'science-health': '<path d="M12 3h8M14 3v9L6 25a2 2 0 0 0 2 4h16a2 2 0 0 0 2-4l-8-13V3M10 21h12M16 17v8M12 21h8"/>',
  innovation: '<path d="M11 23c0-4-5-5-5-11a10 10 0 0 1 20 0c0 6-5 7-5 11ZM11 27h10M13 31h6M16 9v10M12 13h8"/>',
  climate: '<path d="M16 29V16M16 23C4 24 3 14 4 7c9-1 14 3 12 16ZM16 18C28 19 29 9 28 3c-9-1-14 3-12 15Z"/>',
  community: '<circle cx="16" cy="8" r="4"/><circle cx="6" cy="12" r="3"/><circle cx="26" cy="12" r="3"/><path d="M9 29v-7a7 7 0 0 1 14 0v7M2 26v-6a4 4 0 0 1 5-4M30 26v-6a4 4 0 0 0-5-4"/>',
  'species-recovery': '<path d="M16 29V17M16 21C6 22 5 14 6 9c7-1 11 3 10 12ZM16 17C26 18 27 10 26 5c-7-1-11 3-10 12ZM3 6V2h5M3 2l5 5"/>',
  solar: '<path d="M4 17h24l-3 12H7ZM12 17l-1 12M20 17l1 12M5 23h22M16 1v3M5 5l2 2M27 5l-2 2"/><circle cx="16" cy="10" r="4"/>',
  wind: '<path d="M16 14v16M16 14 13 3h6ZM16 14l-11 8-3-5ZM16 14l13 3-3 5Z"/><circle cx="16" cy="14" r="2"/>',
  hydro: '<path d="M16 3C13 9 6 14 6 20a10 10 0 0 0 20 0c0-6-7-11-10-17ZM10 22q3-3 6 0t6 0"/>',
  geothermal: '<path d="M3 28h26M5 23l6-8 5 8 5-8 6 8M9 12c-5-4 5-6 0-10M16 12c-5-4 5-6 0-10M23 12c-5-4 5-6 0-10"/>',
  camera: '<path d="M4 10h6l3-5h6l3 5h6v17H4Z"/><circle cx="16" cy="18" r="6"/><path d="M24 13h.01"/>',
  'transport-node': '<path d="M6 28V5h20v23M6 17h20M10 28l-3 3M22 28l3 3M12 5v12M20 5v12"/><circle cx="11" cy="23" r="1"/><circle cx="21" cy="23" r="1"/>',
  satellite: '<path d="m12 10 10 10-4 4L8 14ZM11 11 5 5 1 9l6 6M19 19l6 6 4-4-6-6M17 9l6-6M20 3h3v3M11 24a5 5 0 0 1-5-5M12 29A11 11 0 0 1 1 18"/>',
  'military-base': '<polygon points="16,2 30,28 2,28" fill="currentColor" stroke="none"/>',
  'nuclear-site': '<circle cx="16" cy="16" r="2.5" fill="currentColor" stroke="none"/><path d="M11.5 16H2A14 14 0 0 1 9 3.876L13.75 12.103A4.5 4.5 0 0 0 11.5 16Z" fill="currentColor" stroke="none"/><path d="M18.25 12.103 23 3.876A14 14 0 0 1 30 16H20.5A4.5 4.5 0 0 0 18.25 12.103Z" fill="currentColor" stroke="none"/><path d="M18.25 19.897 23 28.124A14 14 0 0 1 9 28.124L13.75 19.897A4.5 4.5 0 0 0 18.25 19.897Z" fill="currentColor" stroke="none"/>',
  'datacenter-site': DATACENTER_GEOMETRY,
  'aircraft-position': '<path d="M16 2 L17.5 10 L17 12 L27 17 L27 19 L17 16 L17 24 L20 26.5 L20 28 L16 27 L12 28 L12 26.5 L15 24 L15 16 L5 19 L5 17 L15 12 L14.5 10 Z" fill="currentColor" stroke="none"/>',
  'hotspot-diamond': '<polygon points="16,0 32,16 16,32 0,16" fill="currentColor" stroke="none"/>',
} as const;

export type MapMarkerIconKind = keyof typeof GEOMETRY;

interface MarkerIconCell {
  x: number;
  y: number;
  width: 32;
  height: 32;
  mask: true;
  anchorX: 16;
  anchorY: 16;
}

const kinds = Object.keys(GEOMETRY) as MapMarkerIconKind[];
const columns = 8;
const rows = Math.ceil(kinds.length / columns);
const svgAttributes = 'fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"';
const toDataUrl = (svg: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

export const MAP_MARKER_ICON_MAPPING = Object.fromEntries(kinds.map((kind, index) => [
  kind,
  {
    x: index % columns * 32,
    y: Math.floor(index / columns) * 32,
    width: 32,
    height: 32,
    mask: true,
    anchorX: 16,
    anchorY: 16,
  },
])) as Record<MapMarkerIconKind, MarkerIconCell>;

export const MAP_MARKER_ICON_ATLAS = toDataUrl(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${columns * 32}" height="${rows * 32}" ${svgAttributes} color="white">`
  + kinds.map(kind => {
    const cell = MAP_MARKER_ICON_MAPPING[kind];
    return `<g transform="translate(${cell.x} ${cell.y})">${GEOMETRY[kind]}</g>`;
  }).join('')
  + '</svg>',
);

export function getMapMarkerSvg(kind: MapMarkerIconKind): string {
  if (!Object.prototype.hasOwnProperty.call(GEOMETRY, kind)) throw new Error(`Unknown map marker icon: ${kind}`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" ${svgAttributes} aria-hidden="true" focusable="false">${GEOMETRY[kind]}</svg>`;
}

const dataUrls = new Map<MapMarkerIconKind, string>();

export function getMapMarkerDataUrl(kind: MapMarkerIconKind): string {
  let url = dataUrls.get(kind);
  if (!url) {
    url = toDataUrl(getMapMarkerSvg(kind));
    dataUrls.set(kind, url);
  }
  return url;
}

export function getMapMarkerIcon(kind: MapMarkerIconKind) {
  return {
    url: getMapMarkerDataUrl(kind),
    width: 32,
    height: 32,
    mask: true,
    anchorX: 16,
    anchorY: 16,
  } as const;
}
