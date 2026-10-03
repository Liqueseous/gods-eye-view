const runtimeEnv =
  typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env : {};

export const APP_VERSION = String(runtimeEnv.GEV_VERSION || '0.1.1');
export const APP_BUILD_NUMBER = String(runtimeEnv.GEV_BUILD_NUMBER || 'dev');
export const APP_SOURCE_VERSION = String(
  runtimeEnv.GEV_SOURCE_VERSION || APP_VERSION,
);
export const APP_SOURCE_COMMIT = String(
  runtimeEnv.GEV_SOURCE_COMMIT || 'unknown',
);
export const APP_BUILD_LABEL = `v${APP_VERSION} · BUILD ${APP_BUILD_NUMBER}`;
export const APP_SOURCE_LABEL = `SRC ${APP_SOURCE_VERSION}@${APP_SOURCE_COMMIT}`;
