import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import {
  DEVELOPER_MODE_STORAGE_KEY,
  initDeveloperMode,
  readDeveloperMode,
  writeDeveloperMode,
  createDeveloperDiagnosticsSnapshot,
  downloadDeveloperDiagnostics,
} from './developerMode.js';

function storage(values = {}) {
  return {
    values: new Map(Object.entries(values)),
    getItem(key) { return this.values.get(key) ?? null; },
    setItem(key, value) { this.values.set(key, String(value)); },
  };
}

test('developer mode defaults off when storage has no saved state', () => {
  assert.equal(readDeveloperMode(storage()), false);
});

test('developer mode restores only the persisted true value', () => {
  const store = storage({ [DEVELOPER_MODE_STORAGE_KEY]: 'true' });
  assert.equal(readDeveloperMode(store), true);
  store.setItem(DEVELOPER_MODE_STORAGE_KEY, 'false');
  assert.equal(readDeveloperMode(store), false);
});

test('developer mode writes a boolean state to storage', () => {
  const store = storage();
  writeDeveloperMode(true, store);
  assert.equal(store.getItem(DEVELOPER_MODE_STORAGE_KEY), 'true');
  writeDeveloperMode(false, store);
  assert.equal(store.getItem(DEVELOPER_MODE_STORAGE_KEY), 'false');
});

test('developer panel is labeled DEV TOOLBOX', () => {
  const template = readFileSync(
    new URL('./templates/command-dock.html', import.meta.url),
    'utf8',
  );
  assert.match(template, /<span>DEV TOOLBOX<\/span>/);
  assert.doesNotMatch(template, /<span>DEV TOOLS<\/span>/);
});

test('developer mode reveals the diagnostics panel when enabled', () => {
  const toggle = {
    checked: false,
    listeners: new Map(),
    setAttribute(key, value) { this[key] = value; },
    addEventListener(type, handler) { this.listeners.set(type, handler); },
    removeEventListener(type) { this.listeners.delete(type); },
    dispatch(type) { this.listeners.get(type)?.({ target: this }); },
  };
  const analyst = { hidden: false, classList: { toggle() {} } };
  const panel = {
    hidden: true,
    id: 'developer-tools-panel',
    parentElement: { id: 'command-dock' },
    classList: { toggle() {} },
    querySelector(selector) {
      if (selector === '#developer-camera-readout') return { textContent: '' };
      if (selector === '#developer-render-readout') return { textContent: '' };
      if (selector === '#developer-layers-readout') return { textContent: '' };
      if (selector === '#developer-voice-readout') return { textContent: '' };
      return null;
    },
    remove() { this.parentElement = null; },
  };
  const body = {
    children: [],
    appendChild(node) { this.children.push(node); node.parentElement = this; },
  };
  const doc = {
    body,
    querySelector(selector) {
      if (selector === '#developer-mode-toggle') return toggle;
      if (selector === '#analyst-console') return analyst;
      if (selector === '#developer-tools-panel') return panel;
      if (selector === 'body') return body;
      return null;
    },
    documentElement: { classList: { toggle() {} } },
  };

  const store = storage();
  const instance = initDeveloperMode({ storage: store, documentRef: doc });
  assert.ok(instance);
  assert.equal(panel.parentElement, body);

  toggle.checked = true;
  toggle.dispatch('change');
  assert.equal(panel.hidden, false);
  assert.equal(store.getItem(DEVELOPER_MODE_STORAGE_KEY), 'true');
  instance.destroy();
});

test('developer diagnostics refresh from live app state while enabled', () => {
  let intervalCallback = null;
  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = (callback) => {
    intervalCallback = callback;
    return 1;
  };

  const toggle = {
    checked: true,
    listeners: new Map(),
    setAttribute(key, value) { this[key] = value; },
    addEventListener(type, handler) { this.listeners.set(type, handler); },
    removeEventListener(type) { this.listeners.delete(type); },
  };
  const analyst = { hidden: false, classList: { toggle() {} } };
  const nodes = {
    camera: { textContent: '' },
    render: { textContent: '' },
    layers: { textContent: '' },
    voice: { textContent: '' },
    routes: { textContent: '', title: '' },
    assets: {
      children: [],
      replaceChildren(...children) { this.children = children; },
      append(child) { this.children.push(child); },
    },
  };
  const panel = {
    hidden: false,
    id: 'developer-tools-panel',
    parentElement: { id: 'command-dock' },
    classList: { toggle() {} },
    querySelector(selector) {
      if (selector === '#developer-camera-readout') return nodes.camera;
      if (selector === '#developer-render-readout') return nodes.render;
      if (selector === '#developer-layers-readout') return nodes.layers;
      if (selector === '#developer-voice-readout') return nodes.voice;
      if (selector === '#developer-routes-readout') return nodes.routes;
      if (selector === '#developer-assets-list') return nodes.assets;
      return null;
    },
    remove() { this.parentElement = null; },
  };
  const body = {
    children: [],
    appendChild(node) { this.children.push(node); node.parentElement = this; },
  };
  const doc = {
    body,
    querySelector(selector) {
      if (selector === '#developer-mode-toggle') return toggle;
      if (selector === '#analyst-console') return analyst;
      if (selector === '#developer-tools-panel') return panel;
      if (selector === 'body') return body;
      return null;
    },
    createElement() {
      return {
        children: [],
        append(...children) { this.children.push(...children); },
      };
    },
    documentElement: { classList: { toggle() {} } },
  };

  const loadedLayers = [
    { id: 'civil-flights', name: 'Civil Flights', enabled: true, stats: { count: 7 } },
    { id: 'traffic', name: 'Street Traffic', icon: '🚗', source: 'OpenStreetMap', enabled: true, stats: { count: 2, mode: 'sim', flowCoveragePct: 35, tilesFetched: 4 } },
    { id: 'transit', name: 'Transit', icon: '🚌', enabled: true, stats: { count: 3, source: 'GTFS-RT', coverage: 'MBTA 3' } },
    { id: 'earthquakes', name: 'Earthquakes', enabled: true, stats: { count: 0 } },
    { id: 'vessels', name: 'Vessels', enabled: false, stats: { count: 12 } },
  ];
  const trafficPositions = [
    { position: { x: 50, y: 50 } },
    { position: { x: 60, y: 60 } },
  ];
  const transitPositions = [
    { position: { x: 70, y: 70 } },
    { position: { x: 80, y: 80 } },
    { position: { x: 120, y: 80 } },
  ];
  globalThis.__godsEyeView = {
    viewer: {
      camera: { heading: 2.1, positionCartographic: { height: 18_000 } },
      canvas: { width: 100, height: 100 },
      scene: {
        cartesianToCanvasCoordinates: (position) => position,
      },
    },
    dataManager: {
      getAll: () => loadedLayers,
      layers: new Map([
        ['civil-flights', { module: { getAllPositions: () => [
          { position: { x: 40, y: 50 } },
          { position: { x: 140, y: 50 } },
        ] } }],
        ['traffic', { module: { getDetectableObjects: () => trafficPositions } }],
        [
          'transit',
          {
            module: {
              getDetectableObjects: () => transitPositions,
              getTransitRouteDiagnostics: () => ({
                enabled: true,
                count: 0,
                loading: true,
                requestStage: 'priority',
                error: null,
                bounds: { south: 42.3, west: -71.2, north: 42.4, east: -71 },
              }),
            },
          },
        ],
      ]),
    },
    getRenderGovernorDiagnostics: () => ({ installed: true, mode: 'continuous', holds: ['traffic'] }),
    voiceCommands: { session: { state: 'idle' } },
  };

  const store = storage();
  const instance = initDeveloperMode({ storage: store, documentRef: doc });
  assert.ok(instance);

  globalThis.__godsEyeView = { ...globalThis.__godsEyeView };

  assert.equal(typeof intervalCallback, 'function');
  intervalCallback();
  assert.match(nodes.camera.textContent, /120°/);
  assert.match(nodes.render.textContent, /CONTINUOUS/);
  assert.match(nodes.layers.textContent, /4\//);
  assert.match(nodes.voice.textContent, /OFF/);
  assert.equal(nodes.routes.textContent, 'VIEW · LOADING · 0');
  assert.match(nodes.routes.title, /BOUNDS 42\.300,-71\.200,42\.400,-71\.000/);
  assert.equal(nodes.assets.children.length, 4);
  assert.equal(nodes.assets.children[0].children[0].textContent, '✈ Civil Flights');
  assert.equal(nodes.assets.children[0].children[1].textContent, '1 IN VIEW / 7 LOADED');
  assert.equal(nodes.assets.children[1].children[0].textContent, '🚗 Street Traffic');
  assert.equal(nodes.assets.children[1].children[1].textContent, '2 IN VIEW / 2 LOADED');
  assert.equal(nodes.assets.children[1].children[2].children[0].textContent, '~');
  assert.equal(nodes.assets.children[1].children[2].children[1].textContent, 'OpenStreetMap · SIM');
  assert.equal(nodes.assets.children[1].children[3].textContent, 'SIMULATED · TOMTOM KEY NOT CONFIGURED');
  assert.equal(nodes.assets.children[2].children[0].textContent, '🚌 Transit');
  assert.equal(nodes.assets.children[2].children[1].textContent, '2 IN VIEW / 3 LOADED');
  assert.equal(nodes.assets.children[2].children[2].children[1].textContent, 'GTFS-RT · ENABLED');
  assert.equal(nodes.assets.children[2].children[3].textContent, 'MBTA 3');

  loadedLayers.find(({ id }) => id === 'traffic').stats.count = 0;
  loadedLayers.find(({ id }) => id === 'transit').stats.count = 0;
  const trafficStats = loadedLayers.find(({ id }) => id === 'traffic').stats;
  trafficStats.mode = 'live';
  trafficStats.loading = true;
  trafficStats.loadingLabel = 'syncing LIVE traffic flow';
  trafficStats.lastUpdate = null;
  trafficStats.error = null;
  trafficPositions.length = 0;
  transitPositions.length = 0;
  intervalCallback();
  assert.equal(nodes.assets.children.length, 4);
  assert.equal(nodes.assets.children[1].children[1].textContent, '0 IN VIEW / 0 LOADED');
  assert.equal(nodes.assets.children[1].children[2].children[0].textContent, '×');
  assert.equal(nodes.assets.children[1].children[2].children[1].textContent, 'OpenStreetMap · UNAVAILABLE');
  assert.equal(nodes.assets.children[1].children[3].textContent, 'OSM ROAD DATA UNAVAILABLE');
  assert.equal(nodes.assets.children[2].children[1].textContent, '0 IN VIEW / 0 LOADED');

  globalThis.setInterval = originalSetInterval;
  instance.destroy();
});

test('developer diagnostics export includes view, matching Transit feeds, and source health', () => {
  const transitRouteData = {
    source: 'OpenStreetMap via Overpass',
    count: 1,
    loading: false,
    error: null,
    bounds: { south: 42.3, west: -71.2, north: 42.4, east: -71 },
    routes: [
      {
        id: '123:456',
        routeId: '123',
        name: 'Red Line',
        ref: 'A',
        type: 'subway',
        color: '#DA291C',
        lineCount: 1,
        lines: [[[-71.1, 42.35], [-71.05, 42.35]]],
      },
    ],
  };
  const app = {
    viewer: {
      camera: {
        positionCartographic: { latitude: Math.PI / 4, longitude: -Math.PI / 2, height: 20_000 },
        pickEllipsoid: () => Cesium.Cartesian3.fromDegrees(-90, 45),
        computeViewRectangle: () => null,
      },
      scene: {
        canvas: { width: 100, height: 100 },
        globe: { ellipsoid: { cartesianToCartographic: () => ({ latitude: Math.PI / 4, longitude: -Math.PI / 2 }) } },
      },
    },
    dataManager: {
      layers: new Map([
        [
          'transit',
          { module: { getTransitRouteDiagnostics: () => transitRouteData } },
        ],
      ]),
      getAll: () => [
        {
          id: 'transit',
          name: 'Transit',
          enabled: true,
          lifecycleState: 'enabled',
          stats: { count: 0, source: 'GTFS-RT', status: 'zoom-in', coverage: 'No feed here yet' },
        },
        {
          id: 'traffic',
          name: 'Street Traffic',
          enabled: true,
          stats: { count: 0, lastUpdate: null, mode: 'live', error: null, loading: true },
        },
      ],
    },
    getRenderGovernorDiagnostics: () => ({ installed: true, mode: 'idle', holds: [] }),
  };

  const snapshot = createDeveloperDiagnosticsSnapshot(app);
  assert.equal(snapshot.schema, 'gods-eye-view-developer-diagnostics/v1');
  assert.equal(snapshot.camera.centerSource, 'screen-center-ground-hit');
  assert.ok(Math.abs(snapshot.camera.center.latitude - 45) < 1e-6);
  assert.equal(snapshot.transit.matchingFeeds.length, 0);
  assert.equal(snapshot.transit.nearestFeeds.length, 8);
  assert.deepEqual(snapshot.transit.routeData, transitRouteData);
  assert.equal(snapshot.layers[0].stats.coverage, 'No feed here yet');
  assert.equal(snapshot.layers[1].availability, 'unavailable');
  assert.match(snapshot.layers[1].availabilityReason, /No OSM road data/);
  assert.equal(snapshot.layers[1].stats.error, null);
});

test('developer diagnostics export downloads a local JSON file', () => {
  let clicked = false;
  let exportedBlob = null;
  const anchor = {
    click() { clicked = true; },
    remove() {},
  };
  const documentRef = {
    body: { appendChild() {} },
    createElement: () => anchor,
  };
  const urlApi = {
    createObjectURL(blob) { exportedBlob = blob; return 'blob:diagnostics'; },
    revokeObjectURL() {},
  };

  assert.equal(downloadDeveloperDiagnostics({ app: {}, documentRef, urlApi }), true);
  assert.equal(clicked, true);
  assert.equal(anchor.download.startsWith('gods-eye-view-diagnostics-'), true);
  assert.equal(exportedBlob.type, 'application/json');
});