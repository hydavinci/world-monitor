import { expect, test, type Page } from '@playwright/test';
import { getMapMarkerSvg, type MapMarkerIconKind } from '../src/config/map-marker-icons';

interface MarkerLayerProbe {
  kind: string;
  loaded: boolean;
  atlas: string | null;
  samples: Array<{ lon: number; lat: number; city: string | null; count: number | null }>;
}

declare global {
  interface Window {
    __markerLayerProbe?: {
      info(id: string): MarkerLayerProbe | null;
      project(position: [number, number]): { x: number; y: number };
      settled(): boolean;
      geometry(id: string): string;
    };
  }
}

async function installRendererProbes(page: Page): Promise<void> {
  await page.route('**/src/components/DeckGLMap.ts*', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: `${await response.text()}
const originalMarkerLayerBuilder = DeckGLMap.prototype.buildLayers;
if (typeof originalMarkerLayerBuilder !== 'function') throw new Error('Marker probe: real layer builder missing');
DeckGLMap.prototype.buildLayers = function(...args) {
  const layers = originalMarkerLayerBuilder.apply(this, args);
  const map = this;
  const records = new Map(layers.map(layer => [layer.id, {
    layer,
    atlas: (() => {
      const original = Object.getOwnPropertySymbols(layer.props).find(symbol => symbol.description === 'asyncPropOriginal');
      return (original && layer.props[original].iconAtlas)
        ?? (typeof layer.props.iconAtlas === 'string' ? layer.props.iconAtlas : layer.props.iconAtlas?.src ?? null);
    })()
  }]));
  window.__markerLayerProbe = {
    geometry(id) {
      const record = records.get(id);
      if (!record || !record.atlas) throw new Error('Marker probe: atlas missing');
      const data = record.layer.props.data;
      const getIcon = record.layer.props.getIcon;
      const kind = typeof getIcon === 'function' ? getIcon(data[0]) : getIcon;
      const mapping = record.layer.props.iconMapping[kind];
      const payload = record.atlas.slice(record.atlas.indexOf(',') + 1);
      const source = record.atlas.slice(0, record.atlas.indexOf(',')).includes(';base64')
        ? atob(payload) : decodeURIComponent(payload);
      const atlas = new DOMParser().parseFromString(source, 'image/svg+xml');
      const cell = Array.from(atlas.querySelectorAll('g')).find(node =>
        node.getAttribute('transform') === 'translate(' + mapping.x + ' ' + mapping.y + ')')
        ?? (mapping.x === 0 && mapping.y === 0 ? atlas.documentElement : null);
      if (!cell) throw new Error('Marker probe: actual atlas cell missing');
      return Array.from(cell.children).map(shape => new XMLSerializer().serializeToString(shape)).join('');
    },
    settled() {
      if (!map.maplibreMap) throw new Error('Marker probe: real map missing');
      return !map.maplibreMap.isMoving();
    },
    info(id) {
      const record = records.get(id);
      if (!record) return null;
      const {layer, atlas} = record;
      return {
        kind: layer.constructor.layerName,
        loaded: Boolean(layer.state && layer.isLoaded),
        atlas,
        samples: Array.isArray(layer.props.data)
          ? layer.props.data.map(item => ({lon: item.lon, lat: item.lat, city: item.city ?? null, count: item.count ?? null}))
          : []
      };
    },
    project(position) {
      if (!map.maplibreMap) throw new Error('Marker probe: real map missing');
      const point = map.maplibreMap.project(position);
      const bounds = map.maplibreMap.getContainer().getBoundingClientRect();
      return {x: point.x + bounds.left, y: point.y + bounds.top};
    }
  };
  return layers;
};
`,
    });
  });
  await page.route('**/src/components/GlobeMap.ts*', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: `${await response.text()}
const originalMarkerElementBuilder = GlobeMap.prototype.buildMarkerElement;
if (typeof originalMarkerElementBuilder !== 'function') throw new Error('Marker probe: real globe builder missing');
GlobeMap.prototype.buildMarkerElement = function(marker) {
  const element = originalMarkerElementBuilder.call(this, marker);
  element.dataset.markerProbeKind = marker._kind;
  return element;
};
`,
    });
  });
}

async function enableLayer(page: Page, key: string): Promise<void> {
  const checkbox = page.locator(`.layer-toggle[data-layer="${key}"] input`);
  await expect(checkbox).toBeVisible();
  await checkbox.check();
  await expect(checkbox).toBeChecked();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('marker-pictogram-initialized') === '1') return;
    sessionStorage.setItem('marker-pictogram-initialized', '1');
    localStorage.clear();
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
    localStorage.setItem('worldmonitor-theme', 'light');
  });
  await installRendererProbes(page);
});

test('2D military bases, nuclear sites and datacenters match their real rendered symbols', async ({ page }, testInfo) => {
  await page.goto('/dashboard?lat=35&lon=-79&zoom=6&layers=bases,nuclear,datacenters');
  await expect(page.locator('#mapContainer')).toHaveClass(/deckgl-mode/, { timeout: 30_000 });
  for (const [key, id] of [
    ['bases', 'bases-layer'],
    ['nuclear', 'nuclear-layer'],
    ['datacenters', 'datacenters-layer'],
  ]) {
    const icon = page.locator(`.layer-toggle[data-layer="${key}"] .toggle-icon svg`);
    await expect(icon).toBeVisible();
    await expect.poll(() => page.evaluate(layerId => window.__markerLayerProbe?.info(layerId!)?.kind, id))
      .toBe('IconLayer');
    const geometry = await page.evaluate(layerId => window.__markerLayerProbe!.geometry(layerId!), id);
    expect(await icon.evaluate(svg => Array.from(svg.children)
      .map(shape => new XMLSerializer().serializeToString(shape)).join(''))).toBe(geometry);
    expect(await page.locator(`.legend-item[data-layer="${key}"] svg`).evaluate(svg => Array.from(svg.children)
      .map(shape => new XMLSerializer().serializeToString(shape)).join(''))).toBe(geometry);
  }
  const samples = await page.evaluate(async () => {
    const atlas = window.__markerLayerProbe?.info('nuclear-layer')?.atlas;
    if (!atlas) throw new Error('Nuclear marker atlas missing');
    const image = new Image();
    image.src = atlas;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 32;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Nuclear atlas raster context missing');
    context.drawImage(image, 0, 0, 32, 32);
    const alpha = (x: number, y: number) => context.getImageData(x, y, 1, 1).data[3];
    return {
      filled: [[16, 16], [8, 10], [24, 10], [16, 26]].map(([x, y]) => alpha(x!, y!)),
      gaps: [[16, 6], [7, 22], [25, 22]].map(([x, y]) => alpha(x!, y!)),
    };
  });
  for (const alpha of samples.filled) expect(alpha).toBeGreaterThan(200);
  for (const alpha of samples.gaps) expect(alpha).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('nuclear-site-trefoil.png') });
});

test('military base menu and legend stay unified across light and dark themes', async ({ page }, testInfo) => {
  await page.goto('/dashboard?lat=26&lon=24&zoom=3&layers=bases');
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') {
      await page.evaluate(() => localStorage.setItem('worldmonitor-theme', 'dark'));
      await page.reload();
    }
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.locator('#mapContainer')).toHaveClass(/deckgl-mode/, { timeout: 30_000 });
    await expect.poll(() => page.evaluate(() => window.__markerLayerProbe?.info('bases-layer')?.loaded),
      { timeout: 30_000 }).toBe(true);
    const menu = page.locator('.layer-toggle[data-layer="bases"]');
    const legend = page.locator('.legend-item[data-layer="bases"]');
    await expect.soft(menu.locator('.toggle-label')).toHaveText('Military Bases');
    await expect.soft(legend.locator('.legend-label')).toHaveText('Military Bases');
    for (const icon of [menu.locator('svg'), legend.locator('svg')]) {
      await expect.soft(icon).toHaveCSS('color', 'rgb(68, 136, 255)');
      await expect.soft(icon).toHaveCSS('width', '16px');
      await expect.soft(icon).toHaveCSS('height', '16px');
    }
    await menu.locator('input').uncheck();
    await expect(legend).toBeHidden();
    await menu.locator('input').check();
    await expect(legend).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`military-base-unified-${theme}.png`) });
  }
});

test('datacenter clusters show server racks without map count labels and retain their popup', async ({ page }, testInfo) => {
  await page.goto('/dashboard?lat=35&lon=-98&zoom=3&layers=datacenters');
  await expect(page.locator('#mapContainer')).toHaveClass(/deckgl-mode/, { timeout: 30_000 });
  const menu = page.locator('.layer-toggle[data-layer="datacenters"]');
  const legend = page.locator('.legend-item[data-layer="datacenters"]');
  await menu.scrollIntoViewIfNeeded();
  await expect(menu.locator('svg')).toBeVisible();
  await expect(menu.locator('.toggle-label')).toHaveText('AI Data Centers');
  await expect(legend.locator('.legend-label')).toHaveText('AI Data Centers');
  for (const icon of [menu.locator('svg'), legend.locator('svg')]) {
    await expect(icon).toHaveCSS('color', 'rgb(136, 68, 255)');
    await expect(icon).toHaveCSS('width', '16px');
    await expect(icon).toHaveCSS('height', '16px');
  }
  await expect.poll(() => page.evaluate(() => window.__markerLayerProbe?.info('datacenter-clusters-layer')?.kind))
    .toBe('IconLayer');
  await expect.poll(() => page.evaluate(() => window.__markerLayerProbe?.info('datacenter-clusters-layer')?.loaded),
    { timeout: 30_000 }).toBe(true);
  expect(await page.evaluate(() => window.__markerLayerProbe?.info('datacenter-clusters-badge'))).toBeNull();
  const geometry = await page.evaluate(() => window.__markerLayerProbe!.geometry('datacenter-clusters-layer'));
  for (const icon of [menu.locator('svg'), legend.locator('svg')]) {
    expect(await icon.evaluate(svg => Array.from(svg.children)
      .map(shape => new XMLSerializer().serializeToString(shape)).join(''))).toBe(geometry);
  }
  await expect.poll(() => page.evaluate(() => window.__markerLayerProbe?.settled())).toBe(true);
  const point = await page.evaluate(() => {
    const probe = window.__markerLayerProbe;
    const group = probe?.info('datacenter-clusters-layer')?.samples
      .filter(sample => (sample.count ?? 0) > 1 && sample.lon > -125 && sample.lon < -65)
      .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))[0];
    if (!probe || !group) throw new Error('Real US datacenter aggregate missing');
    return probe.project([group.lon, group.lat]);
  });
  await expect(menu.locator('svg path')).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('datacenter-unified-server-racks.png') });
  await page.mouse.click(point.x, point.y);
  await expect(page.locator('.map-popup .popup-header.datacenter.cluster')).toBeVisible();
});

test('large datacenter aggregates stay within 12 screen pixels instead of growing with count', async ({ page }, testInfo) => {
  await page.goto('/dashboard?lat=35&lon=-98&zoom=3&layers=datacenters');
  await expect.poll(() => page.evaluate(() => window.__markerLayerProbe?.info('datacenter-clusters-layer')?.loaded),
    { timeout: 30_000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__markerLayerProbe?.settled())).toBe(true);
  const point = await page.evaluate(() => {
    const probe = window.__markerLayerProbe;
    const group = probe?.info('datacenter-clusters-layer')?.samples
      .filter(sample => (sample.count ?? 0) > 1 && sample.lon > -125 && sample.lon < -65)
      .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))[0];
    if (!probe || !group) throw new Error('Real large US datacenter aggregate missing');
    return probe.project([group.lon, group.lat]);
  });
  const image = await page.screenshot({
    clip: { x: Math.round(point.x) - 40, y: Math.round(point.y) - 40, width: 80, height: 80 },
    scale: 'css',
    path: testInfo.outputPath('datacenter-aggregate-12px.png'),
  });
  const bounds = await page.evaluate(async base64 => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    let left = image.width, right = -1, top = image.height, bottom = -1;
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const i = (y * image.width + x) * 4;
        const r = pixels[i]!, g = pixels[i + 1]!, b = pixels[i + 2]!;
        if (b > g * 1.35 && b > r * 1.15 && b > 40) {
          left = Math.min(left, x); right = Math.max(right, x);
          top = Math.min(top, y); bottom = Math.max(bottom, y);
        }
      }
    }
    return { width: right < 0 ? 0 : right - left + 1, height: bottom < 0 ? 0 : bottom - top + 1 };
  }, image.toString('base64'));
  expect(bounds.width, 'the real server rack must be visible').toBeGreaterThan(0);
  expect(bounds.height).toBeGreaterThan(0);
  expect(bounds.width).toBeLessThanOrEqual(12);
  expect(bounds.height).toBeLessThanOrEqual(12);
});

test('mixed-layer legends show their real subtype glyphs rather than old circles', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('worldmonitor-variant', 'happy'));
  await page.goto('/dashboard?layers=positiveEvents,renewableInstallations,natural');
  await expect(page.locator('#mapContainer')).toHaveClass(/deckgl-mode/, { timeout: 30_000 });
  for (const [key, kinds] of [
    ['positiveEvents', ['wildlife', 'kindness', 'science-health', 'innovation', 'climate', 'community']],
    ['renewableInstallations', ['solar', 'wind', 'hydro', 'geothermal']],
    ['natural', ['earthquake', 'volcano', 'fire', 'flood', 'cyclone', 'natural-event']],
  ] satisfies Array<[string, MapMarkerIconKind[]]>) {
    const actual = await page.locator(`.legend-item[data-layer="${key}"] svg`).evaluateAll(icons =>
      icons.map(svg => ({
        geometry: Array.from(svg.children).map(shape => new XMLSerializer().serializeToString(shape)).join(''),
        color: getComputedStyle(svg).color,
      })));
    const expected = await page.evaluate(sources => sources.map(source => {
      const svg = new DOMParser().parseFromString(source, 'image/svg+xml').documentElement;
      return Array.from(svg.children).map(shape => new XMLSerializer().serializeToString(shape)).join('');
    }), kinds.map(getMapMarkerSvg));
    expect(new Set(actual.map(icon => icon.geometry))).toEqual(new Set(expected));
    const colors = key === 'positiveEvents'
      ? ['rgb(34, 197, 94)', 'rgb(34, 197, 94)', 'rgb(234, 179, 8)', 'rgb(234, 179, 8)', 'rgb(234, 179, 8)', 'rgb(139, 92, 246)']
      : key === 'renewableInstallations'
        ? ['rgb(255, 200, 50)', 'rgb(100, 200, 255)', 'rgb(0, 180, 180)', 'rgb(255, 150, 80)']
        : null;
    if (colors) {
      for (const [index, geometry] of expected.entries()) {
        expect(actual.find(icon => icon.geometry === geometry)?.color).toBe(colors[index]);
      }
    }
  }
  const legend = await page.locator('.deckgl-legend').boundingBox();
  const map = await page.locator('#mapContainer').boundingBox();
  expect(legend!.x).toBeGreaterThanOrEqual(map!.x);
  expect(legend!.x + legend!.width).toBeLessThanOrEqual(map!.x + map!.width);
});

test('2D financial locations render real SVG icon layers and keep their popups', async ({ page }, testInfo) => {
  await page.goto('/dashboard');
  await expect(page.locator('#mapContainer')).toHaveClass(/deckgl-mode/, { timeout: 30_000 });
  await page.getByRole('link', { name: '📈 FINANCE', exact: true }).click();
  for (const key of ['stockExchanges', 'financialCenters', 'centralBanks']) {
    await enableLayer(page, key);
  }
  for (const id of ['stock-exchanges-layer', 'financial-centers-layer', 'central-banks-layer']) {
    await expect.poll(() => page.evaluate(
      (layerId) => window.__markerLayerProbe?.info(layerId)?.kind,
      id,
    )).toBe('IconLayer');
    await expect.poll(() => page.evaluate(
      (layerId) => window.__markerLayerProbe?.info(layerId)?.loaded,
      id,
    ), { timeout: 15_000 }).toBe(true);
  }
  for (const [key, id] of [
    ['stockExchanges', 'stock-exchanges-layer'],
    ['financialCenters', 'financial-centers-layer'],
    ['centralBanks', 'central-banks-layer'],
  ]) {
    const controlIcon = page.locator(`.layer-toggle[data-layer="${key}"] .toggle-icon svg`);
    await expect(controlIcon).toBeVisible();
    const checkbox = page.locator(`.layer-toggle[data-layer="${key}"] input`);
    await page.locator(`.layer-toggle[data-layer="${key}"] .toggle-icon`).click();
    await expect(checkbox).not.toBeChecked();
    await page.locator(`.layer-toggle[data-layer="${key}"] .toggle-icon`).click();
    await expect(checkbox).toBeChecked();
    await expect.poll(() => page.evaluate(layerId => window.__markerLayerProbe?.info(layerId!)?.loaded, id))
      .toBe(true);
    const geometry = await page.evaluate(layerId => window.__markerLayerProbe!.geometry(layerId!), id);
    expect(await controlIcon.evaluate(svg => Array.from(svg.children)
      .map(shape => new XMLSerializer().serializeToString(shape)).join(''))).toBe(geometry);
    expect(await page.locator(`.legend-item[data-layer="${key}"] svg`).evaluate(svg => Array.from(svg.children)
      .map(shape => new XMLSerializer().serializeToString(shape)).join('')))
      .toBe(geometry);
  }
  await page.getByRole('combobox', { name: 'Select Region' }).selectOption({ label: 'Europe' });
  await expect.poll(() => page.evaluate(() => window.__markerLayerProbe?.settled())).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('2d-financial-pictograms.png') });
  for (const key of ['financialCenters', 'centralBanks']) {
    await page.locator(`.layer-toggle[data-layer="${key}"] input`).uncheck();
  }
  await expect.poll(() => page.evaluate(
    () => window.__markerLayerProbe?.info('central-banks-layer'),
  )).toBeNull();
  const point = await page.evaluate(() => {
    const probe = window.__markerLayerProbe;
    const london = probe?.info('stock-exchanges-layer')?.samples.find(sample => sample.city === 'London');
    if (!probe || !london) throw new Error('Real London exchange marker missing');
    return probe.project([london.lon, london.lat]);
  });
  await page.mouse.click(point.x, point.y);
  await expect(page.locator('.map-popup').filter({ hasText: 'London Stock Exchange' }).first()).toBeVisible();
});

test('3D earthquake locations render SVG heads and keep their popups', async ({ page }, testInfo) => {
  const earthquakes = {
    earthquakes: [{
      id: 'pictogram-fixture',
      place: 'Synthetic Alps earthquake',
      magnitude: 5.2,
      depthKm: 10,
      location: { latitude: 46.5, longitude: 7.5 },
      occurredAt: Date.now(),
      sourceUrl: '',
      source: 'usgs',
      category: '',
    }],
  };
  await page.route('**/api/bootstrap?*', route => route.fulfill({
    json: { data: { earthquakes }, missing: [] },
  }));
  await page.route('**/api/seismology/v1/list-earthquakes*', route => route.fulfill({ json: earthquakes }));
  await page.goto('/dashboard');
  await expect(page.locator('#mapContainer .deckgl-layer-toggles')).toBeVisible({ timeout: 30_000 });
  await page.locator('#mapDimensionToggle [data-mode="globe"]').click();
  await expect(page.locator('#mapContainer')).toHaveClass(/globe-mode/);
  await enableLayer(page, 'natural');
  const enabledLayers = await page.locator('#mapContainer label.layer-toggle:has(input:checked)')
    .evaluateAll(labels => labels.map(label => label.getAttribute('data-layer')));
  for (const key of enabledLayers) {
    if (key && key !== 'natural') {
      await page.locator(`#mapContainer .layer-toggle[data-layer="${key}"] input`).uncheck();
    }
  }
  await expect(page.locator('[data-marker-probe-kind="nuclearSite"]')).toHaveCount(0);
  const marker = page.locator('[data-marker-probe-kind="earthquake"]:visible').first();
  await expect(marker).toBeVisible({ timeout: 20_000 });
  await expect(marker.locator('svg')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('3d-earthquake-pictograms.png') });
  const bounds = await marker.boundingBox();
  if (!bounds) throw new Error('Visible earthquake marker has no hit bounds');
  const target = await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y);
    return { html: element?.outerHTML, marker: element?.closest('[data-marker-probe-kind]')?.getAttribute('data-marker-probe-kind') };
  }, { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
  await testInfo.attach('globe-hit-target.json', { body: JSON.stringify(target), contentType: 'application/json' });
  expect(target.marker, JSON.stringify(target)).toBe('earthquake');
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  const tooltip = page.locator('#mapContainer div:has(button[aria-label="Close"])')
    .filter({ hasText: 'Synthetic Alps earthquake' }).last();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText('M5.2');
});
