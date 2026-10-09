import { describe, expect, it } from 'vitest';
import {
  MAP_MARKER_ICON_ATLAS,
  MAP_MARKER_ICON_MAPPING,
  getMapMarkerDataUrl,
  getMapMarkerIcon,
  getMapMarkerSvg,
  type MapMarkerIconKind,
} from '../../src/config/map-marker-icons';

function parseSvg(source: string): Element {
  const document = new DOMParser().parseFromString(source, 'image/svg+xml');
  expect(document.querySelector('parsererror')).toBeNull();
  const svg = document.documentElement;
  expect(svg.localName).toBe('svg');
  return svg;
}

describe('local map marker SVG registry', () => {
  it('provides real self-contained geometry for every atlas cell', () => {
    const atlas = parseSvg(decodeURIComponent(MAP_MARKER_ICON_ATLAS.split(',')[1]!));
    const cells = new Set<string>();
    for (const [name, mapping] of Object.entries(MAP_MARKER_ICON_MAPPING)) {
      const kind = name as MapMarkerIconKind;
      const icon = parseSvg(getMapMarkerSvg(kind));
      expect(icon.querySelector('path,rect,polygon,polyline,line,circle,ellipse')).not.toBeNull();
      expect(icon.querySelector('image,script,foreignObject,use')).toBeNull();
      expect(icon.getAttribute('stroke')).toBe('currentColor');
      expect(mapping.x + mapping.width).toBeLessThanOrEqual(Number(atlas.getAttribute('width')));
      expect(mapping.y + mapping.height).toBeLessThanOrEqual(Number(atlas.getAttribute('height')));
      const cell = `${mapping.x},${mapping.y}`;
      expect(cells.has(cell)).toBe(false);
      cells.add(cell);
      expect(getMapMarkerIcon(kind).mask).toBe(true);
      expect(parseSvg(decodeURIComponent(getMapMarkerDataUrl(kind).split(',')[1]!)).innerHTML)
        .toBe(icon.innerHTML);
    }
    expect(atlas.querySelectorAll('g').length).toBe(cells.size);
  });

  it('distinguishes financial and hazard categories by geometry, not tint', () => {
    for (const keys of [
      ['stock-exchange', 'financial-center', 'central-bank'],
      ['earthquake', 'fire', 'flood', 'cyclone'],
    ] satisfies MapMarkerIconKind[][]) {
      const shapes = keys.map(key => parseSvg(getMapMarkerSvg(key)).innerHTML);
      expect(new Set(shapes).size).toBe(keys.length);
    }
  });

  it('identifies nuclear sites with a central nucleus and three trefoil blades, not a hexagon', () => {
    const icon = parseSvg(getMapMarkerSvg('nuclear-site'));
    const nucleus = icon.querySelector('circle');
    expect(nucleus).not.toBeNull();
    expect(nucleus!.getAttribute('cx')).toBe('16');
    expect(nucleus!.getAttribute('cy')).toBe('16');
    expect(icon.querySelectorAll('path')).toHaveLength(3);
    expect(icon.querySelector('polygon')).toBeNull();
  });

  it('rejects unknown categories instead of producing a broken SVG', () => {
    expect(() => Reflect.apply(getMapMarkerSvg, undefined, ['not-a-marker']))
      .toThrow(/Unknown map marker icon/);
  });

  it('identifies datacenters as outlined server racks rather than solid blocks', () => {
    const icon = parseSvg(getMapMarkerSvg('datacenter-site'));
    expect(icon.querySelector('rect')).not.toBeNull();
    expect(icon.querySelector('path')).not.toBeNull();
    expect(icon.querySelector('[fill="currentColor"]')).toBeNull();
    expect(icon.getAttribute('fill')).toBe('none');
  });
});
