import * as Cesium from 'cesium';
import { clampTransitRouteBounds } from './routeSource.js';

export const TRANSIT_ROUTE_MAX_ALTITUDE_M = 500_000;

const MIN_VIEW_SPAN_DEG = 0.1;
const QUERY_GRID_DEG = 0.01;
const PREFETCH_FACTOR = 3;
const ROUTE_CACHE_TTL_MS = 6 * 60 * 60_000;
const FAILURE_RETRY_MS = 30_000;
const OUTLINE_COLOR = '#07131B';
const OUTLINE_WIDTH = 7;
const ROUTE_WIDTH = 3.5;
const ROUTE_OUTLINE_Z_INDEX = 20;
const ROUTE_LINE_Z_INDEX = 21;

function stableQueryBounds(bounds) {
  const safe = clampTransitRouteBounds(bounds);
  const centerLat = (safe.south + safe.north) / 2;
  const centerLon = (safe.west + safe.east) / 2;
  const halfLat = Math.max(MIN_VIEW_SPAN_DEG, safe.north - safe.south) / 2;
  const halfLon = Math.max(MIN_VIEW_SPAN_DEG, safe.east - safe.west) / 2;
  const floor = (value) => Math.floor(value / QUERY_GRID_DEG) * QUERY_GRID_DEG;
  const ceil = (value) => Math.ceil(value / QUERY_GRID_DEG) * QUERY_GRID_DEG;
  const rounded = {
    south: Math.max(-90, floor(centerLat - halfLat)),
    west: Math.max(-180, floor(centerLon - halfLon)),
    north: Math.min(90, ceil(centerLat + halfLat)),
    east: Math.min(180, ceil(centerLon + halfLon)),
  };
  if (rounded.north - rounded.south > 1 || rounded.east - rounded.west > 1)
    return safe;
  return clampTransitRouteBounds(rounded);
}

function routeBoundsKey(bounds) {
  return [bounds.south, bounds.west, bounds.north, bounds.east]
    .map((value) => value.toFixed(3))
    .join(',');
}

function boundsContain(outer, inner) {
  const epsilon = 1e-6;
  return (
    outer &&
    inner &&
    outer.south <= inner.south + epsilon &&
    outer.west <= inner.west + epsilon &&
    outer.north >= inner.north - epsilon &&
    outer.east >= inner.east - epsilon
  );
}

function prefetchBounds(bounds) {
  const safe = stableQueryBounds(bounds);
  const centerLat = (safe.south + safe.north) / 2;
  const centerLon = (safe.west + safe.east) / 2;
  const halfLat = Math.min(
    0.5,
    ((safe.north - safe.south) * PREFETCH_FACTOR) / 2,
  );
  const halfLon = Math.min(
    0.5,
    ((safe.east - safe.west) * PREFETCH_FACTOR) / 2,
  );
  return stableQueryBounds({
    south: Math.max(-90, centerLat - halfLat),
    west: Math.max(-180, centerLon - halfLon),
    north: Math.min(90, centerLat + halfLat),
    east: Math.min(180, centerLon + halfLon),
  });
}

function routePositions(line) {
  return line.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat));
}

/** Own viewport-loaded OSM rail-route geometry for one Transit layer. */
export function createTransitRouteLines({
  routeSource,
  onSelectRoute = () => {},
  onRoutesUpdated = () => {},
}) {
  if (typeof routeSource?.requestRoutes !== 'function')
    throw new TypeError('A transit-route source is required');

  let viewer = null;
  let enabled = false;
  let visible = false;
  let generation = 0;
  let abortController = null;
  let lastBoundsKey = null;
  let lastUpdate = 0;
  let lastRequestedAt = null;
  let lastStatus = null;
  let lastCache = null;
  let lastUpstream = null;
  let lastBounds = null;
  let lastFailureAt = 0;
  let lastFailureKey = null;
  let requestKey = null;
  let requestBounds = null;
  let requestStage = null;
  let coverageBounds = null;
  let prefetching = false;
  let routes = [];
  let loading = false;
  let error = null;
  let primitives = [];
  let entities = [];
  let selectedRouteId = null;
  const routePickTargets = new Map();

  function removeGeometry() {
    for (const primitive of primitives)
      viewer?.scene?.groundPrimitives?.remove(primitive);
    for (const entity of entities) viewer?.entities?.remove(entity);
    primitives = [];
    entities = [];
  }

  function raiseRouteLinesToTop() {
    const collection = viewer?.scene?.groundPrimitives;
    for (const primitive of primitives)
      if (primitive) collection?.raiseToTop?.(primitive);
  }

  function makeInstances(items, width) {
    const instances = [];
    for (const route of items) {
      for (let index = 0; index < route.lines.length; index++) {
        const positions = routePositions(route.lines[index]);
        if (positions.length < 2) continue;
        const id = `transit-route:${route.routeId}:${route.id}:${index}:${width}`;
        routePickTargets.set(id, route.routeId);
        instances.push(
          new Cesium.GeometryInstance({
            id,
            geometry: new Cesium.GroundPolylineGeometry({ positions, width }),
          }),
        );
      }
    }
    return instances;
  }

  function addGroundPrimitive(items, width, cssColor) {
    const instances = makeInstances(items, width);
    if (!instances.length) return null;
    const primitive = new Cesium.GroundPolylinePrimitive({
      geometryInstances: instances,
      appearance: new Cesium.PolylineMaterialAppearance({
        material: Cesium.Material.fromType('Color', {
          color: Cesium.Color.fromCssColorString(cssColor),
        }),
      }),
      classificationType: Cesium.ClassificationType.BOTH,
      allowPicking: true,
      asynchronous: true,
      show: visible,
    });
    return viewer.scene.groundPrimitives.add(primitive);
  }

  function addFallbackLines(items, width, cssColor) {
    const material = Cesium.Color.fromCssColorString(cssColor);
    const created = [];
    for (const route of items) {
      for (let index = 0; index < route.lines.length; index++) {
        const positions = routePositions(route.lines[index]);
        if (positions.length < 2) continue;
        const id = `transit-route:${route.routeId}:${route.id}:${index}:${width}`;
        routePickTargets.set(id, route.routeId);
        created.push(
          viewer.entities.add({
            id,
            polyline: {
              positions,
              width,
              material,
              clampToGround: true,
              zIndex:
                width === OUTLINE_WIDTH
                  ? ROUTE_OUTLINE_Z_INDEX
                  : ROUTE_LINE_Z_INDEX,
            },
          }),
        );
      }
    }
    return created;
  }

  function replaceRoutes(nextRoutes) {
    const nextPrimitives = [];
    const nextEntities = [];
    routePickTargets.clear();
    let canUseGround = false;
    try {
      canUseGround =
        !!viewer?.scene?.context &&
        !!viewer.scene.groundPrimitives?.add &&
        typeof Cesium.GroundPolylinePrimitive.isSupported === 'function' &&
        Cesium.GroundPolylinePrimitive.isSupported(viewer.scene);
    } catch {
      canUseGround = false;
    }

    try {
      if (canUseGround) {
        const outline = addGroundPrimitive(
          nextRoutes,
          OUTLINE_WIDTH,
          OUTLINE_COLOR,
        );
        if (outline) nextPrimitives.push(outline);
    onRoutesUpdated();
        const byColor = new Map();
        for (const route of nextRoutes) {
          if (!byColor.has(route.color)) byColor.set(route.color, []);
          byColor.get(route.color).push(route);
        }
        for (const [color, group] of byColor) {
          const primitive = addGroundPrimitive(group, ROUTE_WIDTH, color);
          if (primitive) nextPrimitives.push(primitive);
        }
      } else {
        nextEntities.push(
          ...addFallbackLines(nextRoutes, OUTLINE_WIDTH, OUTLINE_COLOR),
        );
        for (const route of nextRoutes)
          nextEntities.push(
            ...addFallbackLines([route], ROUTE_WIDTH, route.color),
          );
      }
    } catch (caught) {
      for (const primitive of nextPrimitives)
        viewer?.scene?.groundPrimitives?.remove(primitive);
      for (const entity of nextEntities) viewer?.entities?.remove(entity);
      throw caught;
    }

    const previousPrimitives = primitives;
    const previousEntities = entities;
    primitives = nextPrimitives;
    entities = nextEntities;
    routes = nextRoutes;
    for (const primitive of previousPrimitives)
      viewer?.scene?.groundPrimitives?.remove(primitive);
    for (const entity of previousEntities) viewer?.entities?.remove(entity);
    raiseRouteLinesToTop();
    viewer?.scene?.requestRender?.();
  }

  function setVisible(next) {
    visible = enabled && next === true;
    for (const primitive of primitives) primitive.show = visible;
    for (const entity of entities) entity.show = visible;
    if (visible) {
      raiseRouteLinesToTop();
      viewer?.scene?.requestRender?.();
    }
  }

  function routeForId(routeId) {
    const segments = routes.filter((route) => route.routeId === routeId);
    if (!segments.length) return null;
    const stops = new Map();
    for (const stop of segments.flatMap((segment) => segment.stops || [])) {
      if (!stops.has(stop.id)) stops.set(stop.id, stop);
    }
    return {
      ...segments[0],
      id: routeId,
      lines: segments.flatMap((segment) => segment.lines),
      stops: [...stops.values()],
    };
  }

  async function loadBounds(safeBounds, requestGeneration, signal, stage) {
    const key = routeBoundsKey(safeBounds);
    requestKey = key;
    requestBounds = { ...safeBounds };
    requestStage = stage;
    loading = true;
    prefetching = stage === 'prefetch';
    error = null;
    lastRequestedAt = Date.now();
    lastStatus = null;
    lastCache = null;
    lastUpstream = null;
    lastBounds = { ...safeBounds };
    try {
      const response = await routeSource.requestRoutes(safeBounds, { signal });
      lastStatus = response.status;
      lastCache = response.headers?.get?.('x-overpass-cache') || null;
      lastUpstream = response.headers?.get?.('x-overpass-upstream') || null;
      if (!response.ok)
        throw new Error(`Transit route query returned ${response.status}`);
      const payload = await response.json();
      if (!enabled || requestGeneration !== generation || signal.aborted)
        return false;
      replaceRoutes(payload.routes || []);
      lastBoundsKey = key;
      lastUpdate = Date.now();
      coverageBounds = { ...safeBounds };
      lastFailureKey = null;
      lastFailureAt = 0;
      return true;
    } catch (caught) {
      if (caught?.name !== 'AbortError' && requestGeneration === generation) {
        error = caught?.message || 'Transit routes unavailable';
        lastFailureAt = Date.now();
        lastFailureKey = key;
      }
      return false;
    } finally {
      if (requestGeneration === generation) {
        loading = false;
        prefetching = false;
        requestKey = null;
        requestBounds = null;
        requestStage = null;
      }
    }
  }

  async function update(bounds) {
    if (!enabled || !visible || !bounds) return;
    const priorityBounds = stableQueryBounds(bounds);
    const expanded = prefetchBounds(priorityBounds);
    const now = Date.now();
    const coverageFresh =
      coverageBounds && now - lastUpdate < ROUTE_CACHE_TTL_MS;

    if (coverageFresh && boundsContain(coverageBounds, priorityBounds)) {
      if (boundsContain(coverageBounds, expanded)) return;
      if (requestKey) return;
      const expandedKey = routeBoundsKey(expanded);
      if (
        lastFailureKey === expandedKey &&
        now - lastFailureAt < FAILURE_RETRY_MS
      )
        return;
      const requestGeneration = ++generation;
      abortController?.abort();
      abortController = new AbortController();
      await loadBounds(
        expanded,
        requestGeneration,
        abortController.signal,
        'prefetch',
      );
      return;
    }

    if (requestKey) {
      if (
        requestStage === 'priority' &&
        boundsContain(requestBounds, priorityBounds)
      )
        return;
      generation++;
      abortController?.abort();
      requestKey = null;
      requestBounds = null;
      requestStage = null;
      loading = false;
      prefetching = false;
    }

    const priorityKey = routeBoundsKey(priorityBounds);
    if (
      lastFailureKey === priorityKey &&
      now - lastFailureAt < FAILURE_RETRY_MS
    )
      return;

    const requestGeneration = ++generation;
    abortController?.abort();
    abortController = new AbortController();
    const loadedInView = await loadBounds(
      priorityBounds,
      requestGeneration,
      abortController.signal,
      'priority',
    );
    if (!loadedInView || !enabled || requestGeneration !== generation) return;
    if (boundsContain(coverageBounds, expanded)) return;
    const expandedKey = routeBoundsKey(expanded);
    if (
      lastFailureKey === expandedKey &&
      Date.now() - lastFailureAt < FAILURE_RETRY_MS
    )
      return;
    await loadBounds(
      expanded,
      requestGeneration,
      abortController.signal,
      'prefetch',
    );
  }

  function selectFromPick(picked) {
    const candidateIds = [
      typeof picked === 'string' ? picked : null,
      typeof picked?.id === 'string' ? picked.id : null,
      typeof picked?.id?.id === 'string' ? picked.id.id : null,
      typeof picked?.primitive?.id === 'string' ? picked.primitive.id : null,
    ].filter(Boolean);
    const routeId = candidateIds
      .map((id) => routePickTargets.get(id))
      .find(Boolean);
    if (!routeId) return false;
    const route = routeForId(routeId);
    if (!route) return false;
    selectedRouteId = routeId;
    onSelectRoute(route);
    return true;
  }

  function setSelectedRoute(routeId) {
    selectedRouteId = routeId || null;
  }

  function clearSelectedRoute() {
    selectedRouteId = null;
  }

  function disable() {
    enabled = false;
    visible = false;
    generation++;
    abortController?.abort();
    abortController = null;
    requestKey = null;
    requestBounds = null;
    requestStage = null;
    loading = false;
    prefetching = false;
    lastBoundsKey = null;
    coverageBounds = null;
    selectedRouteId = null;
    lastFailureKey = null;
    lastFailureAt = 0;
    error = null;
    removeGeometry();
    routes = [];
  }

  function destroy() {
    disable();
    viewer = null;
  }

  return {
    init(nextViewer) {
      viewer = nextViewer;
    },
    enable(nextViewer) {
      if (nextViewer) viewer = nextViewer;
      enabled = true;
    },
    disable,
    destroy,
    setVisible,
    raiseRouteLinesToTop,
    update,
    selectFromPick,
    getRoute: routeForId,
    setSelectedRoute,
    clearSelectedRoute,
    diagnostics({ includeGeometry = false } = {}) {
      return {
        source: 'OpenStreetMap via Overpass',
        enabled,
        count: routes.length,
        loading,
        prefetching,
        requestStage,
        error,
        visible,
        lastUpdate,
        lastRequestedAt,
        lastStatus,
        cache: lastCache,
        upstream: lastUpstream,
        bounds: lastBounds ? { ...lastBounds } : null,
        coverageBounds: coverageBounds ? { ...coverageBounds } : null,
        routes: routes.map((route) => ({
          id: route.id,
          routeId: route.routeId,
          name: route.name,
          ref: route.ref,
          type: route.type,
          color: route.color,
          network: route.network,
          operator: route.operator,
          from: route.from,
          to: route.to,
          description: route.description,
          website: route.website,
          stopCount: route.stops?.length || 0,
          stops: route.stops || [],
          lineCount: route.lines.length,
          ...(includeGeometry ? { lines: route.lines } : {}),
        })),
        selectedRouteId,
      };
    },
  };
}