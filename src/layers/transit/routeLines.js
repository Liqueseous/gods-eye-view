import * as Cesium from 'cesium';
import { clampTransitRouteBounds } from './routeSource.js';
import { TRANSIT_ENTITY_GROUND_CLEARANCE_M } from './policy.js';

export const TRANSIT_ROUTE_MAX_ALTITUDE_M = 500_000;
export const STATION_PLACARD_ZOOM_ALTITUDE_M = 1_300;
const STATION_PLACARD_MAX_SCALE = 2.5;
const STATION_TOGGLE_INSET_PX = 12;
const STATION_TOGGLE_HEADER_CENTER_Y = 10;

/** Scale station placards as the camera moves below the close-range threshold. */
export function stationPlacardScale(cameraHeightM) {
  if (!Number.isFinite(cameraHeightM)) return 1;
  const progress = Math.max(
    0,
    Math.min(
      1,
      (STATION_PLACARD_ZOOM_ALTITUDE_M - cameraHeightM) /
        STATION_PLACARD_ZOOM_ALTITUDE_M,
    ),
  );
  return 1 + progress * (STATION_PLACARD_MAX_SCALE - 1);
}

/** Keep the dedicated control anchored to the placard's scaled header. */
export function stationPlacardToggleOffset({
  width,
  height,
  placardOffsetY,
  scale = 1,
}) {
  return {
    x: (width / 2 - STATION_TOGGLE_INSET_PX) * scale,
    y: placardOffsetY + (STATION_TOGGLE_HEADER_CENTER_Y - height / 2) * scale,
  };
}

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

function cleanStationLineName(value) {
  return String(value || '')
    .replace(/\s+from\s+.+$/i, '')
    .replace(/\s+to\s+.+$/i, '')
    .replace(/\s*:\s*.+\s*(?:<=>|=>|->|↔|⇄)\s*.+$/i, '')
    .replace(/\s+[–—]\s+.+$/, '')
    .replace(/\s*\([^)]*\b(?:from|to)\b[^)]*\)$/i, '')
    .trim();
}

function namedStationLine(route) {
  const name = String(route?.name || '').trim();
  const ref = String(route?.ref || '').trim();
  if (ROUTE_COLOR_LINE_NAME.test(name)) return null;
  if (ref && compactRouteRef(ref)) return null;
  if (/\b(line|railway|rail)\b/i.test(name)) return cleanStationLineName(name);
  const refName = ref
    .replace(/^cr[-_:]?/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  if (route?.type === 'train' && (name || refName))
    return cleanStationLineName(`${name || refName} Line`);
  return null;
}

function normalizeTransitBadgeToken(value) {
  const token = String(value || '')
    .trim()
    .toUpperCase();
  if (!token || token === 'VIA') return '';
  return token.replace(/^(HOB|JSQ|WTC)\d+$/, '$1');
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
  const express = /express|\b(?:6|7)\s*X\b/i.test(
    `${raw} ${route?.service || ''}`,
  );
  const normalized = values
    .filter((value) => !/^expr/i.test(value))
    .map((value) =>
      express && /^(?:6|7)X$/i.test(value) ? value.slice(0, -1) : value,
    )
    .map(normalizeTransitBadgeToken)
    .filter(Boolean);
  return normalized.length || !route?.color ? normalized : [''];
}

export function transitRouteBadgeShape(route) {
  const type = String(route?.type || '').toLowerCase();
  const identity = `${route?.ref || ''} ${route?.name || ''} ${route?.service || ''} ${route?.network || ''} ${route?.operator || ''}`;
  const pathRail = /\bpath\b|port authority trans-hudson/i.test(identity);
  const mtaSubway = /\b(?:mta|nyc|ind|irt|bmt)\b|subway/i.test(identity);
  if (pathRail) return 'circle';
  if (type === 'subway' || mtaSubway)
    return /express|\b(?:6|7)\s*X\b/i.test(identity) ? 'diamond' : 'circle';
  if (type === 'train') return 'rail';
  if (type === 'light_rail' || type === 'monorail') return 'square';
  if (type === 'tram' || type === 'funicular') return 'capsule';
  return 'circle';
}

export function transitRouteBadgeText(route) {
  const ref = String(route?.ref || '').trim();
  const identity = `${ref} ${route?.name || ''} ${route?.service || ''}`;
  const expressCode = identity.match(/\b([0-9]{1,2}|[A-Z])\s*(?:X|express)\b/i);
  if (expressCode) return expressCode[1].toUpperCase();
  const firstRef = ref.split(/[\s,;/]+/)[0];
  if (/^(?:HOB|JSQ|WTC)\d+$/i.test(firstRef))
    return normalizeTransitBadgeToken(firstRef);
  if (ref && compactRouteRef(ref)) return normalizeTransitBadgeToken(firstRef);
  const name = String(route?.name || '').trim();
  const namedRef = name.match(/^(?:the\s+)?([a-z0-9]{1,3})(?:\s|$)/i);
  return namedRef ? normalizeTransitBadgeToken(namedRef[1]) : '';
}

function stationBadgeImage(text, color, shape = 'circle') {
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
  const mark =
    shape === 'diamond'
      ? `<path d="M14 1 27 14 14 27 1 14Z" fill="${safeColor}" stroke="#fff" stroke-width="2"/>`
      : shape === 'rail'
        ? `<rect x="1" y="5" width="26" height="18" rx="6" fill="${safeColor}" stroke="#fff" stroke-width="2"/>`
        : shape === 'square'
          ? `<rect x="3" y="3" width="22" height="22" rx="4" fill="${safeColor}" stroke="#fff" stroke-width="2"/>`
          : shape === 'capsule'
            ? `<rect x="1" y="6" width="26" height="16" rx="8" fill="${safeColor}" stroke="#fff" stroke-width="2"/>`
            : `<circle cx="14" cy="14" r="12" fill="${safeColor}" stroke="#fff" stroke-width="2"/>`;
  const fontSize = safeText.length > 2 ? 8 : safeText.length > 1 ? 10 : 13;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">${mark}<text x="14" y="14" dy=".35em" fill="#fff" font-family="Arial,sans-serif" font-size="${fontSize}" font-weight="700" text-anchor="middle">${safeText}</text></svg>`,
  )}`;
}

function stationToggleImage(expanded = true) {
  const path = expanded ? 'M5 7.5 9 11l4-3.5' : 'M5 10.5 9 7l4 3.5';
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"><rect x="1" y="1" width="16" height="16" rx="4" fill="#14212a" stroke="#d8e3e8" stroke-width="1"/><path d="${path}" fill="none" stroke="#f1f6f8" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  )}`;
}

function stationPlacardImage(width, height) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="4" fill="#05090d" fill-opacity="1" stroke="#b8eaff" stroke-opacity=".58" stroke-width="1"/></svg>`,
  )}`;
}

function stationListEntries(station) {
  return station.lineEntries;
}

function stationIsListStyle(station) {
  return stationListEntries(station).length > 0;
}

function stationPanelImage(
  station,
  width,
  height,
  entries = stationListEntries(station),
  compact = false,
) {
  const escape = (value) =>
    String(value || '').replace(
      /[&<>"']/g,
      (character) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&apos;',
        })[character],
    );
  const marks = {
    diamond: (x, y, color) =>
      `<path d="M${x} ${y - 8} ${x + 8} ${y} ${x} ${y + 8} ${x - 8} ${y}Z" fill="${color}" stroke="#fff" stroke-width="1"/>`,
    circle: (x, y, color) =>
      `<circle cx="${x}" cy="${y}" r="8" fill="${color}" stroke="#fff" stroke-width="1"/>`,
    rail: (x, y, color) =>
      `<rect x="${x - 11}" y="${y - 7}" width="22" height="14" rx="3" fill="${color}" stroke="#fff" stroke-width="1"/>`,
    square: (x, y, color) =>
      `<rect x="${x - 7}" y="${y - 7}" width="14" height="14" rx="2" fill="${color}" stroke="#fff" stroke-width="1"/>`,
    capsule: (x, y, color) =>
      `<rect x="${x - 9}" y="${y - 5}" width="18" height="10" rx="5" fill="${color}" stroke="#fff" stroke-width="1"/>`,
  };
  const { lineListWidth } = stationPlacardSize(station);
  const rowLeft = (width - lineListWidth) / 2;
  const rows = compact
    ? entries
        .map((entry, index) => {
          const x = width / 2 + (index - (entries.length - 1) / 2) * 24;
          const y = 32;
          const mark = (marks[entry.shape] || marks.circle)(
            x,
            y,
            entry.color || '#00D4FF',
          );
          const text = String(entry.text || '');
          const fontSize = text.length > 2 ? 7 : text.length > 1 ? 8 : 10;
          return `${mark}<text x="${x}" y="${y + 3}" text-anchor="middle" fill="#fff" font-family="Arial,sans-serif" font-size="${fontSize}" font-weight="700">${escape(text)}</text>`;
        })
        .join('')
    : entries
        .map((entry, index) => {
          const y = 30 + index * 18;
          const x = rowLeft + 10;
          const mark = (marks[entry.shape] || marks.circle)(
            x,
            y,
            entry.color || '#00D4FF',
          );
          return `${mark}<text x="${rowLeft + 30}" y="${y + 4}" fill="#fff" font-family="Arial,sans-serif" font-size="10">${escape(entry.label)}</text>`;
        })
        .join('');
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="4" fill="#05090d" fill-opacity="1" stroke="#b8eaff" stroke-opacity=".7"/><text x="${(width - 24) / 2}" y="16" text-anchor="middle" fill="#fff" font-family="Arial,sans-serif" font-size="11">${escape(station.name)}</text>${rows}</svg>`,
  )}`;
}

function stationPlacardSize(station) {
  const entries = stationListEntries(station);
  const lineListWidth = Math.max(
    64,
    ...entries.map((entry) => entry.label.length * 5.3 + 34),
  );
  const badgeRowWidth = station.badges.length * 24 + 8;
  const width = Math.max(
    100,
    // Reserve the header's right edge for the dedicated placard button.
    (station.name || '').length * 6.2 + 44,
    lineListWidth + 12,
    badgeRowWidth,
  );
  const height = Math.max(48, 42 + entries.length * 18);
  return { lineListWidth, width, height };
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
        group.lineEntries.push({
          label: lineName,
          color: route.color,
          text: transitRouteBadgeText(route),
          shape: transitRouteBadgeShape(route),
        });
      for (const text of stationBadgeText(route)) {
        const badgeKey = `${text}:${route.color || ''}:${transitRouteBadgeShape(route)}`;
        if (!group.badges.some((badge) => badge.key === badgeKey))
          group.badges.push({
            key: badgeKey,
            text,
            color: route.color,
            shape: transitRouteBadgeShape(route),
          });
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
  let stationPlacardsVisible = true;
  const collapsedStations = new Set();
  let allStationsCollapsed = null;
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

  function setStationItemVisible(item, show) {
    if (item.billboard) item.billboard.show = show;
    if (item.label) item.label.show = show;
    if (item.point) item.point.show = show;
    if (item.stationNameLabel) item.stationNameLabel.show = show;
    if (item.entity) {
      if (item.entity.billboard) item.entity.billboard.show = show;
      if (item.entity.label) item.entity.label.show = show;
      if (item.entity.point) item.entity.point.show = show;
    }
  }

  function syncStationListVisibility() {
    if (!stationPlacardsVisible) {
      for (const item of stationListItems) setStationItemVisible(item, false);
      return;
    }
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
    const placardScale = stationPlacardScale(height);
    for (const item of stationListItems) {
      if (item.isPlacard) {
        const billboard = item.billboard || item.entity?.billboard;
        if (billboard) billboard.scale = placardScale;
      }
      const expanded =
        allStationsCollapsed === true
          ? false
          : allStationsCollapsed === false ||
            !collapsedStations.has(item.stationId);
      const showExpandedList = showList && expanded;
      if (item.isStationToggle) {
        const expanded =
          allStationsCollapsed === true
            ? false
            : allStationsCollapsed === false ||
              !collapsedStations.has(item.stationId);
        const show = showNames && altitudeVisible;
        const toggleScale = showExpandedList ? placardScale : 1;
        const expandedOffset = stationPlacardToggleOffset({
          width: item.placardWidth,
          height: item.placardHeight,
          placardOffsetY: item.placardOffsetY,
          scale: toggleScale,
        });
        const offset = new Cesium.Cartesian2(
          showExpandedList ? expandedOffset.x : item.collapsedOffsetX || 0,
          showExpandedList ? expandedOffset.y : item.collapsedOffsetY || -16,
        );
        const image = stationToggleImage(expanded);
        if (item.billboard) {
          item.billboard.image = image;
          item.billboard.scale = toggleScale;
          item.billboard.pixelOffset = offset;
          item.billboard.show = show;
        }
        if (item.entity?.billboard) {
          item.entity.billboard.image = image;
          item.entity.billboard.scale = toggleScale;
          item.entity.billboard.pixelOffset = offset;
          item.entity.billboard.show = show;
        }
        continue;
      }
      if (item.isStationName) {
        const stationNameLabel = item.stationNameLabel || item.entity?.label;
        if (stationNameLabel) {
          stationNameLabel.show = showNames && !expanded;
          stationNameLabel.showBackground = !showExpandedList;
        }
        if (stationNameLabel && item.expandedOffset !== undefined)
          stationNameLabel.pixelOffset = new Cesium.Cartesian2(
            0,
            showExpandedList ? item.expandedOffset : -16,
          );
        continue;
      }
      if (item.isStationMarker) {
        if (item.point) item.point.show = showNames;
        if (item.entity?.point) item.entity.point.show = showNames;
        continue;
      }
      const show = showExpandedList;
      if (item.billboard) item.billboard.show = show;
      if (item.label) item.label.show = show;
      if (item.entity?.billboard) item.entity.billboard.show = show;
      if (item.entity?.label) item.entity.label.show = show;
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
      // Preserve the source geometry exactly. Visual merging and aggressive
      // vertex reduction can create shortcuts across branches and turns.
      section = line;
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
          (lat, lon) =>
            stableRouteHeight(lat, lon) + TRANSIT_ENTITY_GROUND_CLEARANCE_M,
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
      viewer?.scene?.context &&
      viewer?.scene?.primitives?.add &&
      typeof Cesium.BillboardCollection === 'function' &&
      typeof Cesium.LabelCollection === 'function' &&
      typeof Cesium.PointPrimitiveCollection === 'function'
        ? {
            // Cesium composites these collections in insertion order. Keep
            // list content in the foreground collections and compact content
            // behind it; toggles are last so they receive pointer picks above
            // their opaque placards.
            compactPlacards: new Cesium.BillboardCollection(),
            stationToggles: new Cesium.BillboardCollection(),
            compactBillboards: new Cesium.BillboardCollection(),
            compactLabels: new Cesium.LabelCollection(),
            compactPoints: new Cesium.PointPrimitiveCollection(),
            listBillboards: new Cesium.BillboardCollection(),
            listLabels: new Cesium.LabelCollection(),
            listPoints: new Cesium.PointPrimitiveCollection(),
          }
        : null;
    const stations = groupTransitStations(items).sort((a, b) => {
      const aIsList = stationIsListStyle(a);
      const bIsList = stationIsListStyle(b);
      if (aIsList !== bIsList) return aIsList ? 1 : -1;
      const first = stationPlacardSize(a);
      const second = stationPlacardSize(b);
      return first.width * first.height - second.width * second.height;
    });
    for (const station of stations) {
      if (!isCurrent())
        throw Object.assign(new Error('Route build superseded'), {
          name: 'AbortError',
        });
      const id = `transit-station:${station.id}`;
      const listEntries = stationListEntries(station);
      const isList = listEntries.length > 0;
      const stationDepthTestDistance = 0;
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
      const globe = viewer?.scene?.globe;
      const groundCartographic = Cesium.Cartographic.fromDegrees(
        station.lon,
        station.lat,
      );
      const renderedGround =
        globe?.show !== false ? globe?.getHeight?.(groundCartographic) : null;
      const stationHeight =
        (Number.isFinite(renderedGround)
          ? renderedGround
          : stableRouteHeight(station.lat, station.lon)) +
        TRANSIT_ENTITY_GROUND_CLEARANCE_M;
      const stationPosition = Cesium.Cartesian3.fromDegrees(
        station.lon,
        station.lat,
        stationHeight,
      );
      const stationOverlay = overlay
        ? {
            billboards: isList
              ? overlay.listBillboards
              : overlay.compactBillboards,
            placards: isList ? overlay.listBillboards : overlay.compactPlacards,
            labels: isList ? overlay.listLabels : overlay.compactLabels,
            points: isList ? overlay.listPoints : overlay.compactPoints,
          }
        : null;
      if (stationOverlay && nextStationCollections.length === 0) {
        const collections = [
          overlay.listPoints,
          overlay.listLabels,
          overlay.listBillboards,
          overlay.compactPoints,
          overlay.compactLabels,
          overlay.compactBillboards,
          overlay.compactPlacards,
          overlay.stationToggles,
        ];
        for (const collection of collections) {
          viewer.scene.primitives.add(collection);
          collection.show = false;
          nextStationCollections.push(collection);
        }
      }
      const stationLabelOffset = isList ? -44 - listEntries.length * 18 : -30;
      const compactLift = isList ? 0 : -12;
      const compactBadgeY = isList ? -20 : -30;
      const {
        lineListWidth,
        width: placardWidth,
        height: placardHeight,
      } = stationPlacardSize(station);
      const placardOffsetY = stationLabelOffset / 2 - 10 + compactLift;
      const toggleOffsetY = placardOffsetY + 10 - placardHeight / 2;
      // Collection order, not placard area or per-station depth offsets,
      // determines which station content is in front.
      const stationLabel = station.name
        ? {
            id,
            position: stationPosition,
            text: station.name,
            font: '11px sans-serif',
            fillColor: Cesium.Color.WHITE,
            showBackground: false,
            backgroundColor: Cesium.Color.BLACK.withAlpha(0.65),
            horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
            verticalOrigin: Cesium.VerticalOrigin.CENTER,
            // Keep the station name above the line rows and marker.
            pixelOffset: new Cesium.Cartesian2(
              0,
              stationLabelOffset + compactLift,
            ),
            eyeOffset: new Cesium.Cartesian3(0, 0, STATION_EYE_OFFSET_M),
            disableDepthTestDistance: stationDepthTestDistance,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
              0,
              STATION_LABEL_MAX_DISTANCE_M,
            ),
          }
        : null;
      const placardId = `${id}:placard`;
      const toggleId = `${id}:toggle`;
      pickTargets.set(placardId, station.routeIds[0]);
      pickTargets.set(toggleId, station.routeIds[0]);
      const placard = {
        id: placardId,
        position: stationPosition,
        image: stationPanelImage(
          station,
          placardWidth,
          placardHeight,
          isList ? listEntries : station.badges,
          !isList,
        ),
        width: placardWidth,
        height: placardHeight,
        pixelOffset: new Cesium.Cartesian2(0, placardOffsetY),
        eyeOffset: new Cesium.Cartesian3(0, 0, STATION_EYE_OFFSET_M),
        disableDepthTestDistance: stationDepthTestDistance,
        show: false,
      };
      if (station.name || isList) {
        if (overlay) {
          const placardInstance = stationOverlay.placards.add(placard);
          nextStationListItems.push({
            stationId: id,
            isPlacard: true,
            billboard: placardInstance,
          });
        } else {
          const placardEntity = viewer.entities.add({
            id: placard.id,
            position: stationPosition,
            billboard: placard,
          });
          nextEntities.push(placardEntity);
          nextStationListItems.push({
            stationId: id,
            isPlacard: true,
            entity: placardEntity,
          });
        }
      }
      const toggle = {
        id: toggleId,
        position: stationPosition,
        image: stationToggleImage(),
        width: 18,
        height: 18,
        pixelOffset: new Cesium.Cartesian2(
          placardWidth / 2 - 12,
          toggleOffsetY,
        ),
        eyeOffset: new Cesium.Cartesian3(0, 0, STATION_EYE_OFFSET_M - 10),
        disableDepthTestDistance: 0,
        show: false,
      };
      if (overlay) {
        const toggleInstance = overlay.stationToggles.add(toggle);
        nextStationListItems.push({
          stationId: id,
          isStationToggle: true,
          billboard: toggleInstance,
          placardWidth,
          placardHeight,
          placardOffsetY,
          collapsedOffsetX: ((station.name || '').length * 6.2) / 2 + 10,
          collapsedOffsetY: -16,
        });
      } else {
        const toggleEntity = viewer.entities.add({
          id: toggleId,
          position: stationPosition,
          billboard: toggle,
        });
        nextEntities.push(toggleEntity);
        nextStationListItems.push({
          stationId: id,
          isStationToggle: true,
          entity: toggleEntity,
          placardWidth,
          placardHeight,
          placardOffsetY,
          collapsedOffsetX: ((station.name || '').length * 6.2) / 2 + 10,
          collapsedOffsetY: -16,
        });
      }
      const marker = stationOverlay?.points.add({
        id,
        position: stationPosition,
        pixelSize: Math.min(
          16,
          STATION_PIXEL_SIZE + Math.max(0, station.routeIds.length - 1) * 3,
        ),
        color: Cesium.Color.WHITE,
        outlineColor,
        outlineWidth: station.routeIds.length > 1 ? 3 : 2,
        disableDepthTestDistance: stationDepthTestDistance,
        show: false,
      });
      const stationEntity = viewer.entities.add({
        id,
        position: stationPosition,
        properties: {
          routeIds: station.routeIds,
          routeRefs: station.routeRefs,
        },
        ...(overlay
          ? {}
          : {
              point: {
                pixelSize: Math.min(
                  16,
                  STATION_PIXEL_SIZE +
                    Math.max(0, station.routeIds.length - 1) * 3,
                ),
                color: Cesium.Color.WHITE,
                outlineColor,
                outlineWidth: station.routeIds.length > 1 ? 3 : 2,
                eyeOffset: new Cesium.Cartesian3(0, 0, STATION_EYE_OFFSET_M),
                disableDepthTestDistance: stationDepthTestDistance,
              },
            }),
        label: overlay ? undefined : stationLabel,
      });
      nextEntities.push(stationEntity);
      nextStationListItems.push({
        stationId: id,
        isStationMarker: true,
        isList,
        entity: stationEntity,
        point: marker,
      });
      if (overlay && stationLabel) {
        const stationNameLabel = stationOverlay.labels.add(stationLabel);
        nextStationListItems.push({
          stationId: id,
          isStationName: true,
          isList,
          stationNameLabel,
          expandedOffset: stationLabelOffset + compactLift,
        });
      } else if (stationLabel) {
        nextStationListItems.push({
          stationId: id,
          isStationName: true,
          isList,
          entity: stationEntity,
          expandedOffset: stationLabelOffset + compactLift,
        });
      }
      const renderedBadges = overlay || isList ? [] : station.badges;
      const badgeCount = renderedBadges.length;
      renderedBadges.forEach((badge, index) => {
        const badgeId = `${id}:badge:${index}`;
        pickTargets.set(badgeId, station.routeIds[0]);
        const billboard = {
          id: badgeId,
          position: stationPosition,
          image: stationBadgeImage(badge.text, badge.color, badge.shape),
          width: 24,
          height: 24,
          pixelOffset: new Cesium.Cartesian2(
            (index - (badgeCount - 1) / 2) * 24,
            compactBadgeY,
          ),
          eyeOffset: new Cesium.Cartesian3(0, 0, STATION_EYE_OFFSET_M),
          disableDepthTestDistance: stationDepthTestDistance,
        };
        if (overlay) {
          const billboardInstance = stationOverlay.billboards.add(billboard);
          nextStationListItems.push({
            stationId: id,
            isPanelIcon: true,
            isList,
            billboard: billboardInstance,
          });
        } else {
          const entity = viewer.entities.add({
            id: badgeId,
            position: stationPosition,
            billboard,
          });
          nextEntities.push(entity);
          nextStationListItems.push({
            stationId: id,
            isPanelIcon: true,
            isList,
            entity,
          });
        }
      });
      const renderedLineEntries = isList ? [] : station.lineEntries;
      renderedLineEntries.forEach((entry, index) => {
        const rowY = -44 - index * 18;
        const rowLeft = -lineListWidth / 2;
        const badgeId = `${id}:line:${index}`;
        pickTargets.set(badgeId, station.routeIds[0]);
        const billboard = {
          id: badgeId,
          position: stationPosition,
          image: stationBadgeImage(entry.text, entry.color, entry.shape),
          width: 20,
          height: 20,
          pixelOffset: new Cesium.Cartesian2(rowLeft + 10, rowY),
          eyeOffset: new Cesium.Cartesian3(0, 0, STATION_EYE_OFFSET_M),
          disableDepthTestDistance: stationDepthTestDistance,
        };
        const label = {
          id: `${badgeId}:label`,
          position: stationPosition,
          text: entry.label,
          font: '10px sans-serif',
          fillColor: Cesium.Color.WHITE,
          showBackground: false,
          backgroundColor: Cesium.Color.BLACK.withAlpha(0.65),
          horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          pixelOffset: new Cesium.Cartesian2(rowLeft + 30, rowY),
          eyeOffset: new Cesium.Cartesian3(0, 0, STATION_EYE_OFFSET_M),
          disableDepthTestDistance: stationDepthTestDistance,
        };
        if (overlay) {
          const billboardInstance = stationOverlay.billboards.add(billboard);
          const labelInstance = stationOverlay.labels.add(label);
          nextStationListItems.push({
            stationId: id,
            isPanelIcon: true,
            isList,
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
          nextStationListItems.push({ stationId: id, entity });
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

  function setStationPlacardsVisible(next) {
    stationPlacardsVisible = next !== false;
    syncStationListVisibility();
    viewer?.scene?.requestRender?.();
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

  function refreshStationRendering() {
    for (const collection of stationOverlayCollections) {
      collection.show = false;
      collection.show = visible;
    }
    viewer?.scene?.requestRender?.();
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
    const stationPick = candidateIds.find((id) =>
      id.startsWith('transit-station:'),
    );
    const stationTogglePick = candidateIds.some((id) => id.endsWith(':toggle'));
    if (stationPick && stationTogglePick) {
      const stationId = stationListItems.find(
        (item) =>
          item.stationId &&
          (stationPick === item.stationId ||
            stationPick.startsWith(`${item.stationId}:`)),
      )?.stationId;
      if (stationId) {
        allStationsCollapsed = null;
        if (collapsedStations.has(stationId))
          collapsedStations.delete(stationId);
        else collapsedStations.add(stationId);
        syncStationListVisibility();
        refreshStationRendering();
      }
    }
    selectedRouteId = routeId;
    if (!stationTogglePick) onSelectRoute(route);
    return true;
  }

  function setSelectedRoute(routeId) {
    selectedRouteId = routeId || null;
  }

  function clearSelectedRoute() {
    selectedRouteId = null;
  }

  function setAllStationsCollapsed(collapsed) {
    allStationsCollapsed = collapsed === true;
    const stationIds = new Set(
      stationListItems.map((item) => item.stationId).filter(Boolean),
    );
    for (const station of groupTransitStations(routes))
      stationIds.add(station.id);
    for (const stationId of stationIds) {
      if (collapsed) collapsedStations.add(stationId);
      else collapsedStations.delete(stationId);
    }
    syncStationListVisibility();
    refreshStationRendering();
  }

  function collapseAllStations() {
    setAllStationsCollapsed(true);
  }

  function expandAllStations() {
    setAllStationsCollapsed(false);
  }

  function areAllStationsCollapsed() {
    return allStationsCollapsed === true;
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
    collapseAllStations,
    expandAllStations,
    areAllStationsCollapsed,
    setStationPlacardsVisible,
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
