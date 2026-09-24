import * as Cesium from 'cesium';
import {
  NWS_ALERT_OVERLAY_SOURCE_ID,
  alertAnchorDegrees,
  buildAlertCard,
  severityAccent,
} from './cards.js';
import * as picking from '../../data/pickRegistry.js';
import { isPointerFree } from '../../data/inputOwnership.js';
export { normalizeNwsAlertSnapshot } from './records.js';
export { createNwsAlertsSource } from './source.js';
export * from './cards.js';

/** Fill/line color for an alert by NWS severity. */
export function severityColor(severity) {
  return Cesium.Color.fromCssColorString(severityAccent(severity));
}

const ringPositions = (ring) =>
  ring.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat));

const PICK_PREFIX = 'nws-alert:';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});

/** Resolve an entity pick id without truncating colon-delimited NWS URNs. */
export function alertIdFromPickId(pickId, knownIds) {
  if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
    return null;
  const body = pickId.slice(PICK_PREFIX.length);
  const delimiter = body.lastIndexOf(':');
  const alertId = delimiter > 0 ? body.slice(0, delimiter) : body;
  return knownIds?.has(alertId) ? alertId : null;
}

/** Own one NWS-alerts display, its refresh lifecycle, and click selection. */
export function createNwsAlertsLayer({
  source,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  pointer = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('NWS alerts require a snapshot source');
  let _viewer = null;
  let _request = null;
  let _snapshotSignature = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let _clickHandler = null;
  let _selectedId = null;
  /** @type {Map<string, {stableId: string, anchor: {lon: number, lat: number}}>} */
  const _rowById = new Map();

  const canSelect = () => overlayHost && screenSpaceEventHandlerFactory;

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _rowById.get(_selectedId) : null;
    if (!row) {
      _selectedId = null;
      overlayHost.setEntries(
        NWS_ALERT_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const card = {
      ...buildAlertCard(row, Date.now()),
      position: Cesium.Cartesian3.fromDegrees(row.anchor.lon, row.anchor.lat),
    };
    overlayHost.setEntries(
      NWS_ALERT_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  /** Resolve a scene pick to one of this layer's alert ids, or null. */
  function pickedAlertId(picked) {
    const pickId = picking.resolvePickId(picked);
    return alertIdFromPickId(pickId, _rowById);
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    // Deliberately NOT registered in the pick-ownership registry — see
    // fire-perimeters for the same reasoning: sibling point layers must be
    // able to pick through these large ground polygons.
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const picked = _viewer.scene.pick(click.position);
      const alertId = picked ? pickedAlertId(picked) : null;
      if (alertId) {
        _selectedId = alertId;
        publishSelectedCard();
        return;
      }
      if (picked) {
        const pickId = picking.resolvePickId(picked);
        if (pickId && picking.isOwnedByOtherLayer(layer.id, pickId)) return;
      }
      if (_selectedId) {
        _selectedId = null;
        publishSelectedCard();
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    if (_clickHandler) {
      _clickHandler.destroy();
      _clickHandler = null;
    }
  }

  function clearSelection() {
    _selectedId = null;
    if (overlayHost) {
      overlayHost.clearSource(NWS_ALERT_OVERLAY_SOURCE_ID);
      overlayHost.setVisible?.(NWS_ALERT_OVERLAY_SOURCE_ID, false);
    }
  }

  const layer = {
    id: 'nws-alerts',
    name: 'NWS Weather Alerts',
    icon: '⚠',
    source: 'NOAA/NWS',
    updateInterval: 180000,

    init(viewer) {
      if (_viewer) throw new Error('NWS alerts layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('nws-alerts');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      overlayHost?.setVisible?.(NWS_ALERT_OVERLAY_SOURCE_ID, false);
      console.log('[Data:NwsAlerts] Initialized');
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible?.(NWS_ALERT_OVERLAY_SOURCE_ID, true);
      installClickHandler();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      removeClickHandler();
      clearSelection();
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const rows = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;

        const signature = JSON.stringify(
          rows
            .map(({ polygons, ...facts }) => facts)
            .sort((a, b) => a.stableId.localeCompare(b.stableId)),
        );
        if (signature === _snapshotSignature) {
          if (_selectedId) publishSelectedCard();
          _lastUpdate = Date.now();
          _lastError = null;
          return true;
        }
        const nextEntities = [];
        _rowById.clear();
        for (const row of rows) {
          const color = severityColor(row.severity);
          for (const [index, rings] of row.polygons.entries()) {
            const [outer, ...holes] = rings;
            const outerPositions = ringPositions(outer);
            nextEntities.push(
              new Cesium.Entity({
                id: `nws-alert:${row.stableId}:${index}`,
                polygon: {
                  hierarchy: new Cesium.PolygonHierarchy(
                    outerPositions,
                    holes.map(
                      (hole) =>
                        new Cesium.PolygonHierarchy(ringPositions(hole)),
                    ),
                  ),
                  material: new Cesium.ColorMaterialProperty(
                    color.withAlpha(0.2),
                  ),
                },
                polyline: {
                  positions: outerPositions,
                  clampToGround: true,
                  width: 2,
                  material: new Cesium.ColorMaterialProperty(
                    color.withAlpha(0.9),
                  ),
                },
              }),
            );
          }
          const { polygons, ...facts } = row;
          _rowById.set(row.stableId, {
            ...facts,
            anchor: alertAnchorDegrees(polygons),
          });
        }

        _dataSource.entities.removeAll();
        for (const entity of nextEntities) _dataSource.entities.add(entity);
        _snapshotSignature = signature;
        if (_selectedId && !_rowById.has(_selectedId)) _selectedId = null;
        publishSelectedCard();
        _count = rows.length;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(
          `[Data:NwsAlerts] Updated: ${_count} alerts, ${nextEntities.length} polygons`,
        );
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:NwsAlerts] Fetch error:', e);
        _lastError = e?.message || 'NWS alerts source unavailable';
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      removeClickHandler();
      clearSelection();
      _rowById.clear();
      _snapshotSignature = null;
      _viewer = null;
      _enabled = false;
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    /** Snapshot alert facts (with card-anchor coordinates) for the analyst query engine. */
    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const result = [];
      for (const row of _rowById.values()) {
        if (result.length >= limit) break;
        const { anchor, stableId, ...facts } = row;
        result.push({
          id: stableId,
          ...facts,
          lat: anchor.lat,
          lon: anchor.lon,
        });
      }
      return result;
    },

    getStats() {
      return { count: _count, lastUpdate: _lastUpdate, error: _lastError };
    },
  };
  return layer;
}
