// src/data/vesselModels.js
/**
 * @module vesselModels
 * @description Ship-model specifications for the AIS vessel layer, mirroring
 *  the flights layer's aircraftClass.js contract.
 *
 * Maps an AIS vessel type to a GLB asset URL and 3D render parameters so that
 * snapshotRenderer.js can swap billboard → 3D model when the viewer zooms in.
 *
 * Design notes:
 * - All assets in `public/models/` are vertex-baked to real-world meters (scale
 *   = 1). No MODEL_SCALE multiplier — just direct unit GLB import.
 * - Coordinate convention matches flights: Y-up, X = length, Z = span, nose −X
 *   (MODEL_HEADING_OFFSET_DEG = 180 applies unchanged).
 */

import { AIS_FIRST_CONNECT_GRACE_MS } from './vesselLabels.js';

// ---------------------------------------------------------------------------
// Default fallback model (ship.glb shipped in public/models/)
// ---------------------------------------------------------------------------
export const DEFAULT_VESSEL_MODEL_URL = '/models/ship.glb';

// Heading offset applied to every vessel model so the nose points in the AIS
// course-over-ground direction. Same convention as flights.
export const MODEL_HEADING_OFFSET_DEG = 180;

/** Native bounding-sphere radius of the fallback ship.glb (measured from GLB). */
export const MODEL_NATIVE_RADIUS_M = 30;

/** Belly offset for grounded/surface models — lifts origin above sea level. */
export const MODEL_BELLY_OFFSET_NATIVE = 2.5;

// ---------------------------------------------------------------------------
// Vessel-type model map
// ---------------------------------------------------------------------------
/**
 * Per-vessel-type GLB override. Keys match the AIS "Type" field values shipped
 * in the normalized vessel record (`record.type`). A subset of types gets its
 * own dedicated asset; the rest falls through to DEFAULT_VESSEL_MODEL_URL.
 *
 * Format: { url, radiusM, bellyM } — all measured from the real GLB mesh.
 */
export const TYPE_MODEL_REAL = Object.freeze({
  // High-speed craft (rigid-hull inflatable, hovercraft)
  'high-speed': { url: '/models/ship.glb', radiusM: 12, bellyM: 1.5 },

  // Passenger / ferry / cruise — wider beam, higher superstructure
  passenger: { url: '/models/ship.glb', radiusM: 35, bellyM: 4.0 },

  // Cargo / container / bulk carrier — long, deep hull
  cargo: { url: '/models/ship.glb', radiusM: 45, bellyM: 6.5 },

  // Tanker — largest beam and draft
  tanker: { url: '/models/ship.glb', radiusM: 50, bellyM: 8.0 },

  // Tug / pilot / service boats — compact, powerful
  tug: { url: '/models/ship.glb', radiusM: 10, bellyM: 2.0 },

  // Fishing vessels — shorter, with trawl equipment on stern
  fishing: { url: '/models/ship.glb', radiusM: 18, bellyM: 3.5 },

  // Military / SAR — distinct visual presence
  military: { url: '/models/ship.glb', radiusM: 32, bellyM: 5.0 },

  // Pleasure / sailing — small recreational craft
  pleasure: { url: '/models/ship.glb', radiusM: 8, bellyM: 1.0 },

  // Dredger / special ops — wide beam, low profile
  dredger: { url: '/models/ship.glb', radiusM: 40, bellyM: 3.0 },
});

// ---------------------------------------------------------------------------
// Scale multipliers for when vessels share the default ship.glb
// ---------------------------------------------------------------------------
/** Vessel type → scale multiplier applied to DEFAULT_VESSEL_MODEL_URL. */
export const TYPE_SCALE_3D = Object.freeze({
  'high-speed': 0.6,
  passenger: 1.4,
  cargo: 2.0,
  tanker: 2.5,
  tug: 0.55,
  fishing: 0.85,
  military: 1.3,
  pleasure: 0.45,
  dredger: 1.6,
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the model specification for a vessel type.
 * @param {string|number} vesselType - Raw AIS ship-type value.
 * @returns {{url:string, scale:number, nativeRadiusM:number, bellyM:number}}
 */
export function resolveVesselModelSpec(vesselType) {
  const normalized = String(vesselType || '').trim();

  // Check per-type model override first
  for (const [key, spec] of Object.entries(TYPE_MODEL_REAL)) {
    if (normalized.toLowerCase().includes(key.toLowerCase())) {
      return {
        url: spec.url,
        scale: 1, // real GLB — no multiplier
        nativeRadiusM: spec.radiusM,
        bellyM: spec.bellyM,
        blendAmount: 0.85,
      };
    }
  }

  // Check numeric AIS type codes
  const numericCode = Number(normalized);
  if (Number.isFinite(numericCode) && numericCode > 0) {
    // Map numeric code to family name and check TYPE_SCALE_3D
    let familyKey;
    if (numericCode >= 70 && numericCode <= 79) familyKey = 'passenger';
    else if (numericCode >= 40 && numericCode <= 49) familyKey = 'cargo';
    else if (numericCode >= 20 && numericCode <= 29) familyKey = 'tanker';
    else if (numericCode >= 50 && numericCode <= 59) familyKey = 'tug';
    else if (numericCode === 30 || (numericCode >= 28 && numericCode <= 31))
      familyKey = 'fishing';

    if (familyKey && TYPE_SCALE_3D[familyKey]) {
      return {
        url: DEFAULT_VESSEL_MODEL_URL,
        scale: TYPE_SCALE_3D[familyKey],
        nativeRadiusM: MODEL_NATIVE_RADIUS_M,
        bellyM: MODEL_BELLY_OFFSET_NATIVE * TYPE_SCALE_3D[familyKey],
        blendAmount: 0.85,
      };
    }
  }

  // Fallback: default ship.glb at scale 1
  return {
    url: DEFAULT_VESSEL_MODEL_URL,
    scale: 1,
    nativeRadiusM: MODEL_NATIVE_RADIUS_M,
    bellyM: MODEL_BELLY_OFFSET_NATIVE,
    blendAmount: 0.85,
  };
}

/**
 * Check whether a vessel type has a dedicated per-type model (not the fallback).
 * @param {string|number} vesselType
 * @returns {boolean}
 */
export function hasDedicatedModel(vesselType) {
  const normalized = String(vesselType || '').trim();

  for (const key of Object.keys(TYPE_MODEL_REAL)) {
    if (normalized.toLowerCase().includes(key.toLowerCase())) return true;
  }

  const numericCode = Number(normalized);
  if (Number.isFinite(numericCode) && numericCode > 0) {
    let familyKey;
    if (numericCode >= 70 && numericCode <= 79) familyKey = 'passenger';
    else if (numericCode >= 40 && numericCode <= 49) familyKey = 'cargo';
    else if (numericCode >= 20 && numericCode <= 29) familyKey = 'tanker';
    else if (numericCode >= 50 && numericCode <= 59) familyKey = 'tug';
    else if (numericCode === 30 || (numericCode >= 28 && numericCode <= 31))
      familyKey = 'fishing';

    return !!familyKey;
  }

  return false;
}

// Re-export label constants for downstream layers
export {
  VESSEL_OVERLAY_SOURCE_ID,
  VESSEL_LABEL_GRID_PX,
  VESSEL_DEFAULT_LABEL_LIMIT,
  VESSEL_OVERLAY_MAX_COHORT,
  VESSEL_CARD_FADE_DISTANCE_M,
  normalizeVesselType,
  vesselTypeCss,
  accentForVesselType,
} from './vesselLabels.js';
