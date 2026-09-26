import { createTunnelsLayer } from '../../layers/tunnels/index.js';
import { overlayHost } from './overlayHost.js';

/** Wire OSM tunnel geometry to the shared world-label overlay. */
export function createApplicationTunnels({ source, trafficLayer, transitLayer }) {
  return createTunnelsLayer({
    source,
    services: {
      overlays: overlayHost,
      raiseRoutesAboveTunnels: () => {
        trafficLayer?.raiseHeatLinesToTop?.();
        transitLayer?.raiseRouteLinesToTop?.();
      },
    },
  });
}
