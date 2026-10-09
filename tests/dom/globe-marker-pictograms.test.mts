import { afterEach, describe, expect, it, vi } from 'vitest';

import { GlobeMap } from '@/components/GlobeMap';
import { resolvePerformanceProfile, type GlobePerformanceProfile } from '@/services/globe-render-settings';

type Marker = { _kind: string; _lat: number; _lng: number; [key: string]: unknown };
type MarkerHost = {
  container: HTMLElement;
  tooltipEl: HTMLElement | null;
  tooltipHideTimer: ReturnType<typeof setTimeout> | null;
  onNewsClick?: (marker: unknown) => void;
  buildMarkerElement: (marker: Marker) => HTMLElement;
  applyPerformanceProfile: (profile: GlobePerformanceProfile) => void;
};

const fixtures = [
  {
    marker: { _kind: 'conflict', _lat: 15.5, _lng: 32.6, id: 'conflict-khartoum', fatalities: 5, eventType: 'Battle', location: 'Khartoum' },
    title: 'Khartoum', tooltip: 'Casualties: 5', hit: 20, head: 8, color: 'rgba(255, 50, 50, 0.85)', pulse: true, icon: 'conflict',
  },
  {
    marker: { _kind: 'iran', _lat: 35.7, _lng: 51.4, id: 'iran-tehran', title: 'Airstrike near Tehran', category: 'airstrike', severity: 'high', location: 'Tehran' },
    title: 'Airstrike near Tehran', tooltip: 'airstrike', hit: 20, head: 9, color: '#ff3030', pulse: true, icon: 'strike',
  },
  {
    marker: { _kind: 'ucdp', _lat: 13.6, _lng: 25.3, id: 'ucdp-darfur', sideA: 'Sudan forces', sideB: 'RSF', deaths: 10, country: 'Sudan' },
    title: 'Sudan forces vs RSF', tooltip: 'Deaths: 10', hit: 20, head: 8, color: 'rgba(255, 100, 0, 0.85)', pulse: false, icon: 'conflict',
  },
  {
    marker: { _kind: 'earthquake', _lat: 38.1, _lng: 37.2, id: 'quake-turkey', place: 'Southern Turkey', magnitude: 6.4 },
    title: 'M6.4 — Southern Turkey', tooltip: 'Southern Turkey', hit: 20, head: 16, color: '#ff2020', pulse: false, icon: 'earthquake',
  },
  {
    marker: { _kind: 'newsLocation', _lat: 50.4, _lng: 30.5, id: 'news-kyiv', title: 'Kyiv infrastructure damaged', threatLevel: 'high' },
    title: 'Kyiv infrastructure damaged', tooltip: 'high', hit: 16, head: 16, color: '#ff6600', pulse: true, icon: 'news',
  },
  {
    marker: { _kind: 'satellite', _lat: 40.1, _lng: 116.4, id: '39150', name: 'GAOFEN-1', country: 'CN', type: 'optical', alt: 645, velocity: 7.5, inclination: 98.1 },
    title: 'GAOFEN-1', tooltip: 'NORAD 39150', hit: 16, head: 5, color: '#ff2020', pulse: false, icon: 'satellite',
  },
] satisfies Array<{
  marker: Marker; title: string; tooltip: string; hit: number; head: number; color: string; pulse: boolean; icon: string;
}>;

function createHost(eco = false): MarkerHost {
  // Use the real builder/click/tooltip methods without creating a WebGL renderer.
  const host = Object.assign(Object.create(GlobeMap.prototype), {
    container: document.createElement('div'),
    popup: null,
    globe: null,
    initialized: true,
    destroyed: false,
    webglLost: false,
    _pulseEnabled: true,
    tooltipEl: null,
    tooltipHideTimer: null,
  }) as MarkerHost;
  document.body.appendChild(host.container);
  if (eco) {
    Object.assign(host, {
      // Only the GPU operations and queued rebuild are replaced.
      globe: { arcDashAnimateTime() {}, pathDashAnimateTime() {}, atmosphereAltitude() {} },
      flushMarkers() {},
    });
    host.applyPerformanceProfile(resolvePerformanceProfile('1'));
  }
  return host;
}

function expectPictogram(element: HTMLElement, kind: string, icon: string): void {
  const svg = element.querySelector('svg');
  expect(svg, `${kind} must render a built-in SVG pictogram, not a round head`).not.toBeNull();
  expect(svg!.querySelector('path[d], polygon[points], polyline[points], line, rect'),
    `${kind} must contain pictogram geometry, not only an SVG circle`).not.toBeNull();
  expect(svg!.querySelector('image, use')).toBeNull();
  expect(svg!.dataset.globeIcon).toBe(icon);
  expect(svg!.style.width).toBe('100%');
  expect(svg!.style.height).toBe('100%');
  expect(svg!.style.display).toBe('block');
  expect(svg!.closest('[style*="animation"]')).toBeNull();
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe.each([
  { mode: 'normal effects', eco: false },
  { mode: 'eco / pulse-disabled effects', eco: true },
])('Globe ordinary dot pictograms ($mode)', ({ eco }) => {
  it.each(fixtures)('replaces the $marker._kind round head with SVG', ({ marker, icon }) => {
    const host = createHost(eco);
    expectPictogram(host.buildMarkerElement(marker), marker._kind, icon);
  });

  it.each(fixtures)('preserves $marker._kind hit area, size, color, title and pulse policy', (fixture) => {
    const host = createHost(eco);
    const element = host.buildMarkerElement(fixture.marker);
    expect(element.style.pointerEvents).toBe('auto');
    expect(element.style.cursor).toBe('pointer');
    expect(element.style.userSelect).toBe('none');
    expect(element.title).toBe(fixture.title);
    const hit = element.firstElementChild as HTMLElement;
    expect(hit.style.width).toBe(`${fixture.hit}px`);
    expect(hit.style.height).toBe(`${fixture.hit}px`);
    const descendants = Array.from(element.querySelectorAll<HTMLElement>('*'));
    expect(descendants.some(node => node.style.width === `${fixture.head}px`
      && node.style.height === `${fixture.head}px`)).toBe(true);
    expect(descendants.some(node => [node.style.backgroundColor, node.style.borderColor, node.style.color]
      .includes(fixture.color))).toBe(true);
    const pulsing = descendants.filter(node => node.style.animation.includes('globe-pulse'));
    expect(pulsing.length > 0).toBe(fixture.pulse && !eco);
    if (fixture.marker._kind === 'satellite') {
      expect(element.querySelector('.sat-hit')).toBe(hit);
      expect(hit.style.margin).toBe('-8px 0px 0px -8px');
    }
  });
});

describe('Globe ordinary marker interactions', () => {
  it.each(fixtures)('keeps real $marker._kind click and tooltip hover behavior', ({ marker, tooltip }) => {
    vi.useFakeTimers();
    const host = createHost();
    const element = host.buildMarkerElement(marker);
    host.container.appendChild(element);
    const bubbledClick = vi.fn();
    host.container.addEventListener('click', bubbledClick);
    // Click the rendered head, not the outer handler directly.
    element.firstElementChild!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(bubbledClick).not.toHaveBeenCalled();
    const popup = host.tooltipEl!;
    expect(popup).toBeInstanceOf(HTMLElement);
    expect(popup.textContent).toContain(tooltip);
    popup.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(6_001);
    expect(popup.isConnected).toBe(true);
    popup.dispatchEvent(new MouseEvent('mouseleave'));
    vi.advanceTimersByTime(1_999);
    expect(popup.isConnected).toBe(true);
    vi.advanceTimersByTime(1);
    expect(popup.isConnected).toBe(false);
  });

  it('delivers the news marker and coordinates to the existing news click callback', () => {
    vi.useFakeTimers();
    const host = createHost();
    const onNewsClick = vi.fn();
    host.onNewsClick = onNewsClick;
    const marker = fixtures[4]!.marker;
    const element = host.buildMarkerElement(marker);
    host.container.appendChild(element);
    element.firstElementChild!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onNewsClick).toHaveBeenCalledExactlyOnceWith(marker);
    expect(host.tooltipEl?.textContent).toContain('Kyiv infrastructure damaged');
  });
});

it.each([
  { marker: { ...fixtures[0]!.marker, fatalities: 100 }, size: 12 },
  { marker: { ...fixtures[2]!.marker, deaths: 100 }, size: 10 },
  { marker: { ...fixtures[3]!.marker, magnitude: 2.5 }, size: 8 },
  { marker: { ...fixtures[3]!.marker, magnitude: 9 }, size: 18 },
])('retains severity-driven $marker._kind size limits ($size px)', ({ marker, size }) => {
  const element = createHost().buildMarkerElement(marker);
  expect(Array.from(element.querySelectorAll<HTMLElement>('*')).some(node =>
    node.style.width === `${size}px` && node.style.height === `${size}px`)).toBe(true);
});

it.each([
  { marker: { ...fixtures[1]!.marker, severity: 'elevated' }, color: '#ff8800' },
  { marker: { ...fixtures[1]!.marker, severity: 'moderate' }, color: '#ffcc00' },
  { marker: { ...fixtures[3]!.marker, magnitude: 4.5 }, color: '#ff8800' },
  { marker: { ...fixtures[3]!.marker, magnitude: 2.5 }, color: '#ffcc00' },
  { marker: { ...fixtures[4]!.marker, threatLevel: 'critical' }, color: '#ff2020' },
  { marker: { ...fixtures[4]!.marker, threatLevel: 'medium' }, color: '#ffaa00' },
  { marker: { ...fixtures[4]!.marker, threatLevel: 'info' }, color: '#44aaff' },
  { marker: { ...fixtures[5]!.marker, country: 'US' }, color: '#4488ff' },
  { marker: { ...fixtures[5]!.marker, country: 'OTHER' }, color: '#ccccff' },
])('retains $marker._kind severity/operator coding ($color)', ({ marker, color }) => {
  const element = createHost().buildMarkerElement(marker);
  expect(Array.from(element.querySelectorAll<HTMLElement>('*')).some(node =>
    [node.style.backgroundColor, node.style.borderColor, node.style.color].includes(color))).toBe(true);
});

it('leaves aggregate counts and non-interactive footprint/navigation rings untouched', () => {
  const host = createHost();
  for (const marker of [
    { _kind: 'cluster', _lat: 25, _lng: 55, id: 'fleet', name: 'Fleet', vesselCount: 7, activityType: 'unknown' },
    { _kind: 'webcam-cluster', _lat: 48, _lng: 2, count: 12, categories: ['city'] },
  ]) {
    const element = host.buildMarkerElement(marker);
    expect(element.textContent).toBe(marker._kind === 'cluster' ? '7' : '12');
    expect(element.querySelector('svg')).toBeNull();
  }
  for (const marker of [
    { _kind: 'satFootprint', _lat: 40, _lng: 116, country: 'CN', noradId: '39150' },
    { _kind: 'flash', _lat: 50, _lng: 30, id: 'navigation-flash' },
  ]) {
    const element = host.buildMarkerElement(marker);
    expect(element.style.pointerEvents).toBe('none');
    expect(element.querySelector('svg')).toBeNull();
    expect(Array.from(element.querySelectorAll<HTMLElement>('*')).some(node =>
      node.style.borderRadius === '50%')).toBe(true);
  }
});

it.each([
  { marker: { _kind: 'flight', _lat: 40, _lng: 30, id: 'flight-1', callsign: 'FORTE11', type: 'reconnaissance', heading: 90 }, icon: '✈' },
  { marker: { _kind: 'vessel', _lat: 25, _lng: 55, id: 'vessel-1', name: 'Patrol ship', type: 'unknown', typeLabel: 'Unknown', isDark: true, usniSource: true }, icon: '⛴' },
  { marker: { _kind: 'webcam', _lat: 48, _lng: 2, webcamId: 'paris-camera', title: 'Paris camera', category: 'city', country: 'FR' }, icon: '📷' },
  { marker: { _kind: 'conflictZone', _lat: 48, _lng: 35, id: 'ukraine', name: 'Ukraine', intensity: 'high', parties: ['Ukraine', 'Russia'], center: [35, 48] }, icon: '⚔' },
  { marker: { _kind: 'notamRing', _lat: 30, _lng: 51, name: 'Closed airspace', reason: 'NOTAM closure' }, icon: '⚠' },
])('preserves the existing meaningful $marker._kind icon and status decoration', ({ marker, icon }) => {
  const element = createHost().buildMarkerElement(marker);
  expect(element.textContent?.trim()).toBe(icon);
  if (marker._kind === 'flight') {
    expect(element.firstElementChild?.firstElementChild?.getAttribute('style')).toContain('rotate(90deg)');
  }
  if (['vessel', 'conflictZone', 'notamRing'].includes(marker._kind)) {
    expect(Array.from(element.querySelectorAll<HTMLElement>('*')).some(node =>
      node.style.borderRadius === '50%')).toBe(true);
  }
});
