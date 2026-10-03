const clean = (value) => String(value || '').trim();
export const GOOGLE_3D_QUALITY_STORAGE_KEY = 'gev-google-3d-quality';
export const GOOGLE_3D_QUALITY_LEVELS = Object.freeze({
  performance: 64,
  balanced: 16,
  high: 1,
});

export function getGoogle3dQuality(storage = globalThis.localStorage) {
  let value = 'balanced';
  try {
    value = storage?.getItem(GOOGLE_3D_QUALITY_STORAGE_KEY) || value;
  } catch {
    // Private or restricted storage keeps the default.
  }
  return Object.hasOwn(GOOGLE_3D_QUALITY_LEVELS, value) ? value : 'balanced';
}

export function setGoogle3dQuality(value, storage = globalThis.localStorage) {
  const quality = Object.hasOwn(GOOGLE_3D_QUALITY_LEVELS, value)
    ? value
    : 'balanced';
  try {
    storage?.setItem(GOOGLE_3D_QUALITY_STORAGE_KEY, quality);
  } catch {
    // Keep the in-memory choice for this load when storage is unavailable.
  }
  return quality;
}

export function google3dQualityError(value) {
  const quality = Object.hasOwn(GOOGLE_3D_QUALITY_LEVELS, value)
    ? value
    : getGoogle3dQuality();
  return GOOGLE_3D_QUALITY_LEVELS[quality];
}

/**
 * Decide which map provider can deliver the best startup experience.
 * @param {{googleApiKey?: string, cesiumToken?: string}} credentials
 * @returns {'google-direct'|'google-ion'|'osm'}
 */
export function selectMapStartupRoute({
  googleApiKey = '',
  cesiumToken = '',
} = {}) {
  if (clean(googleApiKey)) return 'google-direct';
  if (clean(cesiumToken)) return 'google-ion';
  return 'osm';
}

/**
 * Load Google Photorealistic 3D Tiles through direct Google access when
 * configured, otherwise through Cesium ion's hosted Google asset. If the
 * direct request fails and an ion token is available, ion is the recovery path.
 *
 * @param {object} Cesium
 * @param {{googleApiKey?: string, cesiumToken?: string}} credentials
 * @returns {Promise<{tileset: object|null, route: 'google-direct'|'google-ion'|'osm', errors: Error[]}>}
 */
export async function loadPhotorealisticTileset(
  Cesium,
  { googleApiKey = '', cesiumToken = '' } = {},
) {
  const googleKey = clean(googleApiKey);
  const ionToken = clean(cesiumToken);
  const errors = [];

  const attempts = [];
  if (googleKey) attempts.push({ route: 'google-direct', googleKey });
  if (ionToken) attempts.push({ route: 'google-ion', googleKey: undefined });

  for (const attempt of attempts) {
    try {
      const tileset = attempt.googleKey
        ? await createGoogleDirectTileset(Cesium, attempt.googleKey)
        : await createGoogleIonTileset(Cesium, ionToken);
      return { tileset, route: attempt.route, errors };
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }

  return { tileset: null, route: 'osm', errors };
}

/** Pass credentials to the source instead of changing SDK-wide defaults. */
export function createGoogleDirectTileset(Cesium, key) {
  key = clean(key);
  if (!key) throw new Error('Google 3D requires an explicit browser key');
  // Tiles keep drawing their own texture while draped weather loads.
  // progressiveResolutionHeightFraction: 0.1 — the default (0.3) coarse-previews
  // any tile filling over 30% of screen height, catching most of the center/nadir
  // view and reading as a blurry center; 0.1 only coarse-previews the handful of
  // tiles large enough to matter for a quick first paint (very close/near-camera).
  return Cesium.createGooglePhotorealistic3DTileset(
    { key, onlyUsingWithGoogleGeocoder: true },
    {
      asynchronouslyLoadImagery: true,
      progressiveResolutionHeightFraction: 0.1,
      // Default (16) lets zoomed-out views settle for a coarser tile than
      // zoomed-in ones; lower keeps fine detail visible at a farther distance.
      maximumScreenSpaceError:
        GOOGLE_3D_QUALITY_LEVELS[getGoogle3dQuality()],
      // This optimization deliberately lowers resolution far from the camera
      // at low altitude/horizon views — reads as blur when zoomed out close
      // to the ground, which is exactly this app's low-altitude camera use.
      dynamicScreenSpaceError: false,
      // Lets a tile keep rendering alongside its already-loaded children
      // instead of being replaced outright, softening LOD pop-in on refine.
      skipLevelOfDetail: true,
      baseScreenSpaceError: 1024,
    },
  );
}

export async function createGoogleIonTileset(
  Cesium,
  accessToken,
  { signal } = {},
) {
  accessToken = clean(accessToken);
  if (!accessToken)
    throw new Error('Google 3D through ion requires an explicit token');
  signal?.throwIfAborted();
  const resource = await Cesium.IonResource.fromAssetId(2275207, {
    accessToken,
  });
  signal?.throwIfAborted();
  // Match the installed SDK's Google helper rendering/cache defaults.
  return Cesium.Cesium3DTileset.fromUrl(resource, {
    cacheBytes: 1536 * 1024 * 1024,
    maximumCacheOverflowBytes: 1024 * 1024 * 1024,
    enableCollision: true,
    // Tiles keep drawing their own texture while draped weather loads.
    asynchronouslyLoadImagery: true,
    // See createGoogleDirectTileset — coarse-preview only the largest tiles.
    progressiveResolutionHeightFraction: 0.1,
    // See createGoogleDirectTileset — fine detail visible at a farther distance.
    maximumScreenSpaceError:
      GOOGLE_3D_QUALITY_LEVELS[getGoogle3dQuality()],
    // See createGoogleDirectTileset — no horizon-distance detail falloff.
    dynamicScreenSpaceError: false,
    // See createGoogleDirectTileset — softens LOD pop-in on refine.
    skipLevelOfDetail: true,
    baseScreenSpaceError: 1024,
  });
}
