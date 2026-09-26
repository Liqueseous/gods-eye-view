import { clampBoundsAroundCenter } from '../../data/trafficBounds.js';

const MAX_QUERY_SPAN_DEG = 1;
const ROUTE_TYPES = new Set([
  'train',
  'subway',
  'light_rail',
  'tram',
  'monorail',
  'funicular',
]);
const ROUTE_COLORS = Object.freeze({
  red: '#DA291C',
  orange: '#ED8B00',
  blue: '#003DA5',
  green: '#00843D',
  yellow: '#FFD100',
  purple: '#80276C',
  pink: '#E56DB1',
  brown: '#7A4E2D',
});
const FALLBACK_COLORS = Object.freeze({
  train: '#D9A6FF',
  subway: '#FF4538',
  light_rail: '#FFC24A',
  tram: '#FFC24A',
  monorail: '#5FD6FF',
  funicular: '#5FD6FF',
});
const MAX_ROUTE_SEGMENTS = 3000;

function validBounds(bounds) {
  return (
    [bounds?.south, bounds?.west, bounds?.north, bounds?.east].every(
      Number.isFinite,
    ) &&
    bounds.south >= -90 &&
    bounds.north <= 90 &&
    bounds.north > bounds.south &&
    bounds.west >= -180 &&
    bounds.west <= 180 &&
    bounds.east >= -180 &&
    bounds.east <= 180
  );
}

/** Clamp a camera rectangle to one bounded, monotonic Overpass bbox. */
export function clampTransitRouteBounds(bounds) {
  if (!validBounds(bounds))
    throw new TypeError('A bounded transit-route viewport is required');
  const longitudeSpan =
    bounds.east >= bounds.west
      ? bounds.east - bounds.west
      : 360 - bounds.west + bounds.east;
  const centerLon = ((bounds.west + longitudeSpan / 2 + 540) % 360) - 180;
  const center = {
    lat: (bounds.south + bounds.north) / 2,
    lon: centerLon,
  };
  const clamped = clampBoundsAroundCenter(
    bounds,
    center,
    MAX_QUERY_SPAN_DEG,
  );
  const rounded = (value) => Number(value.toFixed(6));
  return {
    south: rounded(Math.max(-90, clamped.south)),
    west: rounded(clamped.west),
    north: rounded(Math.min(90, clamped.north)),
    east: rounded(clamped.east),
  };
}

/** Build the bounded OSM relation query for rail and rapid-transit routes. */
export function buildTransitRouteQuery(bounds) {
  const safe = clampTransitRouteBounds(bounds);
  const bbox = `(${safe.south},${safe.west},${safe.north},${safe.east})`;
  return (
    '[out:json][timeout:20];' +
    `relation["route"~"^(train|subway|light_rail|tram|monorail|funicular)$",i]${bbox}->.routes;` +
    '.routes out body;' +
    `way(r.routes)${bbox}->.routeways;` +
    '.routeways out geom qt;'
  );
}

function cleanText(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  return text ? text.slice(0, 120) : null;
}

function parseRouteColor(value) {
  const color = cleanText(value);
  if (!color) return null;
  if (/^#[\da-f]{6}$/i.test(color)) return color.toUpperCase();
  return ROUTE_COLORS[color.toLowerCase()] || null;
}

function routeColor(tags, type, name, ref) {
  const tagged =
    parseRouteColor(tags.colour) ||
    parseRouteColor(tags.color) ||
    parseRouteColor(tags['route:colour']);
  if (tagged) return tagged;
  const identity = `${name || ''} ${ref || ''}`;
  const named = Object.entries(ROUTE_COLORS).find(([color]) =>
    new RegExp(`\\b${color}\\b`, 'i').test(identity),
  );
  return named?.[1] || FALLBACK_COLORS[type];
}

function clipSegment(a, b, bounds) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const p = [-dx, dx, -dy, dy];
  const q = [
    a[0] - bounds.west,
    bounds.east - a[0],
    a[1] - bounds.south,
    bounds.north - a[1],
  ];
  let start = 0;
  let end = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
      continue;
    }
    const ratio = q[i] / p[i];
    if (p[i] < 0) start = Math.max(start, ratio);
    else end = Math.min(end, ratio);
    if (start > end) return null;
  }
  return [
    [a[0] + start * dx, a[1] + start * dy],
    [a[0] + end * dx, a[1] + end * dy],
  ];
}

function clippedLines(geometry, bounds) {
  const points = (geometry || [])
    .filter(
      (point) =>
        Number.isFinite(point?.lon) &&
        Number.isFinite(point?.lat) &&
        point.lon >= -180 &&
        point.lon <= 180 &&
        point.lat >= -90 &&
        point.lat <= 90,
    )
    .map((point) => [point.lon, point.lat]);
  const lines = [];
  let active = null;
  const flush = () => {
    if (active?.length >= 2) lines.push(active);
    active = null;
  };
  for (let i = 1; i < points.length; i++) {
    const clipped = clipSegment(points[i - 1], points[i], bounds);
    if (!clipped) {
      flush();
      continue;
    }
    const [start, end] = clipped;
    if (
      active &&
      Math.abs(active.at(-1)[0] - start[0]) < 1e-8 &&
      Math.abs(active.at(-1)[1] - start[1]) < 1e-8
    ) {
      active.push(end);
    } else {
      flush();
      active = [start, end];
    }
  }
  flush();
  return lines;
}

/** Decode and viewport-clip OSM route relation member ways. */
export function normalizeTransitRoutes(payload, bounds) {
  const safeBounds = clampTransitRouteBounds(bounds);
  const segments = new Map();
  const waysById = new Map();
  const routeRelations = [];

  for (const relation of payload?.elements || []) {
    if (relation?.type === 'way' && Array.isArray(relation.geometry)) {
      waysById.set(String(relation.id ?? ''), relation);
      continue;
    }
    const tags = relation?.tags || {};
    const type = cleanText(tags.route)?.toLowerCase();
    if (relation?.type !== 'relation' || !ROUTE_TYPES.has(type)) continue;
    const name =
      cleanText(tags.name) ||
      cleanText(tags['name:en']) ||
      cleanText(tags.official_name);
    const ref = cleanText(tags.ref);
    const explicitColor =
      parseRouteColor(tags.colour) ||
      parseRouteColor(tags.color) ||
      parseRouteColor(tags['route:colour']);
    const color = routeColor(tags, type, name, ref);
    const memberWays = new Set();
    const inlineWays = [];
    for (const member of relation.members || []) {
      if (member?.type !== 'way') continue;
      memberWays.add(String(member.ref ?? ''));
      if (Array.isArray(member.geometry)) inlineWays.push(member);
    }
    if (Array.isArray(relation.geometry)) {
      inlineWays.push({ ref: 'route', geometry: relation.geometry });
    }
    routeRelations.push({
      relation,
      type,
      name,
      ref,
      explicitColor,
      color,
      memberWays,
      inlineWays,
    });
  }

  for (const route of routeRelations) {
    const { relation, type, name, ref, explicitColor, color } = route;
    const addWay = (wayId, geometry, wayTags = {}) => {
      const id = `${relation.id ?? 'route'}:${wayId ?? segments.size}`;
      if (segments.has(id)) return;
      const lines = clippedLines(geometry, safeBounds);
      if (!lines.length) return;
      segments.set(id, {
        id,
        routeId: String(relation.id ?? ''),
        name,
        ref,
        type,
        color:
          explicitColor ||
          parseRouteColor(wayTags.colour) ||
          parseRouteColor(wayTags.color) ||
          color,
        lines,
      });
    };

    for (const wayId of route.memberWays) {
      const way = waysById.get(wayId);
      if (way) addWay(wayId, way.geometry, way.tags);
      if (segments.size >= MAX_ROUTE_SEGMENTS) break;
    }
    if (segments.size >= MAX_ROUTE_SEGMENTS) break;
    for (const way of route.inlineWays) {
      addWay(way.ref, way.geometry, way.tags);
      if (segments.size >= MAX_ROUTE_SEGMENTS) break;
    }
    if (segments.size >= MAX_ROUTE_SEGMENTS) break;
  }
  return [...segments.values()];
}

/** Source for viewport-bounded static OSM transit route relations. */
export function createTransitRouteSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async requestRoutes(bounds, { signal } = {}) {
      const safeBounds = clampTransitRouteBounds(bounds);
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/overpass', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(buildTransitRouteQuery(safeBounds))}`,
        signal,
      });
      signal?.throwIfAborted();
      return {
        ok: response.ok,
        status: response.status,
        headers: response.headers,
        async json() {
          const payload = await response.json();
          signal?.throwIfAborted();
          if (!Array.isArray(payload?.elements))
            throw new Error('Malformed transit-route snapshot');
          return { routes: normalizeTransitRoutes(payload, safeBounds) };
        },
      };
    },
  };
}