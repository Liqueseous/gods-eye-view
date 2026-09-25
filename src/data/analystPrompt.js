// Order matters: `.find()` returns the first match, so a specific alias
// (e.g. "fire perimeters", "military flights") must be tested before the
// generic one its words overlap with ("fires", "flights").
const LAYER_ALIASES = [
  { layer: 'ais-live-vessels', pattern: /\b(?:ships?|vessels?)\b/i, label: 'ships' },
  {
    layer: 'fire-perimeters',
    pattern: /\b(?:fire\s*perimeters?|wildfire\s*perimeters?|burn\s*(?:areas?|scars?))\b/i,
    label: 'fire perimeters',
  },
  { layer: 'local-firms', pattern: /\b(?:fires?|wildfires?|hotspots?)\b/i, label: 'fires' },
  { layer: 'local-dams', pattern: /\b(?:dams?|reservoirs?)\b/i, label: 'dams' },
  {
    layer: 'local-datacenters',
    pattern: /\b(?:data\s*centers?|datacenters?|server\s*farms?)\b/i,
    label: 'datacenters',
  },
  {
    layer: 'alpr-cameras',
    pattern: /\b(?:alpr|license[- ]plate\s*(?:readers?|cameras?)|plate\s*readers?)\b/i,
    label: 'ALPR cameras',
  },
  {
    layer: 'earthquakes',
    pattern: /\b(?:earthquakes?|quakes?|seismic\s*events?)\b/i,
    label: 'earthquakes',
  },
  {
    layer: 'military',
    pattern: /\b(?:military\s*(?:flights?|aircraft|jets?|planes?)|warplanes?|fighter\s*jets?)\b/i,
    label: 'military flights',
  },
  { layer: 'flights', pattern: /\b(?:flights?|aircraft|planes?)\b/i, label: 'flights' },
  { layer: 'satellites', pattern: /\bsatellites?\b/i, label: 'satellites' },
];

/** Layers whose sightable numeric field a "biggest/highest" ask should sort by. */
const SORT_FIELD_BY_LAYER = {
  'local-firms': 'frp',
  'fire-perimeters': 'acres',
  earthquakes: 'magnitude',
  flights: 'altitudeM',
  military: 'altitudeM',
  satellites: 'altitudeM',
};

/** Layers that carry an altitude field an "above/below N feet" ask can filter. */
const ALTITUDE_LAYERS = new Set(['flights', 'military', 'satellites']);

function clean(value) {
  return String(value || '').trim().replace(/[?.!,]+$/, '');
}

function parseDistance(prompt) {
  const match = prompt.match(/\b(?:within|inside|under)\s+(\d+(?:\.\d+)?)\s*(km|kilometers?|mi|miles?)\b/i);
  if (!match) return null;
  const amount = Number(match[1]);
  return {
    amount: match[2].toLowerCase().startsWith('mi') ? amount * 1.60934 : amount,
  };
}

function parseLayer(prompt) {
  return LAYER_ALIASES.find(({ pattern }) => pattern.test(prompt)) || null;
}

/** Altitude filter ("above/over 40,000 feet", "below 10,000 ft") for flight-like layers. */
function parseAltitudeFilter(prompt, layerKey) {
  if (!ALTITUDE_LAYERS.has(layerKey)) return null;
  const above = prompt.match(/\b(?:above|over|higher than)\s+([\d,]+)\s*(?:ft|feet)\b/i);
  const below = prompt.match(/\b(?:below|under|lower than)\s+([\d,]+)\s*(?:ft|feet)\b/i);
  const match = above || below;
  if (!match) return null;
  const feet = Number(match[1].replace(/,/g, ''));
  if (!Number.isFinite(feet)) return null;
  const meters = Math.round(feet * 0.3048);
  return { field: 'altitudeM', op: above ? 'gt' : 'lt', value: meters };
}

/** Speed filter ("faster than 15 knots") for the vessels layer. */
function parseSpeedFilter(prompt, layerKey) {
  if (layerKey !== 'ais-live-vessels') return null;
  const match = prompt.match(/\b(?:faster than|above|over)\s+(\d+(?:\.\d+)?)\s*(?:knots|kts)\b/i);
  if (!match) return null;
  return { field: 'speedKts', op: 'gt', value: Number(match[1]) };
}

/** Magnitude filter ("above magnitude 5", "greater than 6") for earthquakes. */
function parseMagnitudeFilter(prompt, layerKey) {
  if (layerKey !== 'earthquakes') return null;
  const match = prompt.match(/\b(?:above|over|greater than)\s+(?:magnitude\s+)?(\d+(?:\.\d+)?)\b/i);
  if (!match) return null;
  return { field: 'magnitude', op: 'gt', value: Number(match[1]) };
}

/** Translate a small, explicit analyst vocabulary into analystEngine specs. */
export function parseAnalystPrompt(input) {
  const prompt = clean(input);
  if (!prompt) return { ok: false, error: 'Enter a question for the analyst.' };

  const landmarkMatch = prompt.match(
    /^(?:what am i looking at|what(?:'s| is) (?:currently )?(?:in view|this)|what is(?!\s+(?:happening|going|the situation|near|over|around)\b)|tell me about|explain|what(?:'s| is) the history of|history of)\s*(.*)$/i,
  );
  if (landmarkMatch) {
    return {
      ok: true,
      kind: 'landmark',
      landmarkName: clean(landmarkMatch[1]),
      layerLabel: 'landmark',
    };
  }

  const layer = parseLayer(prompt);
  if (!layer) {
    return {
      ok: false,
      error:
        'Name a supported layer: flights, military flights, ships, fires, fire perimeters, earthquakes, satellites, dams, datacenters, or ALPR cameras.',
    };
  }

  const distance = parseDistance(prompt);
  const distanceTarget = prompt.match(/\b(?:within|inside|under)\s+\d+(?:\.\d+)?\s*(?:km|kilometers?|mi|miles?)\s+(?:of|from)\s+(.+)$/i);
  if (distance && distanceTarget) {
    return {
      ok: false,
      error: 'Targeted radius queries are not available yet. Ask for a radius in view or name a region instead.',
    };
  }
  const scopeMatch = prompt.match(/\b(?:over|near|around|in)\s+(.+?)(?=\s+(?:within|inside|under)\b|$)/i);
  const destinationMatch = prompt.match(/\b(?:headed|heading|bound)\s+(?:to|for)\s+(.+)$/i);
  const filters = [];

  if (destinationMatch && layer.layer === 'ais-live-vessels') {
    filters.push({ field: 'destination', op: 'contains', value: clean(destinationMatch[1]) });
  }
  const altitudeFilter = parseAltitudeFilter(prompt, layer.layer);
  if (altitudeFilter) filters.push(altitudeFilter);
  const speedFilter = parseSpeedFilter(prompt, layer.layer);
  if (speedFilter) filters.push(speedFilter);
  const magnitudeFilter = parseMagnitudeFilter(prompt, layer.layer);
  if (magnitudeFilter) filters.push(magnitudeFilter);

  const scopeName = scopeMatch ? clean(scopeMatch[1]) : '';
  const scope = distance
    ? { kind: 'radius', km: Math.max(1, Math.round(distance.amount * 10) / 10) }
    : scopeName && !/^view$/i.test(scopeName)
      ? { kind: 'region', name: scopeName }
      : { kind: 'view' };

  const sortBy = /\b(?:biggest|largest|strongest|highest)\b/i.test(prompt)
    ? SORT_FIELD_BY_LAYER[layer.layer] || null
    : /\bclosest|nearest\b/i.test(prompt)
      ? 'distance'
      : null;

  return {
    ok: true,
    spec: {
      layers: [layer.layer],
      scope,
      filters,
      sortBy,
      sortDir: sortBy === 'distance' ? 'asc' : undefined,
      limit: 10,
    },
    layerLabel: layer.label,
  };
}
