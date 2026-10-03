import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';

/**
 * @file TomTom traffic-flow vector-tile client: fetch + MVT decode.
 *
 * Fetches flow tiles from the local `/api/tomtom/flow/{z}/{x}/{y}.pbf` proxy
 * (the TomTom key never reaches the browser) and decodes the Mapbox Vector
 * Tile layer "Traffic flow" into plain lon/lat polylines with congestion
 * attributes. Consumed by the traffic layer's live mode
 * (`src/data/traffic.js` → `src/data/flowMatch.js`).
 *
 * Segment shape: `{coords: [[lon,lat],…], trafficLevel: 0..1, roadType: string,
 * closure: boolean}` — `trafficLevel` is TomTom's current/free-flow speed
 * ratio (1 = free flow). Features with a missing/non-finite `traffic_level`
 * are skipped unless `road_closure` is true (closures decode with level 0).
 *
 * Deps: `pbf@5` (PbfReader) + `@mapbox/vector-tile@3` — both tiny and
 * tree-shakeable; decoding happens client-side so the proxy stays a dumb
 * binary cache.
 *
 * @module data/flowTiles
 */

const FLOW_LAYER_NAME = 'Traffic flow';

const FLOW_GEOMETRY_TOLERANCE_DEG = 0.00005;

function squaredDistance(point, start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  if (dx === 0 && dy === 0) {
    const px = point[0] - start[0];
    const py = point[1] - start[1];
    return px * px + py * py;
  }
  const t = Math.max(
    0,
    Math.min(
      1,
      ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) /
        (dx * dx + dy * dy),
    ),
  );
  const px = start[0] + t * dx - point[0];
  const py = start[1] + t * dy - point[1];
  return px * px + py * py;
}

function simplifyRange(points, first, last, toleranceSquared, keep) {
  let furthest = toleranceSquared;
  let furthestIndex = -1;
  for (let index = first + 1; index < last; index++) {
    const distance = squaredDistance(
      points[index],
      points[first],
      points[last],
    );
    if (distance > furthest) {
      furthest = distance;
      furthestIndex = index;
    }
  }
  if (furthestIndex < 0) return;
  keep[furthestIndex] = true;
  simplifyRange(points, first, furthestIndex, toleranceSquared, keep);
  simplifyRange(points, furthestIndex, last, toleranceSquared, keep);
}

export function simplifyFlowLine(
  points,
  tolerance = FLOW_GEOMETRY_TOLERANCE_DEG,
) {
  if (!Array.isArray(points) || points.length < 3 || tolerance <= 0)
    return points;
  const keep = new Array(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  simplifyRange(points, 0, points.length - 1, tolerance * tolerance, keep);
  return points.filter((_point, index) => keep[index]);
}

export function decodeFlowTile(data, z, x, y) {
  let layer;
  try {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    const tile = new VectorTile(new PbfReader(bytes));
    layer = tile.layers[FLOW_LAYER_NAME];
  } catch {
    return [];
  }
  if (!layer) return [];

  const segments = [];
  for (let i = 0; i < layer.length; i++) {
    let feature;
    let geometry;
    try {
      feature = layer.feature(i);
      geometry = feature.toGeoJSON(x, y, z).geometry;
    } catch {
      continue; // one malformed feature must not drop the tile
    }
    const props = feature.properties || {};
    const closure =
      props.road_closure === true || props.road_closure === 'true';
    const rawLevel = props.traffic_level;
    const hasLevel = typeof rawLevel === 'number' && Number.isFinite(rawLevel);
    // Skip features we can't color — unless closed (closures render dot-free
    // regardless of level, so they stay useful without one).
    if (!hasLevel && !closure) continue;
    const trafficLevel = hasLevel ? Math.min(1, Math.max(0, rawLevel)) : 0;
    const roadType = typeof props.road_type === 'string' ? props.road_type : '';

    const lines =
      geometry.type === 'LineString'
        ? [geometry.coordinates]
        : geometry.type === 'MultiLineString'
          ? geometry.coordinates
          : [];
    for (const coords of lines) {
      if (!Array.isArray(coords) || coords.length < 2) continue;
      segments.push({
        coords: simplifyFlowLine(coords),
        trafficLevel,
        roadType,
        closure,
      });
    }
  }
  return segments;
}
