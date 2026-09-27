/** Card model for one selected NWS alert. Pure — no Cesium types. */

export const NWS_ALERT_OVERLAY_SOURCE_ID = 'nws-alerts';

/** CSS accent for an alert by NWS severity (matches the polygon fill/outline). */
export function severityAccent(severity) {
  switch (severity) {
    case 'Extreme':
      return '#ff3b30';
    case 'Severe':
      return '#ff7a00';
    case 'Moderate':
      return '#ffb300';
    case 'Minor':
      return '#39d0ff';
    default:
      return '#8bc34a';
  }
}

/** Map the NWS event name to a compact type badge for selected cards. */
export function alertTypeBadge(event) {
  const value = String(event || '').toUpperCase();
  if (value.includes('TORNADO')) return { label: 'TORNADO', accent: '#ff3b30' };
  if (value.includes('THUNDERSTORM'))
    return { label: 'THUNDERSTORM', accent: '#ff7a00' };
  if (value.includes('FLOOD')) return { label: 'FLOOD', accent: '#39d0ff' };
  if (
    value.includes('WINTER') ||
    value.includes('BLIZZARD') ||
    value.includes('SNOW') ||
    value.includes('ICE')
  )
    return { label: 'WINTER', accent: '#8bd3ff' };
  if (
    value.includes('HURRICANE') ||
    value.includes('TROPICAL') ||
    value.includes('TYPHOON')
  )
    return { label: 'TROPICAL', accent: '#c084fc' };
  if (value.includes('FIRE') || value.includes('RED FLAG'))
    return { label: 'FIRE WEATHER', accent: '#ff5c35' };
  if (value.includes('HEAT')) return { label: 'HEAT', accent: '#ffb300' };
  if (value.includes('WIND')) return { label: 'WIND', accent: '#ffd166' };
  if (value.includes('COASTAL') || value.includes('SURF'))
    return { label: 'COASTAL', accent: '#55d6be' };
  return { label: 'WEATHER', accent: '#8bc34a' };
}

/** Shoelace area (degree², sign dropped) — relative sizes only. */
function ringArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum / 2);
}

/**
 * Anchor point for the alert card: the centroid of the largest polygon's
 * outer ring. Degrees, so callers own the Cartesian conversion.
 * @param {Array<Array<Array<[number, number]>>>} polygons - Normalized row polygons.
 * @returns {{lon: number, lat: number}}
 */
export function alertAnchorDegrees(polygons) {
  let best = null;
  let bestArea = -1;
  for (const rings of polygons) {
    const outer = rings[0];
    const area = ringArea(outer);
    if (area > bestArea) {
      bestArea = area;
      best = outer;
    }
  }
  let lon = 0;
  let lat = 0;
  const count = best.length - 1;
  for (let i = 0; i < count; i++) {
    lon += best[i][0];
    lat += best[i][1];
  }
  return { lon: lon / count, lat: lat / count };
}

function formatAge(deltaMs) {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return null;
  const hours = Math.floor(deltaMs / 3600000);
  if (hours < 1) return `${Math.max(1, Math.floor(deltaMs / 60000))}m`;
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Build the overlay-host entry for one selected alert. The caller supplies
 * `position` (Cartesian) separately — this model stays JSON-safe for tests.
 * @param {Object} row - Normalized alert row (see records.js).
 * @param {number} nowMs - Current epoch milliseconds.
 * @returns {Object} World-overlay entry without `position`.
 */
export function buildAlertCard(row, nowMs) {
  const badge = alertTypeBadge(row.event);
  const facts = [row.severity];
  if (row.certainty) facts.push(row.certainty);
  if (row.urgency) facts.push(row.urgency);
  if (row.areaDesc) facts.push(row.areaDesc);

  const details = [facts.join(' · ')];
  if (row.headline) details.push(row.headline);
  const effectiveAge = row.effective
    ? formatAge(nowMs - Date.parse(row.effective))
    : null;
  const expiresIn = row.expires
    ? formatAge(Date.parse(row.expires) - nowMs)
    : null;
  const times = [];
  if (effectiveAge) times.push(`issued ${effectiveAge} ago`);
  if (expiresIn) times.push(`expires in ${expiresIn}`);
  if (times.length) details.push(times.join(' · '));
  if (row.senderName) details.push(row.senderName);
  if (row.instruction) details.push(row.instruction);

  const title = `${row.event.toUpperCase()}`;
  return {
    id: `nws-alert-card:${row.stableId}`,
    selected: true,
    interactive: false,
    badge: badge.label,
    badgeAccent: badge.accent,
    title,
    details,
    accent: severityAccent(row.severity),
    priority: Number.MAX_SAFE_INTEGER,
    maxWidth: 360,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}
