/** Validate a complete NWS alerts/active feed before it replaces the last good snapshot. */

const SEVERITIES = new Set([
  'Extreme',
  'Severe',
  'Moderate',
  'Minor',
  'Unknown',
]);

function validRing(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return false;
  for (const position of ring) {
    if (!Array.isArray(position) || position.length < 2) return false;
    const [lon, lat] = position;
    if (!Number.isFinite(lon) || Math.abs(lon) > 180) return false;
    if (!Number.isFinite(lat) || Math.abs(lat) > 90) return false;
  }
  return true;
}

/** Normalize Polygon/MultiPolygon geometry to an array of polygons (each an
 * array of rings). Returns null on malformed geometry, [] when absent. */
function normalizePolygons(geometry) {
  if (geometry == null) return [];
  if (typeof geometry !== 'object') return null;
  let polygons;
  if (geometry.type === 'Polygon') polygons = [geometry.coordinates];
  else if (geometry.type === 'MultiPolygon') polygons = geometry.coordinates;
  else return null;
  if (!Array.isArray(polygons)) return null;
  const result = [];
  for (const rings of polygons) {
    if (!Array.isArray(rings) || !rings.length) continue;
    if (!rings.every(validRing)) return null;
    result.push(rings);
  }
  return result;
}

function textOrNull(value, max = 4000) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function isoOrNull(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? value : null;
}

export function normalizeNwsAlertSnapshot(geojson) {
  if (!Array.isArray(geojson?.features)) return null;
  const rows = [];
  const ids = new Set();
  for (const feature of geojson.features) {
    const properties = feature?.properties;
    if (
      !properties ||
      typeof properties !== 'object' ||
      Array.isArray(properties)
    )
      continue;
    // Only alerts with inline polygon/multipolygon geometry are rendered;
    // zone-only (UGC) alerts require a second fetch this layer skips for now.
    const polygons = normalizePolygons(feature.geometry);
    if (polygons === null || !polygons.length) continue;
    const stableId = textOrNull(properties.id ?? feature.id, 256);
    if (!stableId || ids.has(stableId)) continue;
    if (properties.status !== 'Actual') continue;
    const event = textOrNull(properties.event, 128);
    if (!event) continue;
    const severity = SEVERITIES.has(properties.severity)
      ? properties.severity
      : 'Unknown';
    ids.add(stableId);
    rows.push({
      stableId,
      event,
      severity,
      urgency: textOrNull(properties.urgency, 32),
      certainty: textOrNull(properties.certainty, 32),
      headline: textOrNull(properties.headline, 512),
      description: textOrNull(properties.description, 4000),
      instruction: textOrNull(properties.instruction, 2000),
      areaDesc: textOrNull(properties.areaDesc, 512),
      senderName: textOrNull(properties.senderName, 128),
      effective: isoOrNull(properties.effective),
      expires: isoOrNull(properties.expires),
      polygons,
    });
  }
  return rows;
}
