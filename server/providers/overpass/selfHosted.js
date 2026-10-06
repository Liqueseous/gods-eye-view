import { OVERPASS_BBOX_RE, resolveOverpassUpstreams } from './constants.js';

const SELF_HOSTED_URL = String(
  process.env.OVERPASS_SELF_HOSTED_URL || '',
).trim();

// Geofabrik "north-america" extract coverage (Canada, US, Mexico, Central
// America, Caribbean) — generous on purpose. A query outside the imported
// data returns an empty (but VALID) result, which the fan-out would treat as
// a real answer and cache for a day; overshooting the box costs one wasted
// local request, undershooting it silently blanks a region.
const DEFAULT_COVERAGE = { south: 5, west: -170, north: 85, east: -50 };

function parseCoverage() {
  const raw = process.env.OVERPASS_SELF_HOSTED_BBOX;
  if (!raw) return DEFAULT_COVERAGE;
  const [south, west, north, east] = raw.split(',').map(Number);
  const parts = [south, west, north, east];
  return parts.length === 4 && parts.every(Number.isFinite)
    ? { south, west, north, east }
    : DEFAULT_COVERAGE;
}

const COVERAGE = parseCoverage();

/** First `(s,w,n,e)` bbox tuple in an Overpass QL body, or null. */
function firstBbox(body) {
  let query = String(body || '');
  try {
    const data = new URLSearchParams(query).get('data');
    if (data) query = data;
  } catch {
    // Treat non-form input as raw Overpass QL for direct callers and tests.
  }
  const match = OVERPASS_BBOX_RE.exec(query);
  if (!match) return null;
  const [south, west, north, east] = match[0]
    .slice(1, -1)
    .split(',')
    .map(Number);
  const parts = [south, west, north, east];
  return parts.every(Number.isFinite) ? { south, west, north, east } : null;
}

function withinCoverage(bbox) {
  return (
    bbox.south >= COVERAGE.south &&
    bbox.north <= COVERAGE.north &&
    bbox.west >= COVERAGE.west &&
    bbox.east <= COVERAGE.east
  );
}

/**
 * Upstream list for one query. The self-hosted instance is tried FIRST, but
 * only when the query's bbox is fully inside its imported coverage — outside
 * that box it holds no data at all, so skip it and go straight to the public
 * mirrors rather than caching a false empty answer.
 */
function resolveOverpassEndpoints(body) {
  const upstreams = resolveOverpassUpstreams();
  if (!SELF_HOSTED_URL) return upstreams;
  const bbox = firstBbox(body);
  if (!bbox || !withinCoverage(bbox)) return upstreams;
  return [SELF_HOSTED_URL, ...upstreams];
}

export { resolveOverpassEndpoints };
