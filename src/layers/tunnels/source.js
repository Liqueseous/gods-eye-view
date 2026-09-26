const MAX_QUERY_SPAN_DEG = 5;
const MAX_QUERY_TIMEOUT_SEC = 20;
const RAILWAY_TUNNEL_TYPES = new Set([
  'rail',
  'light_rail',
  'subway',
  'tram',
  'narrow_gauge',
  'monorail',
  'funicular',
]);

function cleanTag(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  return text ? text.slice(0, 120) : null;
}

/** Decode bounded OSM ways into road/rail tunnel records. */
export function normalizeTunnelWays(payload) {
  const records = new Map();
  for (const element of payload?.elements || []) {
    const tags = element?.tags;
    if (
      element?.type !== 'way' ||
      !Array.isArray(element.geometry) ||
      element.geometry.length < 2 ||
      !tags ||
      !cleanTag(tags.tunnel) ||
      cleanTag(tags.tunnel).toLowerCase() === 'no'
    )
      continue;

    const railway = cleanTag(tags.railway);
    const highway = cleanTag(tags.highway);
    const kind = RAILWAY_TUNNEL_TYPES.has(railway)
      ? 'rail'
      : highway
        ? 'road'
        : null;
    const id = String(element.id ?? '');
    if (!kind || !id || records.has(id)) continue;

    const coordinates = element.geometry
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
    if (coordinates.length < 2) continue;

    records.set(id, {
      id,
      kind,
      highway: highway || null,
      railway: railway || null,
      tunnel: cleanTag(tags.tunnel),
      name:
        cleanTag(tags.name) ||
        cleanTag(tags['name:en']) ||
        cleanTag(tags.official_name) ||
        cleanTag(tags.ref),
      coordinates,
    });
  }
  return [...records.values()];
}

function validBounds(bounds) {
  return (
    [bounds?.south, bounds?.west, bounds?.north, bounds?.east].every(
      Number.isFinite,
    ) &&
    bounds.south >= -90 &&
    bounds.north <= 90 &&
    bounds.west >= -180 &&
    bounds.east <= 180 &&
    bounds.north > bounds.south &&
    bounds.east > bounds.west &&
    bounds.north - bounds.south <= MAX_QUERY_SPAN_DEG &&
    bounds.east - bounds.west <= MAX_QUERY_SPAN_DEG
  );
}

function tunnelQuery(bounds) {
  const { south, west, north, east } = bounds;
  const bbox = `(${south},${west},${north},${east})`;
  return (
    `[out:json][timeout:${MAX_QUERY_TIMEOUT_SEC}];` +
    '(way["highway"]["tunnel"]' +
    `${bbox};` +
    'way["railway"~"^(rail|light_rail|subway|tram|narrow_gauge|monorail|funicular)$"]["tunnel"]' +
    `${bbox};);out geom qt;`
  );
}

/** Source for viewport-bounded OpenStreetMap tunnel geometry. */
export function createTunnelsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async requestTunnels(bounds, { signal } = {}) {
      if (!validBounds(bounds))
        throw new TypeError('A bounded tunnel viewport is required');
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/overpass', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(tunnelQuery(bounds)),
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
            throw new Error('Malformed tunnel snapshot');
          return { tunnels: normalizeTunnelWays(payload) };
        },
      };
    },
  };
}
