import * as Cesium from 'cesium';
import { clampTransitRouteBounds } from './routeSource.js';

export const TRANSIT_ROUTE_MAX_ALTITUDE_M = 500_000;

const MIN_VIEW_SPAN_DEG = 0.1;
const QUERY_GRID_DEG = 0.01;
const ROUTE_CACHE_TTL_MS = 6 * 60 * 60_000;
const FAILURE_RETRY_MS = 30_000;
const ROUTE_REUSE_MARGIN_DEG = 0.05;
const ROUTE_UNLOAD_MARGIN_DEG = 0.15;
const OUTLINE_WIDTH = 5;
const ROUTE_WIDTH = 3.5;
const ROUTE_OUTLINE_Z_INDEX = 20;
const ROUTE_LINE_Z_INDEX = 21;
const ROUTE_HANDOFF_HOLD_MS = 220;
const MAX_SECTION_VERTICES = 128;
const STATION_PIXEL_SIZE = 9;
const STATION_LABEL_MAX_DISTANCE_M = 150_000;
const STATION_LIST_MAX_ALTITUDE_M = 5_000;
const STATION_MATCH_DISTANCE_DEG = 0.003;
const STATION_EYE_OFFSET_M = -100;
const MAX_VERTEX_TURN_DEG = 24;
const CORNER_CUT_FRACTION = 0.28;

export function smoothTransitRouteLine(line) {
  if (!Array.isArray(line) || line.length < 3) return line || [];
  const maxTurn = (MAX_VERTEX_TURN_DEG * Math.PI) / 180;
  const smoothed = [line[0]];
  for (let index = 1; index < line.length - 1; index += 1) {
    const previous = line[index - 1];
    const current = line[index];
    const next = line[index + 1];
    const incoming = [current[0] - previous[0], current[1] - previous[1]];
    const outgoing = [next[0] - current[0], next[1] - current[1]];
    const incomingLength = Math.hypot(incoming[0], incoming[1]);
    const outgoingLength = Math.hypot(outgoing[0], outgoing[1]);
    if (!incomingLength || !outgoingLength) continue;
    const cosine = Math.max(
      -1,
      Math.min(
        1,
        (incoming[0] * outgoing[0] + incoming[1] * outgoing[1]) /
          (incomingLength * outgoingLength),
      ),
    );
    const turn = Math.acos(cosine);
    if (turn <= maxTurn) {
      smoothed.push(current);
      continue;
    }
    const cut = Math.min(incomingLength, outgoingLength) * CORNER_CUT_FRACTION;
    const before = [
      current[0] - (incoming[0] / incomingLength) * cut,
      current[1] - (incoming[1] / incomingLength) * cut,
    ];
    const after = [
      current[0] + (outgoing[0] / outgoingLength) * cut,
      current[1] + (outgoing[1] / outgoingLength) * cut,
    ];
    smoothed.push(before);
    const segments = Math.max(2, Math.ceil(turn / maxTurn));
    for (let step = 1; step < segments; step += 1) {
      const t = step / segments;
      const inverse = 1 - t;
      smoothed.push([
        inverse * inverse * before[0] +
          2 * inverse * t * current[0] +
          t * t * after[0],
        inverse * inverse * before[1] +
          2 * inverse * t * current[1] +
          t * t * after[1],
      ]);
    }
    smoothed.push(after);
  }
  smoothed.push(line.at(-1));
  return smoothed;
}

function stationNameKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const ROUTE_COLOR_NAME =
  /^(red|orange|yellow|green|blue|purple|pink|brown|silver|gold)$/i;
const ROUTE_COLOR_LINE_NAME =
  /^(red|orange|yellow|green|blue|purple|pink|brown|silver|gold)\s+line$/i;

function compactRouteRef(ref) {
  const tokens = String(ref || '')
    .split(/[\s,;/]+/)
    .filter(Boolean);
  return (
    tokens.length > 0 &&
    tokens.every((token) => {
      const parts = token.split('-').filter(Boolean);
      const candidate = parts.at(-1) || token;
      return /^[a-z0-9]{1,3}$/i.test(candidate);
    })
  );
}

function namedStationLine(route) {
  const name = String(route?.name || '').trim();
  const ref = String(route?.ref || '').trim();
  if (ROUTE_COLOR_LINE_NAME.test(name)) return null;
  if (ref && compactRouteRef(ref)) return null;
  if (/\b(line|railway|rail)\b/i.test(name)) return name;
  const refName = ref
    .replace(/^cr[-_:]?/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  if (route?.type === 'train' && (name || refName))
    return `${name || refName} Line`;
  return null;
}

function stationBadgeText(route) {
  const raw = String(route?.ref || route?.name || '').trim();
  if (namedStationLine(route)) return [];
  const colors = ROUTE_COLOR_NAME;
  const values = raw
    .split(/[\s,;/]+/)
    .filter(Boolean)
    .map((token) => {
      const parts = token.split('-').filter(Boolean);
      const candidate = parts.at(-1) || token;
      if (
        colors.test(candidate) ||
        colors.test(token) ||
        /^(line|route|service)$/i.test(candidate)
      )
        return '';
      return candidate.replace(/[^a-z0-9]/gi, '').slice(0, 4);
    })
    .filter((value) => value !== '')
    .slice(0, 4);
  return values.length || !route?.color ? values : [''];
}

function stationBadgeImage(text, color) {
  const safeText = String(text).replace(/[&<>"']/g, (character) => {
    const entities = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&apos;',
    };
    return entities[character];
  });
  const safeColor = /^#[\da-f]{6}$/i.test(color || '') ? color : '#00D4FF';
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28"><circle cx="14" cy="14" r="12" fill="${safeColor}" stroke="#fff" stroke-width="2"/><text x="14" y="14" dy=".35em" fill="#fff" font-family="Arial,sans-serif" font-size="13" font-weight="700" text-anchor="middle">${safeText}</text></svg>`,
  )}`;
}

/** Merge route stops that describe one physical station. */
export function groupTransitStations(routes) {
  const groups = [];
  const byStopId = new Map();
  const byName = new Map();
  for (const route of routes || []) {
    for (const stop of route?.stops || []) {
      if (!stop?.id || !Number.isFinite(stop.lat) || !Number.isFinite(stop.lon))
        continue;
      const name = String(stop.name || '').trim();
      const nameKey = stationNameKey(name);
      const named = nameKey ? byName.get(nameKey) || [] : [];
      let group = byStopId.get(String(stop.id));
      let isNewGroup = false;
      if (!group && named.length) {
        group = named.find(
          (candidate) =>
            Math.abs(candidate.lat - stop.lat) <= STATION_MATCH_DISTANCE_DEG &&
            Math.abs(candidate.lon - stop.lon) <= STATION_MATCH_DISTANCE_DEG,
        );
      }
      if (!group) {
        isNewGroup = true;
        group = {
          id: nameKey
            ? `name:${nameKey}:${groups.length}`
            : `id:${String(stop.id)}`,
          name: name || null,
          lat: Number(stop.lat),
          lon: Number(stop.lon),
          _latSum: Number(stop.lat),
          _lonSum: Number(stop.lon),
          _sampleCount: 1,
          routeIds: [],
          routeRefs: [],
          badges: [],
          lineEntries: [],
          colors: [],
        };
        groups.push(group);
        if (nameKey) named.push(group);
      }
      if (!isNewGroup) {
        group._latSum += Number(stop.lat);
        group._lonSum += Number(stop.lon);
        group._sampleCount += 1;
      }
      group.lat = group._latSum / group._sampleCount;
      group.lon = group._lonSum / group._sampleCount;
      byStopId.set(String(stop.id), group);
      if (nameKey) byName.set(nameKey, named);
      if (!group.name && name) group.name = name;
      if (!group.routeIds.includes(route.routeId))
        group.routeIds.push(route.routeId);
      const ref = String(route.ref || route.name || route.routeId || '').trim();
      if (ref && !group.routeRefs.includes(ref)) group.routeRefs.push(ref);
      const lineName = namedStationLine(route);
      if (
        lineName &&
        !group.lineEntries.some(
          (entry) => entry.label === lineName && entry.color === route.color,
        )
      )
        group.lineEntries.push({ label: lineName, color: route.color });
      for (const text of stationBadgeText(route)) {
        const badgeKey = `${text}:${route.color || ''}`;
        if (!group.badges.some((badge) => badge.key === badgeKey))
          group.badges.push({ key: badgeKey, text, color: route.color });
      }
      if (route.color && !group.colors.includes(route.color))
        group.colors.push(route.color);
    }
  }
  return groups.map((group) => {
    delete group._latSum;
    delete group._lonSum;
    delete group._sampleCount;
    return group;
  });
}

function stableQueryBounds(bounds) {
  const safe = clampTransitRouteBounds(bounds);
  const centerLat = (safe.south + safe.north) / 2;
  const centerLon = (safe.west + safe.east) / 2;
  const halfLat = Math.max(MIN_VIEW_SPAN_DEG, safe.north - safe.south) / 2;
  const halfLon = Math.max(MIN_VIEW_SPAN_DEG, safe.east - safe.west) / 2;
  const floor = (value) => Math.floor(value / QUERY_GRID_DEG) * QUERY_GRID_DEG;
  const ceil = (value) => Math.ceil(value / QUERY_GRID_DEG) * QUERY_GRID_DEG;
  const rounded = {
    south: Math.max(-90, floor(centerLat - halfLat)),
    west: Math.max(-180, floor(centerLon - halfLon)),
    north: Math.min(90, ceil(centerLat + halfLat)),
    east: Math.min(180, ceil(centerLon + halfLon)),
  };
  if (rounded.north - rounded.south > 1 || rounded.east - rounded.west > 1)
    return safe;
  return clampTransitRouteBounds(rounded);
}

function routeBoundsKey(bounds) {
  return [bounds.south, bounds.west, bounds.north, bounds.east]
    .map((value) => value.toFixed(3))
    .join(',');
}

function boundsContain(outer, inner) {
  const epsilon = 1e-6;
  return (
    outer &&
    inner &&
    outer.south <= inner.south + epsilon &&
    outer.west <= inner.west + epsilon &&
    outer.north >= inner.north - epsilon &&
    outer.east >= inner.east - epsilon
  );
}

function boundsContainWithMargin(outer, inner, margin) {
  if (!outer || !inner) return false;
  return (
    outer.south - margin <= inner.south &&
    outer.west - margin <= inner.west &&
    outer.north + margin >= inner.north &&
    outer.east + margin >= inner.east
  );
}

function boundsOverlapWithMargin(a, b, margin) {
  if (!a || !b) return true;
  return !(
    a.north + margin < b.south ||
    a.south - margin > b.north ||
    a.east + margin < b.west ||
    a.west - margin > b.east
  );
}

const routePositionCache = new WeakMap();

function routePositions(line) {
  const cached = routePositionCache.get(line);
  if (cached) return cached;
  const positions = line.map(([lon, lat]) =>
    Cesium.Cartesian3.fromDegrees(lon, lat),
  );
  routePositionCache.set(line, positions);
  return positions;
}

function sectionRoutePositions(line, getHeight) {
  const section = line;
  const samples = [
    section[0],
    section[Math.floor(section.length / 2)],
    section.at(-1),
  ]
    .filter(Boolean)
    .map(([lon, lat]) => getHeight(lat, lon))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const height = samples.length ? samples[Math.floor(samples.length / 2)] : 0;
  return section.map(([lon, lat]) =>
    Cesium.Cartesian3.fromDegrees(lon, lat, height),
  );
}

function simplifyRouteSection(line) {
  if (line.length <= MAX_SECTION_VERTICES) return line;
  const step = (line.length - 1) / (MAX_SECTION_VERTICES - 1);
  const section = [];
  for (let index = 0; index < MAX_SECTION_VERTICES; index += 1)
    section.push(line[Math.round(index * step)]);
  return section;
}

async function yieldRouteBuild() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Own viewport-loaded OSM rail-route geometry for one Transit layer. */
export function createTransitRouteLines({
  routeSource,
  getRouteHeight = () => 0,
  onSelectRoute = () => {},
  onRoutesUpdated = () => {},
  onStationsUpdated = () => {},
}) {
  if (typeof routeSource?.requestRoutes !== 'function')
    throw new TypeError('A transit-route source is required');

  let viewer = null;
  let enabled = false;
  let visible = false;
  let generation = 0;
  let abortController = null;
  let lastBoundsKey = null;
  let lastUpdate = 0;
  let lastRequestedAt = null;
  let lastStatus = null;
  let lastCache = null;
  let lastUpstream = null;
  let lastBounds = null;
  let lastFailureAt = 0;
  let lastFailureKey = null;
  let requestKey = null;
  let requestBounds = null;
  let requestStage = null;
  let coverageBounds = null;
  let prefetching = false;
  let routes = [];
  let loading = false;
  let error = null;
  let primitives = [];
  let entities = [];
  let spacePrimitives = [];
  let stationOverlayCollections = [];
  let stationListItems = [];
  let pendingReplacement = null;
  let postRenderRemove = null;
  let cameraChangedRemove = null;
  let densityChangedRemove = null;
  let stationDensityPct = 50;
  const routeHeightCache = new Map();
  const routeSectionCache = new Map();
  let selectedRouteId = null;
  const routePickTargets = new Map();

  function removeGeometry() {
    for (const primitive of primitives)
      viewer?.scene?.groundPrimitives?.remove(primitive);
    for (const entity of entities) viewer?.entities?.remove(entity);
    for (const primitive of spacePrimitives)
      viewer?.scene?.primitives?.remove(primitive);
    for (const collection of stationOverlayCollections)
      viewer?.scene?.primitives?.remove(collection);
    primitives = [];
    entities = [];
    spacePrimitives = [];
    stationOverlayCollections = [];
    stationListItems = [];
  }

  function syncStationListVisibility() {
    const camera = viewer?.camera;
    const worldPosition = camera?.positionWC;
    const cartographic = worldPosition
      ? Cesium.Cartographic.fromCartesian(
          worldPosition,
          Cesium.Ellipsoid.WGS84,
          new Cesium.Cartographic(),
        )
      : camera?.positionCartographic;
    const height = Number(cartographic?.height);
    const altitudeVisible =
      !Number.isFinite(height) || height <= STATION_LIST_MAX_ALTITUDE_M;
    const showNames = visible && stationDensityPct >= 25;
    const showList = visible && altitudeVisible && stationDensityPct >= 50;
    for (const item of stationListItems) {
      if (item.isStationName) {
        const stationNameLabel = item.stationNameLabel || item.entity?.label;
        if (stationNameLabel) stationNameLabel.show = showNames;
        if (stationNameLabel && item.expandedOffset !== undefined)
          stationNameLabel.pixelOffset = new Cesium.Cartesian2(
            0,
            showList ? item.expandedOffset : -16,
          );
        continue;
      }
      if (item.billboard) item.billboard.show = showList;
      if (item.label) item.label.show = showList;
      if (item.entity?.billboard) item.entity.billboard.show = showList;
      if (item.entity?.label) item.entity.label.show = showList;
    }
  }

  function stableRouteHeight(lat, lon) {
    const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
    if (!routeHeightCache.has(key))
      routeHeightCache.set(key, getRouteHeight(lat, lon));
    return routeHeightCache.get(key);
  }

  function routeSection(route, index) {
    const line = route.lines[index];
    const first = line[0] || [];
    const last = line.at(-1) || [];
    const key = `${route.routeId}:${route.id}:${index}:${line.length}:${first[0]}:${first[1]}:${last[0]}:${last[1]}`;
    let section = routeSectionCache.get(key);
    if (!section) {
      section = smoothTransitRouteLine(simplifyRouteSection(line));
      routeSectionCache.set(key, section);
    }
    return section;
  }

  function raiseRouteLinesToTop() {
    const collection = viewer?.scene?.groundPrimitives;
    for (const primitive of primitives)
      if (primitive) collection?.raiseToTop?.(primitive);
  }

  async function makeInstances(items, width, pickTargets, isCurrent) {
    const instances = [];
    for (const route of items) {
      for (let index = 0; index < route.lines.length; index++) {
        if (!isCurrent())
          throw Object.assign(new Error('Route build superseded'), {
            name: 'AbortError',
          });
        const positions = routePositions(routeSection(route, index));
        if (positions.length < 2) continue;
        const id = `transit-route:${route.routeId}:${route.id}:${index}:${width}`;
        pickTargets.set(id, route.routeId);
        instances.push(
          new Cesium.GeometryInstance({
            id,
            geometry: new Cesium.GroundPolylineGeometry({ positions, width }),
          }),
        );
      }
      if (instances.length % 64 === 0) await yieldRouteBuild();
    }
    return instances;
  }

  async function addGroundPrimitive(
    items,
    width,
    cssColor,
    pickTargets,
    isCurrent,
  ) {
    const instances = await makeInstances(items, width, pickTargets, isCurrent);
    if (!instances.length) return null;
    const primitive = new Cesium.GroundPolylinePrimitive({
      geometryInstances: instances,
      appearance: new Cesium.PolylineMaterialAppearance({
        // Glow (not solid Color) reads as light shining through geometry rather
        // than a line painted on it — routes passing under Google 3D buildings.
        material: Cesium.Material.fromType('PolylineGlow', {
          color: Cesium.Color.fromCssColorString(cssColor).withAlpha(0.9),
          glowPower: 0.22,
        }),
      }),
      // Same fix as tunnels/index.js: BOTH paints routes up building facades
      // under Google 3D; GLOBE classification should handle visibility in 3D mode.
      classificationType: Cesium.ClassificationType.GLOBE,
      allowPicking: true,
      asynchronous: true,
      show: false,
    });
    return viewer.scene.groundPrimitives.add(primitive);
  }

  async function addFallbackLines(
    items,
    width,
    cssColor,
    pickTargets,
    isCurrent,
  ) {
    const material = Cesium.Color.fromCssColorString(cssColor);
    const created = [];
    for (const route of items) {
      for (let index = 0; index < route.lines.length; index++) {
        if (!isCurrent())
          throw Object.assign(new Error('Route build superseded'), {
            name: 'AbortError',
          });
        const positions = routePositions(routeSection(route, index));
        if (positions.length < 2) continue;
        const id = `transit-route:${route.routeId}:${route.id}:${index}:${width}`;
        pickTargets.set(id, route.routeId);
        created.push(
          viewer.entities.add({
            id,
            polyline: {
              positions,
              width,
              material,
              clampToGround: true,
              // Terrain only, never draped onto 3D tile buildings.
              classificationType: Cesium.ClassificationType.TERRAIN,
              zIndex:
                width === OUTLINE_WIDTH
                  ? ROUTE_OUTLINE_Z_INDEX
                  : ROUTE_LINE_Z_INDEX,
            },
          }),
        );
      }
      if (created.length % 64 === 0) await yieldRouteBuild();
    }
    return created;
  }

  // With the globe hidden (Google 3D) the globe pass never runs, so a
  // GroundPolylinePrimitive draws nothing at all. Real-space primitives
  // depth-test against the tileset; keeping the depth-fail pass disabled is
  // important because its translucent under-building glow can paint over the
  // station labels and line badges.
  async function addSpacePrimitive(
    items,
    width,
    cssColor,
    pickTargets,
    isCurrent,
  ) {
    const color = Cesium.Color.fromCssColorString(cssColor);
    const glowColor = color.withAlpha(0.06);
    const instances = [];
    const useDepthFailGlow =
      width === OUTLINE_WIDTH &&
      items.every((route) => (route.stops || []).length === 0);
    for (const route of items) {
      for (let index = 0; index < route.lines.length; index++) {
        if (!isCurrent())
          throw Object.assign(new Error('Route build superseded'), {
            name: 'AbortError',
          });
        const positions = sectionRoutePositions(
          routeSection(route, index),
          stableRouteHeight,
        );
        if (positions.length < 2) continue;
        const id = `transit-route:${route.routeId}:${route.id}:${index}:${width}`;
        pickTargets.set(id, route.routeId);
        instances.push(
          new Cesium.GeometryInstance({
            id,
            geometry: new Cesium.PolylineGeometry({
              positions,
              width,
              arcType: Cesium.ArcType.NONE,
              vertexFormat: Cesium.PolylineMaterialAppearance.VERTEX_FORMAT,
            }),
          }),
        );
      }
      if (instances.length % 64 === 0) await yieldRouteBuild();
    }
    if (!instances.length) return [];
    const primitive = new Cesium.Primitive({
      geometryInstances: instances,
      appearance: new Cesium.PolylineMaterialAppearance({
        material: Cesium.Material.fromType('Color', { color }),
      }),
      ...(useDepthFailGlow
        ? {
            depthFailAppearance: new Cesium.PolylineMaterialAppearance({
              material: Cesium.Material.fromType('PolylineGlow', {
                color: glowColor,
                glowPower: 0.8,
              }),
            }),
          }
        : {}),
      asynchronous: true,
      allowPicking: true,
      show: false,
    });
    return [viewer.scene.primitives.add(primitive)];
  }

  function addStationEntities(
    items,
    nextEntities,
    nextStationCollections,
    nextStationListItems,
    pickTargets,
    isCurrent,
  ) {
    const overlay =
      viewer?.scene?.primitives?.add &&
      typeof Cesium.BillboardCollection === 'function' &&
      typeof Cesium.LabelCollection === 'function'
        ? {
            billboards: new Cesium.BillboardCollection(),
            labels: new Cesium.LabelCollection(),
          }
        : null;
    if (overlay) {
      viewer.scene.primitives.add(overlay.billboards);
      viewer.scene.primitives.add(overlay.labels);
      overlay.billboards.show = false;
      overlay.labels.show = false;
      nextStationCollections.push(overlay.billboards, overlay.labels);
    }
    for (const station of groupTransitStations(items)) {
      if (!isCurrent())
        throw Object.assign(new Error('Route build superseded'), {
          name: 'AbortError',
        });
      const id = `transit-station:${station.id}`;
      // A station is one selectable object even when several routes share it.
      // The first route keeps the existing route-selection contract; the label
      // and properties expose the complete group to the UI and diagnostics.
      pickTargets.set(id, station.routeIds[0]);
      const colors = station.colors.map((color) =>
        Cesium.Color.fromCssColorString(color),
      );
      const outlineColor = colors.length
        ? Cesium.Color.fromBytes(
            Math.round(
              (colors.reduce((sum, color) => sum + color.red, 0) /
                colors.length) *
                255,
            ),
            Math.round(
              (colors.reduce((sum, color) => sum + color.green, 0) /
                colors.length) *
                255,
            ),
            Math.round(
              (colors.reduce((sum, color) => sum + color.blue, 0) /
                colors.length) *
                255,
            ),
          )
        : Cesium.Color.WHITE;
      const stationPosition = Cesium.Cartesian3.fromDegrees(
        station.lon,
        station.lat,
      );
      const stationLabelOffset = station.lineEntries.length
        ? -44 - station.lineEntries.length * 18
        : -30;
      const compactBadgeY = station.lineEntries.length ? -20 : -14;
      const stationLabel = station.name
        ? {
            id,
            position: stationPosition,
            text: station.name,
            font: '11px sans-serif',
            fillColor: Cesium.Color.WHITE,
            showBackground: true,
            backgroundColor: Cesium.Color.BLACK.withAlpha(0.65),
            // Keep the station name above the line rows and marker.
            pixelOffset: new Cesium.Cartesian2(0, stationLabelOffset),
            eyeOffset: new Cesium.Cartesian3(0, 0, STATION_EYE_OFFSET_M),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
              0,
              STATION_LABEL_MAX_DISTANCE_M,
            ),
          }
        : null;
      const stationEntity = viewer.entities.add({
        id,
        position: stationPosition,
        properties: {
          routeIds: station.routeIds,
          routeRefs: station.routeRefs,
        },
        point: {
          pixelSize: Math.min(
            16,
            STATION_PIXEL_SIZE + Math.max(0, station.routeIds.length - 1) * 3,
          ),
          color: Cesium.Color.WHITE,
          outlineColor,
          outlineWidth: station.routeIds.length > 1 ? 3 : 2,
          eyeOffset: new Cesium.Cartesian3(0, 0, STATION_EYE_OFFSET_M),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: overlay ? undefined : stationLabel,
      });
      nextEntities.push(stationEntity);
      if (overlay && stationLabel) {
        const stationNameLabel = overlay.labels.add(stationLabel);
        nextStationListItems.push({
          isStationName: true,
          stationNameLabel,
          expandedOffset: stationLabelOffset,
        });
      } else if (stationLabel) {
        nextStationListItems.push({
          isStationName: true,
          entity: stationEntity,
          expandedOffset: stationLabelOffset,
        });
      }
      const badgeCount = station.badges.length;
      station.badges.forEach((badge, index) => {
        const badgeId = `${id}:badge:${index}`;
        pickTargets.set(badgeId, station.routeIds[0]);
        const billboard = {
          id: badgeId,
          position: stationPosition,
          image: stationBadgeImage(badge.text, badge.color),
          width: 24,
          height: 24,
          pixelOffset: new Cesium.Cartesian2(
            (index - (badgeCount - 1) / 2) * 24,
            compactBadgeY,
          ),
          eyeOffset: new Cesium.Cartesian3(0, 0, STATION_EYE_OFFSET_M),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        };
        if (overlay) {
          const billboardInstance = overlay.billboards.add(billboard);
          nextStationListItems.push({ billboard: billboardInstance });
        } else {
          const entity = viewer.entities.add({
            id: badgeId,
            position: stationPosition,
            billboard,
          });
          nextEntities.push(entity);
          nextStationListItems.push({ entity });
        }
      });
      station.lineEntries.forEach((entry, index) => {
        const rowY = -44 - index * 18;
        const badgeId = `${id}:line:${index}`;
        pickTargets.set(badgeId, station.routeIds[0]);
        const billboard = {
          id: badgeId,
          position: stationPosition,
          image: stationBadgeImage('', entry.color),
          width: 16,
          height: 16,
          pixelOffset: new Cesium.Cartesian2(-48, rowY),
          eyeOffset: new Cesium.Cartesian3(0, 0, STATION_EYE_OFFSET_M),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        };
        const label = {
          id: `${badgeId}:label`,
          position: stationPosition,
          text: entry.label,
          font: '10px sans-serif',
          fillColor: Cesium.Color.WHITE,
          showBackground: true,
          backgroundColor: Cesium.Color.BLACK.withAlpha(0.65),
          horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
          pixelOffset: new Cesium.Cartesian2(-36, rowY),
          eyeOffset: new Cesium.Cartesian3(0, 0, STATION_EYE_OFFSET_M),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        };
        if (overlay) {
          const billboardInstance = overlay.billboards.add(billboard);
          const labelInstance = overlay.labels.add(label);
          nextStationListItems.push({
            billboard: billboardInstance,
            label: labelInstance,
          });
        } else {
          const entity = viewer.entities.add({
            id: badgeId,
            position: stationPosition,
            billboard,
            label,
          });
          nextEntities.push(entity);
          nextStationListItems.push({ entity });
        }
      });
    }
  }

  function removeReplacement(replacement) {
    for (const primitive of replacement?.primitives || [])
      viewer?.scene?.groundPrimitives?.remove(primitive);
    for (const entity of replacement?.entities || [])
      viewer?.entities?.remove(entity);
    for (const primitive of replacement?.spacePrimitives || [])
      viewer?.scene?.primitives?.remove(primitive);
    for (const collection of replacement?.stationCollections || [])
      viewer?.scene?.primitives?.remove(collection);
  }

  function commitRoutes(replacement) {
    const previousPrimitives = primitives;
    const previousEntities = entities;
    const previousSpace = spacePrimitives;
    const previousStationCollections = stationOverlayCollections;
    primitives = replacement.primitives;
    entities = replacement.entities;
    spacePrimitives = replacement.spacePrimitives || [];
    stationOverlayCollections = replacement.stationCollections || [];
    stationListItems = replacement.stationListItems || [];
    syncStationListVisibility();
    routes = replacement.routes;
    routePickTargets.clear();
    for (const [id, routeId] of replacement.pickTargets)
      routePickTargets.set(id, routeId);
    pendingReplacement = null;
    for (const primitive of primitives) primitive.show = visible;
    for (const entity of entities) entity.show = visible;
    for (const primitive of spacePrimitives) primitive.show = visible;
    for (const collection of stationOverlayCollections)
      collection.show = visible;
    setTimeout(() => {
      for (const primitive of previousPrimitives)
        viewer?.scene?.groundPrimitives?.remove(primitive);
      for (const entity of previousEntities) viewer?.entities?.remove(entity);
      for (const primitive of previousSpace)
        viewer?.scene?.primitives?.remove(primitive);
      for (const collection of previousStationCollections)
        viewer?.scene?.primitives?.remove(collection);
    }, ROUTE_HANDOFF_HOLD_MS);
    raiseRouteLinesToTop();
    onStationsUpdated(groupTransitStations(routes));
    onRoutesUpdated();
    viewer?.scene?.requestRender?.();
  }

  function promoteReadyReplacement() {
    if (!pendingReplacement) return;
    // Entities and real-space primitives commit immediately: their own `show`
    // flag governs visibility and a not-yet-ready Primitive simply draws
    // nothing until it is, so there's no old-geometry gap to guard against.
    // Only the in-place GroundPolylinePrimitive replacement needs the
    // ready-gate so the current routes don't blank while their successors build.
    if (!pendingReplacement.primitives.length) {
      commitRoutes(pendingReplacement);
      return;
    }
    if (!primitives.length && !entities.length && !spacePrimitives.length) {
      commitRoutes(pendingReplacement);
      return;
    }
    if (
      pendingReplacement.primitives.some(
        (primitive) => primitive.ready !== true,
      )
    )
      return;
    commitRoutes(pendingReplacement);
  }

  async function replaceRoutes(nextRoutes, isCurrent = () => true) {
    const nextPrimitives = [];
    const nextEntities = [];
    const nextSpacePrimitives = [];
    const nextStationCollections = [];
    const nextStationListItems = [];
    const nextPickTargets = new Map();
    // With the globe hidden (Google 3D) the globe pass never runs, so a
    // GroundPolylinePrimitive draws nothing at all. Real-space primitives
    // depth-test against the tileset. A restrained depth-fail glow is kept only
    // on the thin outline and only for routes without station overlays; the
    // route core remains depth-tested so the glow cannot wash over transit
    // markers, station labels, or line lists.
    const globeHidden = viewer?.scene?.globe?.show === false;
    let canUseGround = false;
    try {
      canUseGround =
        !globeHidden &&
        !!viewer?.scene?.context &&
        !!viewer.scene.groundPrimitives?.add &&
        typeof Cesium.GroundPolylinePrimitive.isSupported === 'function' &&
        Cesium.GroundPolylinePrimitive.isSupported(viewer.scene);
    } catch {
      canUseGround = false;
    }
    const byColor = new Map();
    for (const route of nextRoutes) {
      if (!byColor.has(route.color)) byColor.set(route.color, []);
      byColor.get(route.color).push(route);
    }
    try {
      if (globeHidden) {
        for (const [color, group] of byColor) {
          nextSpacePrimitives.push(
            ...(await addSpacePrimitive(
              group,
              OUTLINE_WIDTH,
              color,
              nextPickTargets,
              isCurrent,
            )),
          );
        }
        for (const route of nextRoutes)
          nextSpacePrimitives.push(
            ...(await addSpacePrimitive(
              [route],
              ROUTE_WIDTH,
              route.color,
              nextPickTargets,
              isCurrent,
            )),
          );
      } else if (canUseGround) {
        for (const [color, group] of byColor) {
          const outline = await addGroundPrimitive(
            group,
            OUTLINE_WIDTH,
            color,
            nextPickTargets,
            isCurrent,
          );
          if (outline) nextPrimitives.push(outline);
          const primitive = await addGroundPrimitive(
            group,
            ROUTE_WIDTH,
            color,
            nextPickTargets,
            isCurrent,
          );
          if (primitive) nextPrimitives.push(primitive);
        }
      } else {
        for (const [color, group] of byColor)
          nextEntities.push(
            ...(await addFallbackLines(
              group,
              OUTLINE_WIDTH,
              color,
              nextPickTargets,
              isCurrent,
            )),
          );
        for (const route of nextRoutes)
          nextEntities.push(
            ...(await addFallbackLines(
              [route],
              ROUTE_WIDTH,
              route.color,
              nextPickTargets,
              isCurrent,
            )),
          );
      }
      addStationEntities(
        nextRoutes,
        nextEntities,
        nextStationCollections,
        nextStationListItems,
        nextPickTargets,
        isCurrent,
      );
    } catch (caught) {
      for (const primitive of nextPrimitives)
        viewer?.scene?.groundPrimitives?.remove(primitive);
      for (const entity of nextEntities) viewer?.entities?.remove(entity);
      for (const primitive of nextSpacePrimitives)
        viewer?.scene?.primitives?.remove(primitive);
      for (const collection of nextStationCollections)
        viewer?.scene?.primitives?.remove(collection);
      throw caught;
    }

    if (!isCurrent()) {
      for (const collection of nextStationCollections)
        viewer?.scene?.primitives?.remove(collection);
      return false;
    }
    const replacement = {
      primitives: nextPrimitives,
      entities: nextEntities,
      spacePrimitives: nextSpacePrimitives,
      stationCollections: nextStationCollections,
      stationListItems: nextStationListItems,
      routes: nextRoutes,
      pickTargets: nextPickTargets,
    };
    removeReplacement(pendingReplacement);
    pendingReplacement = replacement;
    if (!primitives.length && !entities.length && !spacePrimitives.length) {
      if (!nextPrimitives.length && !nextSpacePrimitives.length)
        commitRoutes(replacement);
      else {
        for (const primitive of nextPrimitives) primitive.show = visible;
        for (const primitive of nextSpacePrimitives) primitive.show = visible;
        promoteReadyReplacement();
      }
    } else promoteReadyReplacement();
    viewer?.scene?.requestRender?.();
    return true;
  }

  function applyVisibility(next) {
    visible = enabled && next === true;
    for (const primitive of primitives) primitive.show = visible;
    for (const entity of entities) entity.show = visible;
    for (const primitive of spacePrimitives) primitive.show = visible;
    for (const collection of stationOverlayCollections)
      collection.show = visible;
    onStationsUpdated(visible ? groupTransitStations(routes) : []);
    syncStationListVisibility();
    for (const primitive of pendingReplacement?.primitives || [])
      primitive.show = false;
    for (const primitive of pendingReplacement?.spacePrimitives || [])
      primitive.show = false;
    if (visible) {
      raiseRouteLinesToTop();
      viewer?.scene?.requestRender?.();
    }
  }

  function setVisible(next) {
    applyVisibility(next);
  }

  function routeForId(routeId) {
    const segments = routes.filter((route) => route.routeId === routeId);
    if (!segments.length) return null;
    const stops = new Map();
    for (const stop of segments.flatMap((segment) => segment.stops || [])) {
      if (!stops.has(stop.id)) stops.set(stop.id, stop);
    }
    return {
      ...segments[0],
      id: routeId,
      lines: segments.flatMap((segment) => segment.lines),
      stops: [...stops.values()],
    };
  }

  function unloadRoutes() {
    removeReplacement(pendingReplacement);
    pendingReplacement = null;
    removeGeometry();
    routes = [];
    routePickTargets.clear();
    routeHeightCache.clear();
    routeSectionCache.clear();
    coverageBounds = null;
    onStationsUpdated([]);
    onRoutesUpdated();
    viewer?.scene?.requestRender?.();
  }

  async function loadBounds(safeBounds, requestGeneration, signal, stage) {
    const key = routeBoundsKey(safeBounds);
    requestKey = key;
    requestBounds = { ...safeBounds };
    requestStage = stage;
    loading = true;
    prefetching = stage === 'prefetch';
    error = null;
    lastRequestedAt = Date.now();
    lastStatus = null;
    lastCache = null;
    lastUpstream = null;
    lastBounds = { ...safeBounds };
    try {
      const response = await routeSource.requestRoutes(safeBounds, { signal });
      lastStatus = response.status;
      lastCache = response.headers?.get?.('x-overpass-cache') || null;
      lastUpstream = response.headers?.get?.('x-overpass-upstream') || null;
      if (!response.ok)
        throw new Error(`Transit route query returned ${response.status}`);
      const payload = await response.json();
      if (!enabled || requestGeneration !== generation || signal.aborted)
        return false;
      const nextRoutes = payload.routes || [];
      if (!nextRoutes.length && routes.length) {
        lastBoundsKey = key;
        lastUpdate = Date.now();
        return true;
      }
      const replaced = await replaceRoutes(
        nextRoutes,
        () => enabled && requestGeneration === generation && !signal.aborted,
      );
      if (!replaced) return false;
      lastBoundsKey = key;
      lastUpdate = Date.now();
      coverageBounds = { ...safeBounds };
      lastFailureKey = null;
      lastFailureAt = 0;
      return true;
    } catch (caught) {
      if (caught?.name !== 'AbortError' && requestGeneration === generation) {
        error = caught?.message || 'Transit routes unavailable';
        lastFailureAt = Date.now();
        lastFailureKey = key;
      }
      return false;
    } finally {
      if (requestGeneration === generation) {
        loading = false;
        prefetching = false;
        requestKey = null;
        requestBounds = null;
        requestStage = null;
      }
    }
  }

  async function update(bounds) {
    if (!enabled || !visible || !bounds) return;
    const priorityBounds = stableQueryBounds(bounds);
    const now = Date.now();

    const coverageFresh =
      coverageBounds && now - lastUpdate < ROUTE_CACHE_TTL_MS;

    if (
      coverageFresh &&
      boundsContainWithMargin(
        coverageBounds,
        priorityBounds,
        ROUTE_REUSE_MARGIN_DEG,
      )
    )
      return;

    if (requestKey) {
      if (
        requestStage === 'priority' &&
        boundsContain(requestBounds, priorityBounds)
      )
        return;
      generation++;
      abortController?.abort();
      requestKey = null;
      requestBounds = null;
      requestStage = null;
      loading = false;
      prefetching = false;
    }

    const priorityKey = routeBoundsKey(priorityBounds);
    if (
      lastFailureKey === priorityKey &&
      now - lastFailureAt < FAILURE_RETRY_MS
    )
      return;

    const requestGeneration = ++generation;
    abortController?.abort();
    abortController = new AbortController();
    const loadedInView = await loadBounds(
      priorityBounds,
      requestGeneration,
      abortController.signal,
      'priority',
    );
    if (!loadedInView || !enabled || requestGeneration !== generation) return;
  }

  function selectFromPick(picked) {
    const candidateIds = [
      typeof picked === 'string' ? picked : null,
      typeof picked?.id === 'string' ? picked.id : null,
      typeof picked?.id?.id === 'string' ? picked.id.id : null,
      typeof picked?.primitive?.id === 'string' ? picked.primitive.id : null,
    ].filter(Boolean);
    const routeId = candidateIds
      .map((id) => routePickTargets.get(id))
      .find(Boolean);
    if (!routeId) return false;
    const route = routeForId(routeId);
    if (!route) return false;
    selectedRouteId = routeId;
    onSelectRoute(route);
    return true;
  }

  function setSelectedRoute(routeId) {
    selectedRouteId = routeId || null;
  }

  function clearSelectedRoute() {
    selectedRouteId = null;
  }

  function disable() {
    enabled = false;
    visible = false;
    generation++;
    abortController?.abort();
    abortController = null;
    requestKey = null;
    requestBounds = null;
    requestStage = null;
    loading = false;
    prefetching = false;
    lastBoundsKey = null;
    coverageBounds = null;
    selectedRouteId = null;
    lastFailureKey = null;
    lastFailureAt = 0;
    error = null;
    removeReplacement(pendingReplacement);
    pendingReplacement = null;
    removeGeometry();
    routeHeightCache.clear();
    routeSectionCache.clear();
    routes = [];
    onStationsUpdated([]);
  }

  function destroy() {
    disable();
    postRenderRemove?.();
    cameraChangedRemove?.();
    densityChangedRemove?.();
    postRenderRemove = null;
    cameraChangedRemove = null;
    densityChangedRemove = null;
    viewer = null;
  }

  return {
    init(nextViewer) {
      viewer = nextViewer;
      postRenderRemove = viewer.scene.postRender?.addEventListener?.(() => {
        promoteReadyReplacement();
        syncStationListVisibility();
      });
      cameraChangedRemove = viewer.camera?.changed?.addEventListener?.(
        syncStationListVisibility,
      );
      if (typeof document !== 'undefined') {
        const onDensityChanged = (event) => {
          const value = Number(event?.detail?.densityPct);
          if (Number.isFinite(value)) {
            stationDensityPct = Math.max(0, Math.min(100, value));
            syncStationListVisibility();
          }
        };
        document.addEventListener(
          'gev:detection-tuning-changed',
          onDensityChanged,
        );
        densityChangedRemove = () =>
          document.removeEventListener(
            'gev:detection-tuning-changed',
            onDensityChanged,
          );
      }
    },
    enable(nextViewer) {
      if (nextViewer) viewer = nextViewer;
      enabled = true;
    },
    disable,
    destroy,
    setVisible,
    raiseRouteLinesToTop,
    update,
    selectFromPick,
    getRoute: routeForId,
    setSelectedRoute,
    clearSelectedRoute,
    diagnostics({ includeGeometry = false } = {}) {
      return {
        source: 'OpenStreetMap via Overpass',
        enabled,
        count: routes.length,
        loading,
        prefetching,
        requestStage,
        error,
        visible,
        lastUpdate,
        lastRequestedAt,
        lastStatus,
        cache: lastCache,
        upstream: lastUpstream,
        bounds: lastBounds ? { ...lastBounds } : null,
        coverageBounds: coverageBounds ? { ...coverageBounds } : null,
        routes: routes.map((route) => ({
          id: route.id,
          routeId: route.routeId,
          name: route.name,
          ref: route.ref,
          type: route.type,
          color: route.color,
          network: route.network,
          operator: route.operator,
          from: route.from,
          to: route.to,
          description: route.description,
          website: route.website,
          stopCount: route.stops?.length || 0,
          stops: route.stops || [],
          lineCount: route.lines.length,
          ...(includeGeometry ? { lines: route.lines } : {}),
        })),
        selectedRouteId,
      };
    },
  };
}
