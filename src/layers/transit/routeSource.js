import { clampBoundsAroundCenter } from '../../data/trafficBounds.js';
import { fetchOsmCacheTiles } from '../../data/osmCacheBounds.js';

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
const MAX_ROUTE_SEGMENTS = 10000;
const MAX_ROUTE_SEGMENTS_PER_ROUTE = 1000;
const ROUTE_SIMPLIFY_TOLERANCE_DEG = 0.00003;
const MAX_ROUTE_POINTS_PER_LINE = 256;
const MAX_MAIN_CORRIDORS = 3;
const MIN_MAIN_CORRIDOR_RATIO = 0.2;
const PARALLEL_TRACK_OFFSET_DEG = 0.00025;

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
  const clamped = clampBoundsAroundCenter(bounds, center, MAX_QUERY_SPAN_DEG);
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
    '.routeways out geom qt;' +
    `node(r.routes)${bbox}->.routenodes;` +
    '.routenodes out body qt;'
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

function routeAliases(route) {
  const raw = [route?.ref, route?.name]
    .filter((value) => typeof value === 'string' && value.trim())
    .flatMap((value) => value.split(/[;,/]/));
  const aliases = new Set();
  for (const value of raw) {
    const alias = value
      .trim()
      .replace(/\b(line|route|service)\b$/i, '')
      .replace(/[^a-z\d]/gi, '')
      .toUpperCase();
    if (alias) aliases.add(alias);
  }
  return aliases;
}

/** True only when a live GTFS route id unambiguously matches this OSM route. */
export function transitRouteMatchesVehicle(route, vehicleRouteId) {
  if (typeof vehicleRouteId !== 'string' || !vehicleRouteId.trim())
    return false;
  const aliases = routeAliases(route);
  const id = vehicleRouteId.trim().toUpperCase();
  const candidates = [id];
  const agencySuffix = id.split('_').at(-1);
  if (agencySuffix !== id) candidates.push(agencySuffix);
  for (const candidate of candidates) {
    const normalized = candidate.replace(/[^A-Z\d]/g, '');
    if (aliases.has(normalized)) return true;
    for (const alias of aliases) {
      if (alias.length > 1 && normalized.startsWith(`${alias}`)) {
        const next = normalized[alias.length];
        if (next && /[A-Z]/.test(next)) return true;
      }
    }
  }
  return false;
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

function simplifyLine(line) {
  if (line.length <= 2) return line;
  const toleranceSquared = ROUTE_SIMPLIFY_TOLERANCE_DEG ** 2;
  const keep = new Uint8Array(line.length);
  keep[0] = 1;
  keep[line.length - 1] = 1;
  const stack = [[0, line.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    const a = line[start];
    const b = line[end];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const denominator = dx * dx + dy * dy;
    let farthest = -1;
    let maximum = toleranceSquared;
    for (let index = start + 1; index < end; index += 1) {
      const point = line[index];
      const fraction = denominator
        ? Math.max(
            0,
            Math.min(
              1,
              ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / denominator,
            ),
          )
        : 0;
      const projected = [a[0] + fraction * dx, a[1] + fraction * dy];
      const distanceSquared =
        (point[0] - projected[0]) ** 2 + (point[1] - projected[1]) ** 2;
      if (distanceSquared > maximum) {
        maximum = distanceSquared;
        farthest = index;
      }
    }
    if (farthest !== -1) {
      keep[farthest] = 1;
      stack.push([start, farthest], [farthest, end]);
    }
  }
  const simplified = line.filter((_point, index) => keep[index]);
  if (simplified.length <= MAX_ROUTE_POINTS_PER_LINE) return simplified;
  const stride = (simplified.length - 1) / (MAX_ROUTE_POINTS_PER_LINE - 1);
  return Array.from(
    { length: MAX_ROUTE_POINTS_PER_LINE },
    (_value, index) => simplified[Math.round(index * stride)],
  );
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
  return lines.map(simplifyLine);
}

function pointsClose(a, b) {
  return Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7;
}

function mergeConnectedLines(lines) {
  const remaining = lines.map((line) => [...line]);
  const merged = [];
  while (remaining.length) {
    const current = remaining.pop();
    let joined = true;
    while (joined) {
      joined = false;
      for (let index = remaining.length - 1; index >= 0; index -= 1) {
        const candidate = remaining[index];
        if (pointsClose(current.at(-1), candidate[0])) {
          current.push(...candidate.slice(1));
        } else if (pointsClose(current.at(-1), candidate.at(-1))) {
          current.push(...candidate.slice(0, -1).reverse());
        } else if (pointsClose(current[0], candidate.at(-1))) {
          current.unshift(...candidate.slice(0, -1));
        } else if (pointsClose(current[0], candidate[0])) {
          current.unshift(...candidate.slice(1).reverse());
        } else {
          continue;
        }
        remaining.splice(index, 1);
        joined = true;
        break;
      }
    }
    merged.push(simplifyLine(current));
  }
  return merged;
}

function lineLength(line) {
  let length = 0;
  const latitudeScale = Math.cos((line[0][1] * Math.PI) / 180);
  for (let index = 1; index < line.length; index += 1) {
    const dx = (line[index][0] - line[index - 1][0]) * latitudeScale;
    const dy = line[index][1] - line[index - 1][1];
    length += Math.hypot(dx, dy);
  }
  return length;
}

function lineIsParallelTrack(a, b) {
  const aStart = a[0];
  const aEnd = a.at(-1);
  const bStart = b[0];
  const bEnd = b.at(-1);
  const aDx = aEnd[0] - aStart[0];
  const aDy = aEnd[1] - aStart[1];
  const bDx = bEnd[0] - bStart[0];
  const bDy = bEnd[1] - bStart[1];
  const aMagnitude = Math.hypot(aDx, aDy);
  const bMagnitude = Math.hypot(bDx, bDy);
  if (!aMagnitude || !bMagnitude) return false;
  const alignment = (aDx * bDx + aDy * bDy) / (aMagnitude * bMagnitude);
  if (Math.abs(alignment) < 0.96) return false;
  if (
    Math.abs(aMagnitude - bMagnitude) / Math.max(aMagnitude, bMagnitude) >
    0.2
  )
    return false;
  const aMid = a[Math.floor(a.length / 2)];
  const bMid = b[Math.floor(b.length / 2)];
  return (
    Math.hypot(aMid[0] - bMid[0], aMid[1] - bMid[1]) <=
    PARALLEL_TRACK_OFFSET_DEG
  );
}

function collapseParallelTracks(lines) {
  const retained = [];
  for (const line of lines.sort((a, b) => lineLength(b) - lineLength(a))) {
    if (retained.some((candidate) => lineIsParallelTrack(candidate, line)))
      continue;
    retained.push(line);
  }
  return retained;
}

function lineOverviewKey(route) {
  return [route.network, route.type, route.ref || route.name || route.routeId]
    .map((value) =>
      String(value || '')
        .trim()
        .toLowerCase(),
    )
    .join('|');
}

function buildLineOverviews(segments) {
  const overviews = new Map();
  for (const segment of segments) {
    const key = lineOverviewKey(segment);
    let overview = overviews.get(key);
    if (!overview) {
      overview = {
        ...segment,
        id: `line:${key}`,
        routeId: `line:${key}`,
        lines: [],
        stops: [],
      };
      overviews.set(key, overview);
    }
    overview.lines.push(...segment.lines);
    const stops = new Map(overview.stops.map((stop) => [stop.id, stop]));
    for (const stop of segment.stops || []) stops.set(stop.id, stop);
    overview.stops = [...stops.values()];
  }
  return [...overviews.values()].map((overview) => {
    const merged = collapseParallelTracks(mergeConnectedLines(overview.lines));
    const ranked = merged
      .map((line) => ({ line, length: lineLength(line) }))
      .sort((a, b) => b.length - a.length);
    const minimumLength = (ranked[0]?.length || 0) * MIN_MAIN_CORRIDOR_RATIO;
    return {
      ...overview,
      lines: ranked
        .filter(({ length }) => length >= minimumLength)
        .slice(0, MAX_MAIN_CORRIDORS)
        .map(({ line }) => line),
    };
  });
}

/** Decode and viewport-clip OSM route relation member ways. */
export function normalizeTransitRoutes(payload, bounds) {
  const safeBounds = clampTransitRouteBounds(bounds);
  const segments = new Map();
  const waysById = new Map();
  const nodesById = new Map();
  const routeRelations = [];
  const routeSegmentBuckets = [];

  for (const relation of payload?.elements || []) {
    if (relation?.type === 'way' && Array.isArray(relation.geometry)) {
      waysById.set(String(relation.id ?? ''), relation);
      continue;
    }
    if (
      relation?.type === 'node' &&
      Number.isFinite(relation.lat) &&
      Number.isFinite(relation.lon)
    ) {
      nodesById.set(String(relation.id ?? ''), relation);
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
    const memberStops = [];
    const inlineWays = [];
    for (const member of relation.members || []) {
      if (member?.type === 'way') {
        memberWays.add(String(member.ref ?? ''));
        if (Array.isArray(member.geometry)) inlineWays.push(member);
      } else if (
        member?.type === 'node' &&
        /stop|platform|station/i.test(String(member.role || ''))
      ) {
        memberStops.push({
          id: String(member.ref ?? ''),
          role: cleanText(member.role),
        });
      }
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
      network: cleanText(tags.network),
      operator: cleanText(tags.operator),
      from: cleanText(tags.from),
      to: cleanText(tags.to),
      description: cleanText(tags.description),
      website: cleanText(tags.website),
      memberStops,
      memberWays,
      inlineWays,
    });
  }

  for (const route of routeRelations) {
    const {
      relation,
      type,
      name,
      ref,
      explicitColor,
      color,
      network,
      operator,
      from,
      to,
      description,
      website,
      memberStops,
    } = route;
    let routeSegmentCount = 0;
    const routeSegments = [];
    const stops = memberStops
      .map(({ id, role }) => {
        const node = nodesById.get(id);
        if (
          !node ||
          node.lat < safeBounds.south ||
          node.lat > safeBounds.north ||
          node.lon < safeBounds.west ||
          node.lon > safeBounds.east
        )
          return null;
        const tags = node.tags || {};
        return {
          id,
          role,
          name:
            cleanText(tags.name) ||
            cleanText(tags['name:en']) ||
            cleanText(tags.ref) ||
            cleanText(tags.local_ref),
          lat: Number(node.lat.toFixed(6)),
          lon: Number(node.lon.toFixed(6)),
        };
      })
      .filter(Boolean);
    const addWay = (wayId, geometry, wayTags = {}) => {
      if (routeSegmentCount >= MAX_ROUTE_SEGMENTS_PER_ROUTE) return;
      const id = `${relation.id ?? 'route'}:${wayId ?? segments.size}`;
      if (segments.has(id)) return;
      const lines = clippedLines(geometry, safeBounds);
      if (!lines.length) return;
      const segment = {
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
        network,
        operator,
        from,
        to,
        description,
        website,
        stops,
        lines,
      };
      segments.set(id, segment);
      routeSegments.push(segment);
      routeSegmentCount += 1;
    };

    for (const wayId of route.memberWays) {
      const way = waysById.get(wayId);
      if (way) addWay(wayId, way.geometry, way.tags);
    }
    for (const way of route.inlineWays) {
      addWay(way.ref, way.geometry, way.tags);
    }
    if (routeSegments.length) routeSegmentBuckets.push(routeSegments);
  }
  const selected = [];
  for (let index = 0; selected.length < MAX_ROUTE_SEGMENTS; index += 1) {
    let added = false;
    for (const bucket of routeSegmentBuckets) {
      const segment = bucket[index];
      if (!segment) continue;
      selected.push(segment);
      added = true;
      if (selected.length >= MAX_ROUTE_SEGMENTS) break;
    }
    if (!added) break;
  }
  return buildLineOverviews(selected);
}

/** Source for viewport-bounded static OSM transit route relations. */
export function createTransitRouteSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async requestRoutes(bounds, { signal } = {}) {
      const safeBounds = clampTransitRouteBounds(bounds);
      signal?.throwIfAborted();
      const response = await fetchOsmCacheTiles(safeBounds, {
        sourceId: 'transit-routes',
        buildQuery: buildTransitRouteQuery,
        fetchImpl,
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
