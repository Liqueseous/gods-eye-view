import * as Cesium from 'cesium';
import { clampBoundsAroundCenter } from '../../data/trafficBounds.js';

const OVERLAY_SOURCE_ID = 'tunnels';
const OVERLAY_OPTIONS = Object.freeze({
  cohortLimit: 96,
  collisionCapacity: 64,
  moving: false,
});
const MAX_CAMERA_ALTITUDE_M = 300_000;
const QUERY_SPAN_DEG = 0.18;
const CACHE_TTL_MS = 6 * 60 * 60_000;
const ROAD_COLOR = '#F5B942';
const RAIL_COLOR = '#50D8F0';
const OUTLINE_COLOR = '#101820';
const OUTLINE_WIDTH = 5;
const ROAD_WIDTH = 2.4;
const RAIL_WIDTH = 2.8;
const GHOST_MAX_CAMERA_ALTITUDE_M = 18_000;
const GHOST_CENTER_HEIGHT_M = 4;
const GHOST_ALPHA = 0.12;

function tunnelOverlayEntry(tunnel, position) {
  if (!tunnel.name) return null;
  const accent = tunnel.kind === 'rail' ? RAIL_COLOR : ROAD_COLOR;
  return {
    id: `tunnel:${tunnel.kind}:${tunnel.id}`,
    position,
    variant: 'label',
    title: tunnel.name,
    accent,
    priority: 450,
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    minDistance: 0,
    maxDistance: 180_000,
    distanceFadeStartRatio: 0.75,
    distanceScale: {
      near: 2_000,
      nearValue: 1,
      far: 180_000,
      farValue: 0.72,
    },
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 10,
    verticalOnly: true,
    placement: 'above',
  };
}

function midpointOfLine(coordinates) {
  const distances = [];
  let total = 0;
  for (let i = 1; i < coordinates.length; i++) {
    const [lonA, latA] = coordinates[i - 1];
    const [lonB, latB] = coordinates[i];
    const distance = Cesium.Cartesian3.distance(
      Cesium.Cartesian3.fromDegrees(lonA, latA),
      Cesium.Cartesian3.fromDegrees(lonB, latB),
    );
    distances.push(distance);
    total += distance;
  }
  if (!(total > 0)) return coordinates[0];
  let remaining = total / 2;
  for (let i = 0; i < distances.length; i++) {
    const distance = distances[i];
    if (remaining <= distance) {
      const fraction = distance > 0 ? remaining / distance : 0;
      const [lonA, latA] = coordinates[i];
      const [lonB, latB] = coordinates[i + 1];
      return [lonA + (lonB - lonA) * fraction, latA + (latB - latA) * fraction];
    }
    remaining -= distance;
  }
  return coordinates.at(-1);
}

function ghostTunnelShape(kind) {
  const horizontalRadius = kind === 'rail' ? 4 : 5.5;
  const verticalRadius = kind === 'rail' ? 3.5 : 4.5;
  return Array.from({ length: 16 }, (_, index) => {
    const angle = (index * Math.PI * 2) / 16;
    return new Cesium.Cartesian2(
      Math.cos(angle) * horizontalRadius,
      Math.sin(angle) * verticalRadius,
    );
  });
}

function createOverlayPublisher(overlays) {
  let visible = false;
  return {
    show() {
      if (visible) return;
      visible = true;
      overlays.setVisible(OVERLAY_SOURCE_ID, true);
    },
    publish(entries) {
      if (visible)
        overlays.setEntries(OVERLAY_SOURCE_ID, entries, OVERLAY_OPTIONS);
    },
    hide() {
      if (!visible) return;
      overlays.clearSource(OVERLAY_SOURCE_ID);
      overlays.setVisible(OVERLAY_SOURCE_ID, false);
      visible = false;
    },
  };
}

/** Create a viewport-loaded tunnel alignment and label layer. */
export function createTunnelsLayer({ source, services }) {
  if (typeof source?.requestTunnels !== 'function')
    throw new TypeError('A tunnel viewport source is required');
  if (!services?.overlays)
    throw new TypeError('A tunnel overlay service is required');

  const publisher = createOverlayPublisher(services.overlays);
  let viewer = null;
  let enabled = false;
  let generation = 0;
  let abortController = null;
  let cameraMoveEndRemove = null;
  let groundPrimitives = [];
  let ghostPrimitives = [];
  let fallbackEntities = [];
  let lastBoundsKey = null;
  let lastUpdate = null;
  let loading = false;
  let error = null;
  let count = 0;
  let roadCount = 0;
  let railCount = 0;
  let namedCount = 0;
  let zoomLimited = false;

  function removeGeometry(
    primitives = groundPrimitives,
    entities = fallbackEntities,
  ) {
    for (const primitive of primitives)
      viewer?.scene?.groundPrimitives?.remove(primitive);
    for (const entity of entities) viewer?.entities?.remove(entity);
  }

  function clearGeometry() {
    removeGeometry();
    for (const primitive of ghostPrimitives)
      viewer?.scene?.primitives?.remove(primitive);
    groundPrimitives = [];
    ghostPrimitives = [];
    fallbackEntities = [];
    publisher.publish([]);
    count = 0;
    roadCount = 0;
    railCount = 0;
    namedCount = 0;
  }

  function cameraBounds() {
    const camera = viewer?.camera;
    const cartographic = camera?.positionCartographic;
    if (!camera || !cartographic || cartographic.height > MAX_CAMERA_ALTITUDE_M)
      return null;
    const rectangle = camera.computeViewRectangle?.(Cesium.Ellipsoid.WGS84);
    if (!rectangle) return null;
    const bounds = {
      south: Cesium.Math.toDegrees(rectangle.south),
      west: Cesium.Math.toDegrees(rectangle.west),
      north: Cesium.Math.toDegrees(rectangle.north),
      east: Cesium.Math.toDegrees(rectangle.east),
    };
    let center = {
      lat: Cesium.Math.toDegrees(cartographic.latitude),
      lon: Cesium.Math.toDegrees(cartographic.longitude),
    };
    const canvas = viewer.scene.canvas;
    const width = canvas?.clientWidth || canvas?.width || 0;
    const height = canvas?.clientHeight || canvas?.height || 0;
    if (width > 0 && height > 0 && typeof camera.pickEllipsoid === 'function') {
      const hit = camera.pickEllipsoid(
        new Cesium.Cartesian2(width / 2, height / 2),
        Cesium.Ellipsoid.WGS84,
      );
      if (hit) {
        const point = Cesium.Cartographic.fromCartesian(hit);
        center = {
          lat: Cesium.Math.toDegrees(point.latitude),
          lon: Cesium.Math.toDegrees(point.longitude),
        };
      }
    }
    return clampBoundsAroundCenter(bounds, center, QUERY_SPAN_DEG);
  }

  function makeGeometryInstances(tunnels, width) {
    return tunnels.map(
      (tunnel) =>
        new Cesium.GeometryInstance({
          id: `tunnel:${tunnel.kind}:${tunnel.id}:${width}`,
          geometry: new Cesium.GroundPolylineGeometry({
            positions: tunnel.coordinates.map(([lon, lat]) =>
              Cesium.Cartesian3.fromDegrees(lon, lat),
            ),
            width,
          }),
        }),
    );
  }

  function addGroundPrimitive(tunnels, width, cssColor) {
    if (!tunnels.length) return null;
    const primitive = new Cesium.GroundPolylinePrimitive({
      geometryInstances: makeGeometryInstances(tunnels, width),
      appearance: new Cesium.PolylineMaterialAppearance({
        material: Cesium.Material.fromType('Color', {
          color: Cesium.Color.fromCssColorString(cssColor),
        }),
      }),
      classificationType: Cesium.ClassificationType.BOTH,
      asynchronous: true,
      allowPicking: false,
    });
    return viewer.scene.groundPrimitives.add(primitive);
  }

  function addFallbackLines(tunnels, width, cssColor) {
    const material = Cesium.Color.fromCssColorString(cssColor);
    for (const tunnel of tunnels) {
      fallbackEntities.push(
        viewer.entities.add({
          id: `tunnel:${tunnel.kind}:${tunnel.id}:${width}`,
          polyline: {
            positions: tunnel.coordinates.map(([lon, lat]) =>
              Cesium.Cartesian3.fromDegrees(lon, lat),
            ),
            width,
            material,
            clampToGround: true,
            zIndex: width === OUTLINE_WIDTH ? 10 : 11,
          },
        }),
      );
    }
  }

  function ghostPathPositions(tunnel) {
    const positions = [];
    for (const [lon, lat] of tunnel.coordinates) {
      const cartographic = Cesium.Cartographic.fromDegrees(lon, lat);
      const terrainHeight = viewer.scene.globe?.getHeight?.(cartographic);
      const position = Cesium.Cartesian3.fromRadians(
        cartographic.longitude,
        cartographic.latitude,
        (Number.isFinite(terrainHeight) ? terrainHeight : 0) +
          GHOST_CENTER_HEIGHT_M,
      );
      if (
        !positions.length ||
        Cesium.Cartesian3.distance(positions.at(-1), position) > 0.1
      )
        positions.push(position);
    }
    return positions.length >= 2 ? positions : null;
  }

  function addGhostPrimitive(tunnels, kind, cssColor) {
    if (!viewer.scene.primitives?.add) return null;
    const color = Cesium.Color.fromCssColorString(cssColor).withAlpha(
      GHOST_ALPHA,
    );
    const geometryInstances = tunnels
      .filter((tunnel) => tunnel.kind === kind)
      .map((tunnel) => {
        const polylinePositions = ghostPathPositions(tunnel);
        if (!polylinePositions) return null;
        return new Cesium.GeometryInstance({
          id: `tunnel-ghost:${kind}:${tunnel.id}`,
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(color),
          },
          geometry: new Cesium.PolylineVolumeGeometry({
            polylinePositions,
            shapePositions: ghostTunnelShape(kind),
            cornerType: Cesium.CornerType.ROUNDED,
          }),
        });
      })
      .filter(Boolean);
    if (!geometryInstances.length) return null;

    const primitive = new Cesium.Primitive({
      geometryInstances,
      appearance: new Cesium.PerInstanceColorAppearance({
        translucent: true,
        closed: false,
        renderState: { depthMask: false },
      }),
      asynchronous: true,
      allowPicking: false,
    });
    primitive.show =
      (viewer.camera?.positionCartographic?.height ?? 0) <=
      GHOST_MAX_CAMERA_ALTITUDE_M;
    return viewer.scene.primitives.add(primitive);
  }

  function updateGhostVisibility() {
    const visible =
      enabled &&
      (viewer?.camera?.positionCartographic?.height ?? 0) <=
        GHOST_MAX_CAMERA_ALTITUDE_M;
    for (const primitive of ghostPrimitives) primitive.show = visible;
  }

  function replaceGeometry(tunnels) {
    const roads = tunnels.filter((tunnel) => tunnel.kind === 'road');
    const rail = tunnels.filter((tunnel) => tunnel.kind === 'rail');
    const primitives = [];
    const entities = [];
    const ghosts = [];
    let useGroundPrimitives = false;
    if (
      viewer.scene.context &&
      viewer.scene.groundPrimitives?.add &&
      typeof Cesium.GroundPolylinePrimitive.isSupported === 'function'
    ) {
      try {
        useGroundPrimitives = Cesium.GroundPolylinePrimitive.isSupported(
          viewer.scene,
        );
      } catch {
        useGroundPrimitives = false;
      }
    }
    try {
      if (useGroundPrimitives) {
        const outline = addGroundPrimitive(
          tunnels,
          OUTLINE_WIDTH,
          OUTLINE_COLOR,
        );
        const roadLines = addGroundPrimitive(roads, ROAD_WIDTH, ROAD_COLOR);
        const railLines = addGroundPrimitive(rail, RAIL_WIDTH, RAIL_COLOR);
        for (const primitive of [outline, roadLines, railLines])
          if (primitive) primitives.push(primitive);
      } else {
        addFallbackLines(tunnels, OUTLINE_WIDTH, OUTLINE_COLOR);
        addFallbackLines(roads, ROAD_WIDTH, ROAD_COLOR);
        addFallbackLines(rail, RAIL_WIDTH, RAIL_COLOR);
        entities.push(...fallbackEntities);
        fallbackEntities = [];
      }
      const roadGhost = addGhostPrimitive(tunnels, 'road', ROAD_COLOR);
      const railGhost = addGhostPrimitive(tunnels, 'rail', RAIL_COLOR);
      for (const primitive of [roadGhost, railGhost])
        if (primitive) ghosts.push(primitive);
    } catch (caught) {
      removeGeometry(primitives, entities);
      removeGeometry([], fallbackEntities);
      fallbackEntities = [];
      for (const primitive of ghosts)
        viewer?.scene?.primitives?.remove(primitive);
      throw caught;
    }
    const previousPrimitives = groundPrimitives;
    const previousGhosts = ghostPrimitives;
    const previousEntities = fallbackEntities;
    groundPrimitives = primitives;
    ghostPrimitives = ghosts;
    fallbackEntities = entities;
    removeGeometry(previousPrimitives, previousEntities);
    for (const primitive of previousGhosts)
      viewer?.scene?.primitives?.remove(primitive);
    updateGhostVisibility();
    services.raiseRoutesAboveTunnels?.();

    const labels = [];
    for (const tunnel of tunnels) {
      if (!tunnel.name) continue;
      const [lon, lat] = midpointOfLine(tunnel.coordinates);
      const entry = tunnelOverlayEntry(
        tunnel,
        Cesium.Cartesian3.fromDegrees(lon, lat),
      );
      if (entry) labels.push(entry);
    }
    publisher.publish(labels);
    count = tunnels.length;
    roadCount = roads.length;
    railCount = rail.length;
    namedCount = labels.length;
    viewer.scene.requestRender?.();
  }

  async function loadForCamera() {
    if (!enabled || !viewer) return;
    updateGhostVisibility();
    const bounds = cameraBounds();
    if (!bounds) {
      zoomLimited = true;
      lastBoundsKey = null;
      clearGeometry();
      viewer.scene.requestRender?.();
      return;
    }
    zoomLimited = false;
    const boundsKey = Object.values(bounds)
      .map((value) => value.toFixed(3))
      .join(',');
    if (
      boundsKey === lastBoundsKey &&
      lastUpdate !== null &&
      Date.now() - lastUpdate < CACHE_TTL_MS
    )
      return;

    const requestGeneration = ++generation;
    abortController?.abort();
    abortController = new AbortController();
    const { signal } = abortController;
    loading = true;
    error = null;
    try {
      const response = await source.requestTunnels(bounds, { signal });
      if (!response.ok)
        throw new Error(`Tunnel query returned ${response.status}`);
      const payload = await response.json();
      if (!enabled || requestGeneration !== generation || signal.aborted)
        return;
      replaceGeometry(payload.tunnels);
      lastBoundsKey = boundsKey;
      lastUpdate = Date.now();
    } catch (caught) {
      if (caught?.name !== 'AbortError' && requestGeneration === generation) {
        error = caught?.message || 'Tunnel data unavailable';
      }
    } finally {
      if (requestGeneration === generation) loading = false;
    }
  }

  function onCameraMoveEnd() {
    void loadForCamera();
  }

  function disable() {
    enabled = false;
    generation++;
    abortController?.abort();
    abortController = null;
    loading = false;
    lastBoundsKey = null;
    clearGeometry();
    publisher.hide();
    viewer?.scene?.requestRender?.();
  }

  function destroy() {
    disable();
    cameraMoveEndRemove?.();
    cameraMoveEndRemove = null;
    viewer = null;
    lastUpdate = null;
    error = null;
    zoomLimited = false;
  }

  return {
    id: 'tunnels',
    name: 'Tunnels',
    icon: '🚇',
    source: 'OpenStreetMap',
    updateInterval: 0,

    init(nextViewer) {
      viewer = nextViewer;
      if (!cameraMoveEndRemove && viewer?.camera?.moveEnd?.addEventListener) {
        cameraMoveEndRemove =
          viewer.camera.moveEnd.addEventListener(onCameraMoveEnd);
      }
    },

    enable(nextViewer) {
      if (nextViewer) viewer = nextViewer;
      enabled = true;
      publisher.show();
      return loadForCamera();
    },

    disable,

    update(nextViewer) {
      if (nextViewer) viewer = nextViewer;
      return loadForCamera();
    },

    destroy,

    getStats() {
      return {
        count,
        roadCount,
        railCount,
        namedCount,
        loading,
        lastUpdate,
        error,
        zoomLimited,
      };
    },
  };
}

export { midpointOfLine, tunnelOverlayEntry };
