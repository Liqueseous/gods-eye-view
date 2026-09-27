import * as Cesium from 'cesium';
import { clampTransitRouteBounds } from './routeSource.js';

export const TRANSIT_ROUTE_MAX_ALTITUDE_M = 500_000;

const MIN_VIEW_SPAN_DEG = 0.1;
const QUERY_GRID_DEG = 0.01;
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

function routePositions(line) {
  return line.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat));
}

async function yieldRouteBuild() {
  await new Promise((resolve) => setTimeout(resolve, 0));
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
  let pendingReplacement = null;
  let postRenderRemove = null;
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

  async function makeInstances(items, width, pickTargets, isCurrent) {
    const instances = [];
    for (const route of items) {
      for (let index = 0; index < route.lines.length; index++) {
        if (!isCurrent()) throw Object.assign(new Error('Route build superseded'), { name: 'AbortError' });
        const positions = routePositions(route.lines[index]);
        if (positions.length < 2) continue;
        const id = `transit-route:${route.routeId}:${route.id}:${index}:${width}`;
        pickTargets.set(id, route.routeId);
        instances.push(
          new Cesium.GeometryInstance({
            id,
            geometry: new Cesium.GroundPolylineGeometry({ positions, width }),
          }),
        );
      }
      if (instances.length % 64 === 0) await yieldRouteBuild();
    }
    return instances;
  }

  async function addGroundPrimitive(items, width, cssColor, pickTargets, isCurrent) {
    const instances = await makeInstances(items, width, pickTargets, isCurrent);
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
      show: false,
    });
    return viewer.scene.groundPrimitives.add(primitive);
  }

  async function addFallbackLines(items, width, cssColor, pickTargets, isCurrent) {
    const material = Cesium.Color.fromCssColorString(cssColor);
    const created = [];
    for (const route of items) {
      for (let index = 0; index < route.lines.length; index++) {
        if (!isCurrent()) throw Object.assign(new Error('Route build superseded'), { name: 'AbortError' });
        const positions = routePositions(route.lines[index]);
        if (positions.length < 2) continue;
        const id = `transit-route:${route.routeId}:${route.id}:${index}:${width}`;
        pickTargets.set(id, route.routeId);
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
      if (created.length % 64 === 0) await yieldRouteBuild();
    }
    return created;
  }

  function removeReplacement(replacement) {
    for (const primitive of replacement?.primitives || [])
      viewer?.scene?.groundPrimitives?.remove(primitive);
    for (const entity of replacement?.entities || [])
      viewer?.entities?.remove(entity);
  }

  function commitRoutes(replacement) {
    const previousPrimitives = primitives;
    const previousEntities = entities;
    primitives = replacement.primitives;
    entities = replacement.entities;
    routes = replacement.routes;
    routePickTargets.clear();
    for (const [id, routeId] of replacement.pickTargets)
      routePickTargets.set(id, routeId);
    pendingReplacement = null;
    for (const primitive of primitives) primitive.show = visible;
    for (const entity of entities) entity.show = visible;
    for (const primitive of previousPrimitives)
      viewer?.scene?.groundPrimitives?.remove(primitive);
    for (const entity of previousEntities) viewer?.entities?.remove(entity);
    raiseRouteLinesToTop();
    onRoutesUpdated();
    viewer?.scene?.requestRender?.();
  }

  function promoteReadyReplacement() {
    if (!pendingReplacement) return;
    if (!primitives.length && !entities.length) {
      commitRoutes(pendingReplacement);
      return;
    }
    if (
      pendingReplacement.primitives.some(
        (primitive) => primitive.ready !== true,
      )
    )
      return;
    commitRoutes(pendingReplacement);
  }

  async function replaceRoutes(nextRoutes, isCurrent = () => true) {
    const nextPrimitives = [];
    const nextEntities = [];
    const nextPickTargets = new Map();
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
        const outline = await addGroundPrimitive(
          nextRoutes,
          OUTLINE_WIDTH,
          OUTLINE_COLOR,
          nextPickTargets,
          isCurrent,
        );
        if (outline) nextPrimitives.push(outline);
        const byColor = new Map();
        for (const route of nextRoutes) {
          if (!byColor.has(route.color)) byColor.set(route.color, []);
          byColor.get(route.color).push(route);
        }
        for (const [color, group] of byColor) {
          const primitive = await addGroundPrimitive(
            group,
            ROUTE_WIDTH,
            color,
            nextPickTargets,
            isCurrent,
          );
          if (primitive) nextPrimitives.push(primitive);
        }
      } else {
        nextEntities.push(
          ...(await addFallbackLines(
            nextRoutes,
            OUTLINE_WIDTH,
            OUTLINE_COLOR,
            nextPickTargets,
            isCurrent,
          )),
        );
        for (const route of nextRoutes)
          nextEntities.push(
            ...(await addFallbackLines(
              [route],
              ROUTE_WIDTH,
              route.color,
              nextPickTargets,
              isCurrent,
            )),
          );
      }
    } catch (caught) {
      for (const primitive of nextPrimitives)
        viewer?.scene?.groundPrimitives?.remove(primitive);
      for (const entity of nextEntities) viewer?.entities?.remove(entity);
      throw caught;
    }

    if (!isCurrent()) return false;
    const replacement = {
      primitives: nextPrimitives,
      entities: nextEntities,
      routes: nextRoutes,
      pickTargets: nextPickTargets,
    };
    removeReplacement(pendingReplacement);
    pendingReplacement = replacement;
    if (!primitives.length && !entities.length) {
      if (!nextPrimitives.length) commitRoutes(replacement);
      else {
        for (const primitive of nextPrimitives) primitive.show = visible;
        promoteReadyReplacement();
      }
    } else promoteReadyReplacement();
    viewer?.scene?.requestRender?.();
    return true;
  }

  function setVisible(next) {
    visible = enabled && next === true;
    for (const primitive of primitives) primitive.show = visible;
    for (const entity of entities) entity.show = visible;
    for (const primitive of pendingReplacement?.primitives || [])
      primitive.show = false;
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
      const nextRoutes = payload.routes || [];
      const replaced = await replaceRoutes(nextRoutes, () =>
        enabled && requestGeneration === generation && !signal.aborted,
      );
      if (!replaced) return false;
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
    const now = Date.now();
    const coverageFresh =
      coverageBounds && now - lastUpdate < ROUTE_CACHE_TTL_MS;

    if (coverageFresh && boundsContain(coverageBounds, priorityBounds)) return;

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
    removeReplacement(pendingReplacement);
    pendingReplacement = null;
    removeGeometry();
    routes = [];
  }

  function destroy() {
    disable();
    postRenderRemove?.();
    postRenderRemove = null;
    viewer = null;
  }

  return {
    init(nextViewer) {
      viewer = nextViewer;
      postRenderRemove = viewer.scene.postRender?.addEventListener?.(
        promoteReadyReplacement,
      );
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