import * as Cesium from 'cesium';
import { TRANSIT_ENABLED_FEEDS, haversineKm } from '../data/transitFeeds.js';

/** Persisted opt-in switch for tools intended for development and QA. */
export const DEVELOPER_MODE_STORAGE_KEY = 'godsEyeView.developerMode.enabled';

function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

export function readDeveloperMode(storage = defaultStorage()) {
  try {
    return storage?.getItem(DEVELOPER_MODE_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writeDeveloperMode(enabled, storage = defaultStorage()) {
  try {
    storage?.setItem(DEVELOPER_MODE_STORAGE_KEY, String(Boolean(enabled)));
  } catch {
    // Storage can be unavailable in private or locked-down browser contexts.
  }
}

function formatDegrees(value) {
  if (!Number.isFinite(value)) return '—';
  return `${Math.round((value * 180) / Math.PI)}°`;
}

function readDiagnosticView(app) {
  const viewer = app.viewer;
  const camera = viewer?.camera;
  const position = camera?.positionCartographic;
  const canvas = viewer?.scene?.canvas;
  const width = canvas?.clientWidth || canvas?.width;
  const height = canvas?.clientHeight || canvas?.height;
  let center = null;
  let centerSource = 'unavailable';

  if (
    typeof camera?.pickEllipsoid === 'function' &&
    Number.isFinite(width) &&
    width > 0 &&
    Number.isFinite(height) &&
    height > 0
  ) {
    try {
      const hit = camera.pickEllipsoid(
        new Cesium.Cartesian2(width / 2, height / 2),
        Cesium.Ellipsoid.WGS84,
      );
      const cartographic = hit && Cesium.Cartographic.fromCartesian(hit);
      if (
        Number.isFinite(cartographic?.latitude) &&
        Number.isFinite(cartographic?.longitude)
      ) {
        center = {
          latitude: Cesium.Math.toDegrees(cartographic.latitude),
          longitude: Cesium.Math.toDegrees(cartographic.longitude),
        };
        centerSource = 'screen-center-ground-hit';
      }
    } catch {
      // A sky-facing center pixel has no ellipsoid hit; use camera nadir.
    }
  }

  if (
    !center &&
    Number.isFinite(position?.latitude) &&
    Number.isFinite(position?.longitude)
  ) {
    center = {
      latitude: Cesium.Math.toDegrees(position.latitude),
      longitude: Cesium.Math.toDegrees(position.longitude),
    };
    centerSource = 'camera-nadir-fallback';
  }

  let rectangle = null;
  try {
    const view = camera?.computeViewRectangle?.(
      viewer?.scene?.globe?.ellipsoid,
    );
    if (view) {
      rectangle = {
        south: Cesium.Math.toDegrees(view.south),
        west: Cesium.Math.toDegrees(view.west),
        north: Cesium.Math.toDegrees(view.north),
        east: Cesium.Math.toDegrees(view.east),
      };
    }
  } catch {
    rectangle = null;
  }

  return {
    altitudeM: Number.isFinite(position?.height) ? position.height : null,
    cameraPosition:
      Number.isFinite(position?.latitude) &&
      Number.isFinite(position?.longitude)
        ? {
            latitude: Cesium.Math.toDegrees(position.latitude),
            longitude: Cesium.Math.toDegrees(position.longitude),
          }
        : null,
    center,
    centerSource,
    rectangle,
  };
}

const EXPORTED_LAYER_STATS = [
  'count',
  'lastUpdate',
  'source',
  'status',
  'mode',
  'error',
  'stale',
  'loading',
  'loadingLabel',
  'degraded',
  'available',
  'unavailable',
  'retryInSec',
  'coverage',
  'feeds',
  'flowCoveragePct',
  'tilesFetched',
  'flowBuckets',
  'closedRoads',
  'heatLines',
];

function exportLayerStats(stats = {}) {
  return Object.fromEntries(
    EXPORTED_LAYER_STATS.filter((key) => stats[key] !== undefined).map(
      (key) => [
        key,
        key === 'error'
          ? stats.error == null
            ? null
            : stats.error instanceof Error
              ? stats.error.message
              : String(stats.error)
          : stats[key],
      ],
    ),
  );
}

function layerAvailability(layer) {
  if (!layer.enabled) return 'disabled';
  const stats = layer.stats || {};
  const count = Number(stats.count) || 0;
  const hasUpdate =
    stats.lastUpdate != null && Number.isFinite(Number(stats.lastUpdate));
  const hasError =
    stats.error != null && stats.error !== '' && stats.error !== 'null';
  if (stats.status === 'unavailable' || (hasError && count === 0))
    return 'unavailable';
  if (layer.id === 'traffic' && count === 0 && !hasUpdate) return 'unavailable';
  if (stats.loading) return 'loading';
  if (count > 0 && stats.stale) return 'stale';
  return count > 0 ? 'available' : 'empty';
}

function layerAvailabilityReason(layer, availability) {
  if (availability !== 'unavailable') return null;
  if (layer.id === 'traffic')
    return 'No OSM road data is available to render Street Traffic.';
  const error = layer.stats?.error;
  return error
    ? String(error.message || error)
    : 'The source has no available data.';
}

export function createDeveloperDiagnosticsSnapshot(
  app = globalThis.__godsEyeView,
) {
  const layers = app?.dataManager?.getAll?.() || [];
  const transitLayer = app?.dataManager?.layers?.get?.('transit')?.module;
  const transitRouteData =
    transitLayer?.getTransitRouteDiagnostics?.({ includeGeometry: true }) ||
    null;
  const view = readDiagnosticView(app || {});
  const nearestTransitFeeds = view.center
    ? TRANSIT_ENABLED_FEEDS.map((feed) => ({
        id: feed.id,
        name: feed.name,
        region: feed.region,
        distanceKm: Math.round(
          haversineKm(
            view.center.latitude,
            view.center.longitude,
            feed.center.lat,
            feed.center.lon,
          ),
        ),
        loadRadiusKm: feed.loadRadiusKm,
      })).sort((a, b) => a.distanceKm - b.distanceKm)
    : [];

  return {
    schema: 'gods-eye-view-developer-diagnostics/v1',
    capturedAt: new Date().toISOString(),
    camera: view,
    transit: {
      activationAltitudeLimitM: 2_850_000,
      altitudeGateOpen: view.altitudeM !== null && view.altitudeM <= 2_850_000,
      nearestFeeds: nearestTransitFeeds,
      matchingFeeds: nearestTransitFeeds.filter(
        (feed) => feed.distanceKm <= feed.loadRadiusKm,
      ),
      routeData: transitRouteData,
    },
    render: app?.getRenderGovernorDiagnostics?.() || null,
    voiceState: app?.voiceCommands?.session?.state || 'idle',
    layers: layers.map((layer) => {
      const availability = layerAvailability(layer);
      return {
        id: layer.id,
        name: layer.name,
        enabled: Boolean(layer.enabled),
        lifecycleState: layer.lifecycleState || null,
        availability,
        availabilityReason: layerAvailabilityReason(layer, availability),
        source: layer.stats?.source || layer.source || null,
        stats: exportLayerStats(layer.stats),
      };
    }),
  };
}

export function downloadDeveloperDiagnostics({
  app = globalThis.__godsEyeView,
  documentRef = globalThis.document,
  urlApi = globalThis.URL,
  BlobClass = globalThis.Blob,
} = {}) {
  if (
    !documentRef?.createElement ||
    !documentRef.body ||
    typeof BlobClass !== 'function' ||
    typeof urlApi?.createObjectURL !== 'function'
  )
    return false;

  const payload = createDeveloperDiagnosticsSnapshot(app);
  const blob = new BlobClass([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  const url = urlApi.createObjectURL(blob);
  const link = documentRef.createElement('a');
  link.href = url;
  link.download = `gods-eye-view-diagnostics-${payload.capturedAt.replace(/[:.]/g, '-')}.json`;
  documentRef.body.appendChild(link);
  link.click();
  link.remove();
  globalThis.setTimeout(() => urlApi.revokeObjectURL?.(url), 0);
  return true;
}

function assetIcon(layer) {
  const identity = `${layer.id || ''} ${layer.name || ''}`.toLowerCase();
  if (/flight|aircraft|military/.test(identity)) return '✈';
  if (/vessel|ship|maritime/.test(identity)) return '🚢';
  if (/satellite|space/.test(identity)) return '🛰';
  if (/fire|perimeter/.test(identity)) return '🔥';
  if (/earthquake/.test(identity)) return '🌋';
  if (/camera|cctv/.test(identity)) return '📷';
  if (/transit/.test(identity)) return layer.icon || '🚌';
  if (/traffic|vehicle/.test(identity)) return layer.icon || '🚗';
  return layer.icon || '•';
}

function countInView(app, layer) {
  const module = app.dataManager?.layers?.get?.(layer.id)?.module;
  const viewer = app.viewer;
  const scene = viewer?.scene;
  const canvas = viewer?.canvas;
  if (
    !layer.enabled ||
    (typeof module?.getAllPositions !== 'function' &&
      typeof module?.getDetectableObjects !== 'function') ||
    typeof scene?.cartesianToCanvasCoordinates !== 'function' ||
    !canvas
  )
    return null;

  try {
    const positions =
      typeof module.getAllPositions === 'function'
        ? module.getAllPositions(10_000)
        : module.getDetectableObjects({ maxCount: 10_000, seed: 0 });
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    if (!Array.isArray(positions) || !width || !height) return null;
    return positions.reduce((count, item) => {
      if (!item?.position) return count;
      const point = scene.cartesianToCanvasCoordinates(item.position);
      return point &&
        point.x >= 0 &&
        point.x <= width &&
        point.y >= 0 &&
        point.y <= height
        ? count + 1
        : count;
    }, 0);
  } catch {
    return null;
  }
}

function sourceDiagnostics(layer) {
  const stats = layer.stats || {};
  const source = stats.source || layer.source || 'SOURCE NOT REPORTED';
  const traffic = layer.id === 'traffic';
  const flowError = String(stats.error?.message || stats.error || '').replace(
    /^SIMULATED\s*[—-]\s*/i,
    '',
  );
  const tilesFetched = Number(stats.tilesFetched) || 0;
  const unavailable =
    traffic &&
    (Number(stats.count) || 0) === 0 &&
    (stats.lastUpdate == null || !Number.isFinite(Number(stats.lastUpdate)));
  const status = unavailable
    ? 'UNAVAILABLE'
    : stats.error
      ? traffic
        ? 'FLOW DEGRADED'
        : `ERROR: ${String(stats.error.message || stats.error)}`
      : stats.loading
        ? stats.loadingLabel || 'LOADING'
        : stats.stale
          ? 'STALE'
          : stats.degraded
            ? 'DEGRADED'
            : stats.status === 'zoom-in'
              ? 'NO ACTIVE FEED'
              : traffic && stats.mode === 'live'
                ? 'LIVE CONFIGURED'
                : stats.mode || layer.lifecycleState || 'enabled';
  let detail = stats.coverage || '';
  if (traffic && stats.mode === 'live') {
    detail = unavailable
      ? 'OSM ROAD DATA UNAVAILABLE'
      : stats.error
        ? flowError
        : stats.loading
          ? stats.loadingLabel || 'TOMTOM FLOW REQUEST IN PROGRESS'
          : tilesFetched === 0
            ? 'TOMTOM FLOW NOT REQUESTED THIS SESSION'
            : `TOMTOM FLOW ${Math.round(Number(stats.flowCoveragePct) || 0)}% MATCHED · ${tilesFetched} TILES THIS SESSION`;
  } else if (traffic && stats.mode === 'sim') {
    detail = unavailable
      ? 'OSM ROAD DATA UNAVAILABLE'
      : stats.error ||
        stats.loadingLabel ||
        'SIMULATED · TOMTOM KEY NOT CONFIGURED';
  } else if (!detail && Number.isFinite(stats.flowCoveragePct)) {
    detail = `FLOW ${Math.round(stats.flowCoveragePct)}% · ${tilesFetched} TILES`;
  }
  const lastUpdate = Number(stats.lastUpdate);
  const age =
    Number.isFinite(lastUpdate) && lastUpdate > 0
      ? Math.max(0, Math.floor((Date.now() - lastUpdate) / 1000))
      : null;
  const statusState =
    status === 'UNAVAILABLE' || stats.status === 'unavailable'
      ? 'unavailable'
      : /ERROR|DEGRADED/.test(status)
        ? 'degraded'
        : status === 'STALE'
          ? 'stale'
          : /LOADING|SYNCING/.test(status)
            ? 'loading'
            : status === 'NO ACTIVE FEED'
              ? 'guidance'
              : stats.mode === 'sim'
                ? 'fallback'
                : 'available';
  const statusIcon = {
    unavailable: '×',
    degraded: '!',
    stale: '!',
    loading: '◌',
    guidance: 'i',
    fallback: '~',
    available: '✓',
  }[statusState];

  return {
    summary: `${source} · ${String(status).toUpperCase()}`,
    statusState,
    statusIcon,
    detail: [
      detail,
      age === null
        ? ''
        : `UPDATED ${age < 60 ? `${age}s` : `${Math.floor(age / 60)}m`} AGO`,
    ]
      .filter(Boolean)
      .join(' · '),
  };
}

function readAssetDiagnostics(app) {
  const layers = app.dataManager?.getAll?.() || [];
  return layers
    .filter((layer) => layer.enabled)
    .map((layer) => {
      const loaded = Number(layer.stats?.count) || 0;
      return {
        id: layer.id,
        name: layer.name || layer.id || 'Asset',
        icon: assetIcon(layer),
        loaded,
        inView: countInView(app, layer),
        source: sourceDiagnostics(layer),
      };
    });
}

function readLiveDiagnostics() {
  const app = globalThis.__godsEyeView || {};
  const viewer = app.viewer;
  const camera = viewer?.camera;
  const carto = camera?.positionCartographic;
  const render = app.getRenderGovernorDiagnostics?.() || {};
  const totalLayers = app.dataManager?.getAll?.().length ?? 0;
  const enabledLayers =
    app.dataManager?.getAll?.().filter((layer) => layer.enabled).length ?? 0;
  const voiceState = app.voiceCommands?.session?.state ?? 'idle';
  const normalizedVoiceState = String(voiceState || 'idle').toLowerCase();
  const formattedVoiceState =
    normalizedVoiceState === 'idle'
      ? 'OFF'
      : normalizedVoiceState.toUpperCase();
  const transitModule = app.dataManager?.layers?.get?.('transit')?.module;
  const routeData = transitModule?.getTransitRouteDiagnostics?.() || null;
  const routeCount = Number(routeData?.count) || 0;
  const routePhase =
    routeData?.requestStage === 'prefetch'
      ? 'PREFETCH'
      : routeData?.requestStage === 'priority'
        ? 'VIEW'
        : null;
  const routeStatus = routeData?.loading
    ? `${routePhase || 'ROUTE'} · LOADING`
    : routeData?.error
      ? `HTTP ${routeData.lastStatus || 'ERROR'}`
      : routeData?.lastStatus
        ? `READY · HTTP ${routeData.lastStatus}`
        : routeData?.enabled
          ? 'WAITING'
          : 'DISABLED';
  const routeReadout = routeData
    ? {
        text: `${routeStatus} · ${routeCount}`,
        title: [
          routeData.error,
          routeData.upstream && `UPSTREAM ${routeData.upstream}`,
          routeData.cache && `CACHE ${routeData.cache}`,
          routeData.bounds &&
            `BOUNDS ${routeData.bounds.south.toFixed(3)},${routeData.bounds.west.toFixed(3)},${routeData.bounds.north.toFixed(3)},${routeData.bounds.east.toFixed(3)}`,
          routeData.coverageBounds &&
            `COVERAGE ${routeData.coverageBounds.south.toFixed(3)},${routeData.coverageBounds.west.toFixed(3)},${routeData.coverageBounds.north.toFixed(3)},${routeData.coverageBounds.east.toFixed(3)}`,
        ]
          .filter(Boolean)
          .join(' · '),
      }
    : { text: 'NO DIAGNOSTICS', title: 'Transit route diagnostics unavailable.' };

  return {
    camera: carto
      ? `${formatDegrees(camera.heading)} HDG · ${Math.round(carto.height || 0)}m ALT`
      : 'CAMERA OFFLINE',
    render: render.installed
      ? `${String(render.mode || 'idle').toUpperCase()} · ${render.holds?.length || 0} HOLDS`
      : 'RENDER OFFLINE',
    layers: `${enabledLayers}/${totalLayers || 0} ACTIVE`,
    voice: formattedVoiceState || 'OFF',
    routes: routeReadout,
    assets: readAssetDiagnostics(app),
  };
}

function syncDeveloperDiagnostics(documentRef = globalThis.document) {
  if (!documentRef) return;
  const panel = documentRef.querySelector('#developer-tools-panel');
  if (!panel) return;
  const diagnostics = readLiveDiagnostics();
  const entries = {
    camera: panel.querySelector('#developer-camera-readout'),
    render: panel.querySelector('#developer-render-readout'),
    layers: panel.querySelector('#developer-layers-readout'),
    voice: panel.querySelector('#developer-voice-readout'),
    routes: panel.querySelector('#developer-routes-readout'),
  };
  for (const [key, node] of Object.entries(entries)) {
    if (!node) continue;
    node.textContent =
      typeof diagnostics[key] === 'string'
        ? diagnostics[key] || '—'
        : diagnostics[key]?.text || '—';
    if (key === 'routes') node.title = diagnostics.routes?.title || '';
  }
  const assetsList = panel.querySelector('#developer-assets-list');
  if (assetsList && documentRef.createElement) {
    assetsList.replaceChildren();
    for (const asset of diagnostics.assets) {
      const row = documentRef.createElement('div');
      row.className = 'developer-asset-row';
      const identity = documentRef.createElement('span');
      identity.className = 'developer-asset-identity';
      identity.textContent = `${asset.icon} ${asset.name}`;
      const count = documentRef.createElement('strong');
      count.textContent = `${asset.inView ?? '—'} IN VIEW / ${asset.loaded} LOADED`;
      const source = documentRef.createElement('small');
      source.className = `developer-asset-source is-${asset.source.statusState}`;
      const statusIcon = documentRef.createElement('span');
      statusIcon.className = 'developer-source-status-icon';
      statusIcon.textContent = asset.source.statusIcon;
      statusIcon.title = asset.source.summary;
      statusIcon.setAttribute?.('aria-hidden', 'true');
      const sourceSummary = documentRef.createElement('span');
      sourceSummary.textContent = asset.source.summary;
      source.append(statusIcon, sourceSummary);
      row.append(identity, count, source);
      if (asset.source.detail) {
        const detail = documentRef.createElement('small');
        detail.className = 'developer-asset-detail';
        detail.textContent = asset.source.detail;
        row.append(detail);
      }
      assetsList.append(row);
    }
  }
}

/** Bind the persisted switch and developer-only surfaces. */
export function initDeveloperMode({
  storage,
  documentRef = globalThis.document,
} = {}) {
  const toggle = documentRef?.querySelector('#developer-mode-toggle');
  const analyst = documentRef?.querySelector('#analyst-console');
  const panel = documentRef?.querySelector('#developer-tools-panel');
  const exportButton = documentRef?.querySelector(
    '#developer-diagnostics-export',
  );
  if (!toggle || !analyst || !panel) return null;

  const deriveEnabledState = () =>
    Boolean(toggle.checked) || readDeveloperMode(storage);

  const body = documentRef?.body || documentRef?.querySelector?.('body');
  if (
    panel.parentElement &&
    panel.parentElement.id === 'command-dock' &&
    body
  ) {
    panel.remove();
    body.appendChild(panel);
  }

  let refreshTimer = null;
  const refresh = () => {
    if (!toggle.checked) return;
    syncDeveloperDiagnostics(documentRef);
  };

  const apply = (enabled) => {
    const active = Boolean(enabled);
    toggle.checked = active;
    toggle.setAttribute('aria-checked', String(active));
    analyst.hidden = !active;
    analyst.classList.toggle('developer-only', active);
    panel.hidden = !active;
    panel.classList.toggle('developer-only', active);
    documentRef.documentElement.classList.toggle('developer-mode', active);
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    if (active) {
      refresh();
      refreshTimer = globalThis.setInterval(refresh, 1000);
    }
  };
  const onChange = () => {
    writeDeveloperMode(toggle.checked, storage);
    apply(toggle.checked);
  };
  const onExport = () => downloadDeveloperDiagnostics({ documentRef });

  toggle.addEventListener('change', onChange);
  exportButton?.addEventListener('click', onExport);
  apply(deriveEnabledState());

  return {
    enabled: () => toggle.checked,
    refresh,
    destroy() {
      if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
      }
      toggle.removeEventListener('change', onChange);
      exportButton?.removeEventListener('click', onExport);
    },
  };
}
