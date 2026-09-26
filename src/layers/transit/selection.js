import * as Cesium from 'cesium';
import {
  SELECTED_CARD_REFRESH_MS,
  TRANSIT_SELECTED_OVERLAY_SOURCE_ID,
  TRANSIT_SELECTED_OVERLAY_SOURCE_OPTIONS,
  TRANSIT_ROUTE_SELECTED_OVERLAY_SOURCE_ID,
  TRANSIT_ROUTE_SELECTED_OVERLAY_SOURCE_OPTIONS,
  buildTransitSelectionCopy,
  createTransitSelectedOverlayEntry,
  TRANSIT_MODE_WORD,
} from './policy.js';
import { getRegisteredTransitFeed } from '../../data/transitFeeds.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import { transitRouteMatchesVehicle } from './routeSource.js';

/**
 * Click-to-select one vehicle and a card that follows it.
 * @param {object} context
 * @returns {object}
 */
export function createSelection({ state, services, parts, source }) {
  const { governorRequestRender } = services.render;
  let selectedRoute = null;
  let selectedRouteData = null;
  let selectedMbtaRouteId = null;
  let routeDataController = null;

  function routePosition(route) {
    const center = parts.viewport?.getCameraCenterLatLon?.();
    const target = center || { lat: 0, lon: 0 };
    const longitudeScale = Math.max(
      0.01,
      Math.cos(Cesium.Math.toRadians(target.lat)),
    );
    let bestPoint = null;
    let bestDistance = Infinity;
    for (const line of route.lines || []) {
      if (line.length === 1) {
        const point = line[0];
        const distance =
          (point[0] - target.lon) ** 2 * longitudeScale ** 2 +
          (point[1] - target.lat) ** 2;
        if (distance < bestDistance) {
          bestPoint = point;
          bestDistance = distance;
        }
      }
      for (let index = 1; index < line.length; index++) {
        const a = line[index - 1];
        const b = line[index];
        const dx = (b[0] - a[0]) * longitudeScale;
        const dy = b[1] - a[1];
        const tx = (target.lon - a[0]) * longitudeScale;
        const ty = target.lat - a[1];
        const denominator = dx * dx + dy * dy;
        const fraction = denominator
          ? Math.max(0, Math.min(1, (tx * dx + ty * dy) / denominator))
          : 0;
        const point = [
          a[0] + (b[0] - a[0]) * fraction,
          a[1] + (b[1] - a[1]) * fraction,
        ];
        const distance =
          (point[0] - target.lon) ** 2 * longitudeScale ** 2 +
          (point[1] - target.lat) ** 2;
        if (distance < bestDistance) {
          bestPoint = point;
          bestDistance = distance;
        }
      }
    }
    const fallback = route.stops?.[0];
    const lon = bestPoint?.[0] ?? fallback?.lon;
    const lat = bestPoint?.[1] ?? fallback?.lat;
    return Number.isFinite(lon) && Number.isFinite(lat)
      ? Cesium.Cartesian3.fromDegrees(lon, lat)
      : null;
  }

  function wrapDetailLines(text, maxLength = 42) {
    const lines = [];
    let line = '';
    for (const sourceWord of String(text).trim().split(/\s+/)) {
      let word = sourceWord;
      while (word.length > maxLength) {
        if (line) {
          lines.push(line);
          line = '';
        }
        lines.push(word.slice(0, maxLength));
        word = word.slice(maxLength);
      }
      if (!word) continue;
      if (!line) line = word;
      else if (`${line} ${word}`.length <= maxLength) line += ` ${word}`;
      else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  function routeCopy(route) {
    const mode =
      route.type === 'train'
        ? 'rail'
        : route.type === 'light_rail'
          ? 'tram'
          : route.type;
    const word = TRANSIT_MODE_WORD[mode] || 'Transit route';
    const title = `${route.name || route.ref || `${word} route`}`;
    const details = [
      `${word} · ${route.network || route.operator || 'OpenStreetMap'}`,
      `Route ${route.ref || route.routeId}`,
    ];
    if (route.from || route.to)
      details.push(`From ${route.from || '—'} to ${route.to || '—'}`);
    const stops = route.stops || [];
    if (stops.length) {
      details.push(`${stops.length} mapped stops in loaded area`);
      const names = stops.map((stop) => stop.name).filter(Boolean).slice(0, 5);
      if (names.length) details.push(names.join(' · '));
    } else {
      details.push('No mapped stops in the loaded route data');
    }
    const liveVehicles = [...state._vehicles.values()].filter((entry) =>
      transitRouteMatchesVehicle(route, entry.record?.routeId),
    );
    if (liveVehicles.length) {
      const feeds = [...new Set(liveVehicles.map((entry) => entry.feedId))]
        .map((feedId) => getRegisteredTransitFeed(feedId)?.name || feedId)
        .join(', ');
      details.push(`${liveVehicles.length} matching live vehicles · ${feeds}`);
    } else {
      details.push('No matching live vehicles from active feeds');
    }
    if (selectedRouteData?.loading) {
      details.push(`MBTA predictions and alerts loading · ${selectedMbtaRouteId}`);
    } else if (selectedRouteData?.error) {
      details.push('MBTA predictions and alerts are unavailable');
    } else if (selectedRouteData) {
      const predictions = selectedRouteData.predictions || [];
      if (predictions.length) {
        const nextStops = predictions.slice(0, 3).map((prediction) => {
          const at = Date.parse(
            prediction.arrivalTime || prediction.departureTime || '',
          );
          const time = Number.isFinite(at)
            ? new Date(at).toLocaleTimeString(undefined, {
                hour: 'numeric',
                minute: '2-digit',
              })
            : 'time unavailable';
          return `${prediction.stopName || prediction.stopId || 'Stop'} ${time}`;
        });
        details.push(`Next MBTA stops: ${nextStops.join(' · ')}`);
      } else {
        details.push('No upcoming MBTA predictions reported');
      }
      const alerts = selectedRouteData.alerts || [];
      if (alerts.length) {
        details.push(
          ...wrapDetailLines(
            `MBTA alert: ${alerts[0].header || alerts[0].effect || 'Service change'}`,
          ),
        );
      } else {
        details.push('No active MBTA service alerts');
      }
    } else {
      details.push('Schedules and service alerts are not provided for this route');
    }
    if (route.description) details.push(route.description);
    return { title, details, mode };
  }

  function mbtaRouteIdFor(route) {
    const matchingVehicle = [...state._vehicles.values()].find(
      (entry) =>
        entry.feedId === 'mbta' &&
        transitRouteMatchesVehicle(route, entry.record?.routeId),
    );
    const network = `${route.network || ''} ${route.operator || ''}`;
    if (!/mbta|massachusetts bay/i.test(network) && !matchingVehicle)
      return null;
    const candidates = [
      matchingVehicle?.record?.routeId,
      route.ref,
      route.name?.replace(/\s+line(?:\s+([bcde]))?$/i, (_, branch) =>
        branch ? `-${branch}` : '',
      ),
    ].filter((value) => typeof value === 'string' && value.trim());
    return (
      candidates
        .map((value) => value.trim())
        .find((value) =>
          /^(?:Red|Orange|Blue|Mattapan|Green-[BCDE]|CR-[A-Za-z0-9-]+|Boat-[A-Za-z0-9-]+|SL\d+|\d+)$/i.test(
            value,
          ),
        ) || null
    );
  }

  function loadMbtaRouteDetails(route) {
    const routeId = mbtaRouteIdFor(route);
    if (!routeId || typeof source?.requestRouteDetails !== 'function') return;
    const feed = getRegisteredTransitFeed('mbta');
    if (feed && state._viewer) {
      services.credits?.registerDynamicCredit?.(
        state._viewer,
        services.credits.transitFeedCredit?.(feed),
      );
    }
    routeDataController?.abort();
    const controller = new AbortController();
    routeDataController = controller;
    selectedMbtaRouteId = routeId;
    selectedRouteData = { loading: true };
    publishSelectedRoute();
    void (async () => {
      try {
        const response = await source.requestRouteDetails('mbta', routeId, {
          signal: controller.signal,
        });
        if (!response.ok)
          throw new Error(`MBTA route details returned ${response.status}`);
        const data = await response.json();
        if (
          controller.signal.aborted ||
          routeDataController !== controller ||
          selectedRoute?.routeId !== route.routeId
        )
          return;
        selectedRouteData = data;
        publishSelectedRoute();
        governorRequestRender('transit-route-details');
      } catch (error) {
        if (error?.name === 'AbortError' || routeDataController !== controller)
          return;
        selectedRouteData = { error: error?.message || 'MBTA route details unavailable' };
        publishSelectedRoute();
        governorRequestRender('transit-route-details-error');
      } finally {
        if (routeDataController === controller) routeDataController = null;
      }
    })();
  }

  function publishSelectedRoute() {
    if (!selectedRoute) return;
    const routeId = selectedRoute.routeId;
    const position = () => {
      const latest = parts.routes.getRoute(routeId) || selectedRoute;
      return latest ? routePosition(latest) : null;
    };
    if (!position()) return;
    const copy = routeCopy(selectedRoute);
    state._overlayHost.setEntries(
      TRANSIT_ROUTE_SELECTED_OVERLAY_SOURCE_ID,
      [
        {
          id: `transit-route:${selectedRoute.routeId}`,
          position,
          variant: 'selected',
          selected: true,
          moving: true,
          protected: true,
          paintLane: 'selected',
          collisionGroup: 'ambient-card',
          priority: Number.MAX_SAFE_INTEGER,
          title: copy.title,
          details: copy.details,
          accent: selectedRoute.color,
          interactive: false,
          verticalOnly: true,
          placement: 'above',
          horizonCull: true,
          terrainOcclusion: false,
        },
      ],
      TRANSIT_ROUTE_SELECTED_OVERLAY_SOURCE_OPTIONS,
    );
  }

  /**
   * The card's anchor: the selected marker's CURRENT position, read by the
   * overlay host on every paint. A getter, not a clone — the host accepts one
   * (the tracked-aircraft readout uses the same), so the anchor moves with the
   * sprite at frame rate, through poll arrivals, settling, a late floor and a
   * reset alike, with no per-frame work here. Null when there is nothing to
   * anchor to: a hidden or removed marker draws no card.
   * @param {object} entry
   * @returns {() => Cesium.Cartesian3|null}
   */
  function anchorFor(entry) {
    return () => {
      const marker = entry.marker;
      const p = marker?.show !== false ? marker?.position : null;
      return p &&
        Number.isFinite(p.x) &&
        Number.isFinite(p.y) &&
        Number.isFinite(p.z)
        ? p
        : null;
    };
  }

  function refreshSelectedCard(force) {
    const entry = state._selectedKey
      ? state._vehicles.get(state._selectedKey)
      : null;
    if (!entry) return;
    const now = Date.now();
    if (!force && now - state._selectedCardAt < SELECTED_CARD_REFRESH_MS)
      return;
    state._selectedCardAt = now;
    const feed =
      state._activeFeeds.get(entry.feedId) ||
      getRegisteredTransitFeed(entry.feedId);
    if (!feed) return;
    const copy = buildTransitSelectionCopy(
      feed,
      entry.record,
      entry.mode,
      now,
      entry.fetchedAt,
      entry,
    );
    // The TEXT is what the throttle is for, and it is republished only when
    // it has changed: the anchor is live through its getter, so re-sending
    // an identical card would only make the host re-solve its layout.
    const text = `${entry.key}\u0000${copy.title}\u0000${copy.details.join('\u0000')}`;
    if (!force && text === state._selectedCardText) return;
    const card = createTransitSelectedOverlayEntry(
      entry.key,
      anchorFor(entry),
      copy,
      entry.mode,
    );
    if (card) {
      state._selectedCardText = text;
      state._overlayHost.setEntries(
        TRANSIT_SELECTED_OVERLAY_SOURCE_ID,
        [card],
        TRANSIT_SELECTED_OVERLAY_SOURCE_OPTIONS,
      );
      state._cardPublications = (state._cardPublications || 0) + 1;
    }
  }

  function clearSelection() {
    routeDataController?.abort();
    routeDataController = null;
    selectedRouteData = null;
    selectedMbtaRouteId = null;
    selectedRoute = null;
    parts.routes.clearSelectedRoute();
    state._overlayHost.clearSource(TRANSIT_ROUTE_SELECTED_OVERLAY_SOURCE_ID);
    const entry = state._selectedKey
      ? state._vehicles.get(state._selectedKey)
      : null;
    parts.trails.clear();
    state._selectedKey = null;
    state._selectedCardText = null;
    state._detectRevision += 1;
    // Cleared first: the styling path reads the selection from state.
    if (entry) parts.rendering.paintSelected(entry, false);
    state._overlayHost.clearSource(TRANSIT_SELECTED_OVERLAY_SOURCE_ID);
  }

  function selectVehicle(key) {
    clearSelection();
    const entry = state._vehicles.get(key);
    if (!entry?.marker) return;
    state._selectedKey = key;
    state._detectRevision += 1;
    parts.rendering.paintSelected(entry, true);
    parts.trails.select(entry);
    refreshSelectedCard(true);
    governorRequestRender('transit-select');
  }

  function selectRoute(route) {
    if (!route?.routeId) return;
    clearSelection();
    selectedRoute = route;
    parts.routes.setSelectedRoute(route.routeId);
    publishSelectedRoute();
    loadMbtaRouteDetails(route);
    governorRequestRender('transit-route-select');
  }

  function refreshSelectedRouteCard() {
    if (!selectedRoute) return;
    selectedRoute = parts.routes.getRoute(selectedRoute.routeId) || selectedRoute;
    publishSelectedRoute();
  }

  function onKeyDown(event) {
      if (event.key === 'Escape' && (state._selectedKey || selectedRoute))
        clearSelection();
  }

  function installClickHandler(viewer) {
    if (state._clickHandler) return;
    state._clickHandler = new Cesium.ScreenSpaceEventHandler(
      viewer.scene.canvas,
    );
    state._clickHandler.setInputAction((click) => {
      // Ambient selection never competes for a pointer a tool has claimed:
      // placing a draw vertex on top of a bus must not also select the bus.
      if (!isPointerFree()) return;
      const scene = viewer.scene;
      // Pick buffers precede post-processing. Map a sensor pixel back through
      // the active shader's barrel distortion and quantization before picking.
      const position = Cesium.Cartesian2.clone(click.position);
      const style = state._stylePreset;
      const stage = scene.postProcessStages?.getStageByName?.(
        `godsEyeView_${style}`,
      );
      if (stage?.enabled && (style === 'thermal' || style === 'surveillance')) {
        const intensity = stage.uniforms.intensity;
        const canvas = scene.canvas,
          w = canvas.clientWidth,
          h = canvas.clientHeight;
        let u = position.x / w,
          v = 1 - position.y / h;
        if (style === 'surveillance') {
          const x = u * 2 - 1,
            y = v * 2 - 1,
            r2 = x * x + y * y;
          const d = 1 + r2 * intensity * 0.25 + r2 * r2 * intensity * 0.075;
          u = (x * d + 1) / 2;
          v = (y * d + 1) / 2;
        }
        const grid = 1 + (stage.uniforms.pixelation - 1) * intensity;
        u +=
          ((Math.floor((u * canvas.width) / grid) * grid) / canvas.width - u) *
          intensity;
        v +=
          ((Math.floor((v * canvas.height) / grid) * grid) / canvas.height -
            v) *
          intensity;
        position.x = u * w;
        position.y = (1 - v) * h;
      }
      const picked = scene.pick(position);
      state._lastPickForTest = {
        id: typeof picked?.id === 'string' ? picked.id : null,
        primitiveId:
          typeof picked?.primitive?.id === 'string'
            ? picked.primitive.id
            : null,
        x: position.x,
        y: position.y,
        collection:
          picked?.primitive?._billboardCollection === state._animatedMarkers
            ? 'animated'
            : picked?.primitive?._billboardCollection === state._markers
              ? 'stationary'
              : null,
      };
      if (picked) {
        if (parts.routes.selectFromPick(picked)) return;
        const primitiveId = picked.primitive?.id;
        if (
          typeof primitiveId === 'string' &&
          state._vehicles.has(primitiveId)
        ) {
          selectVehicle(primitiveId);
          return;
        }
        if (typeof picked.id === 'string' && state._vehicles.has(picked.id)) {
          selectVehicle(picked.id);
          return;
        }
      }
      if (state._selectedKey || selectedRoute) clearSelection();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    document.addEventListener('keydown', onKeyDown);
  }

  function removeClickHandler() {
    if (state._clickHandler) {
      state._clickHandler.destroy();
      state._clickHandler = null;
    }
    document.removeEventListener('keydown', onKeyDown);
  }

  return {
    refreshSelectedCard,
    clearSelection,
    selectVehicle,
    selectRoute,
    refreshSelectedRouteCard,
    onKeyDown,
    installClickHandler,
    removeClickHandler,
  };
}
