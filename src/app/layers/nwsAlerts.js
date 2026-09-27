import * as Cesium from 'cesium';
import { createNwsAlertsLayer } from '../../layers/nwsAlerts/index.js';
import { overlayHost } from './overlayHost.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/** Wire NWS active alerts into the application catalog. */
export function createApplicationNwsAlerts(options) {
  return createNwsAlertsLayer({
    overlayHost,
    screenSpaceEventHandlerFactory: (viewer) =>
      new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
    pointer: { isPointerFree },
    ...options,
  });
}
