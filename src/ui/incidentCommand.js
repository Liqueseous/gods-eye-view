import { governorRequestRender } from '../renderGovernor.js';
import * as Cesium from 'cesium';
import { pickWorldFromScreen } from '../annotations/annotationResolver.js';
import { claimPointer, releasePointer } from '../data/inputOwnership.js';

const SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);
const INCIDENT_STATUSES = [
  'new',
  'investigating',
  'active',
  'contained',
  'resolved',
];
const INCIDENT_SEVERITIES = ['low', 'medium', 'high', 'critical'];
const STATUS_COUNT_LABELS = {
  new: 'NEW',
  investigating: 'INV',
  active: 'ACT',
  contained: 'CNT',
  resolved: 'RES',
};
const INCIDENT_STORAGE_KEY = 'gev.command.incidents.v1';
const SEVERITY_COLORS = {
  low: 'cyan',
  medium: 'amber',
  high: 'red',
  critical: 'red',
};
const STATUS_ICON_MARKUP = {
  new: '<path d="M24 14v20M14 24h20" stroke="COLOR" stroke-width="4" stroke-linecap="round"/>',
  investigating:
    '<path d="M18 18c0-4 2.5-6 6-6s6 2 6 5c0 3-2 4-5 6v2M24 32v.5" stroke="COLOR" stroke-width="4" stroke-linecap="round" fill="none"/>',
  active:
    '<path d="M24 12v18M24 36v.5" stroke="COLOR" stroke-width="4" stroke-linecap="round"/>',
  contained:
    '<path d="m14 25 7 7 13-15" stroke="COLOR" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  resolved: '<circle cx="24" cy="24" r="6" fill="COLOR"/>',
};

export function incidentMarkerSpec(incident) {
  const color =
    {
      new: '#39d0ff',
      investigating: '#ffb547',
      active: '#ff6b6b',
      contained: '#5dff9f',
      resolved: '#8be9ff',
    }[incident.status] || '#8be9ff';
  const iconMarkup = (
    STATUS_ICON_MARKUP[incident.status] || STATUS_ICON_MARKUP.resolved
  ).replaceAll('COLOR', color);
  if (incident.kind === 'area') {
    return {
      type: 'area',
      manual: true,
      label: `[${incident.status.toUpperCase()}] [${incident.severity.toUpperCase()}] ${incident.label}`,
      color: SEVERITY_COLORS[incident.severity] || 'amber',
      ring: incident.ring,
      markerIcon: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><circle cx="24" cy="24" r="20" fill="#0b1622" stroke="${color}" stroke-width="4"/>${iconMarkup}</svg>`)}`,
    };
  }
  return {
    type: 'pin',
    manual: true,
    label: `[${incident.status.toUpperCase()}] [${incident.severity.toUpperCase()}] ${incident.label}`,
    color: SEVERITY_COLORS[incident.severity] || 'amber',
    markerIcon: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><circle cx="24" cy="24" r="20" fill="#0b1622" stroke="${color}" stroke-width="4"/>${iconMarkup}</svg>`)}`,
    latitude: incident.latitude,
    longitude: incident.longitude,
  };
}

function parseCoordinate(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max
    ? number
    : null;
}

export function parseIncidentForm({ label, latitude, longitude, severity }) {
  const name = String(label || '').trim();
  const lat = parseCoordinate(latitude, -90, 90);
  const lon = parseCoordinate(longitude, -180, 180);
  const level = SEVERITIES.has(severity) ? severity : 'medium';
  if (!name) return { ok: false, error: 'Enter an incident name.' };
  if (lat === null || lon === null)
    return { ok: false, error: 'Enter valid latitude and longitude.' };
  return {
    ok: true,
    incident: {
      label: name.slice(0, 80),
      latitude: lat,
      longitude: lon,
      severity: level,
    },
  };
}

function formatIncidentTime(value) {
  return new Date(value).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function ringCentroid(ring) {
  return {
    latitude: ring.reduce((sum, [, lat]) => sum + lat, 0) / ring.length,
    longitude: ring.reduce((sum, [lon]) => sum + lon, 0) / ring.length,
  };
}

export function readStoredIncidents(storage) {
  try {
    const raw = storage?.getItem(INCIDENT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (incident) =>
          incident &&
          typeof incident.label === 'string' &&
          (incident.kind === 'area'
            ? Array.isArray(incident.ring) &&
              incident.ring.length >= 3 &&
              incident.ring.every(
                ([lon, lat]) =>
                  Number.isFinite(lon) &&
                  Number.isFinite(lat) &&
                  Math.abs(lon) <= 180 &&
                  Math.abs(lat) <= 90,
              )
            : Number.isFinite(incident.latitude) &&
              incident.latitude >= -90 &&
              incident.latitude <= 90 &&
              Number.isFinite(incident.longitude) &&
              incident.longitude >= -180 &&
              incident.longitude <= 180) &&
          SEVERITIES.has(incident.severity) &&
          INCIDENT_STATUSES.includes(incident.status),
      )
      .map((incident) => {
        const areaRecord = incident.kind === 'area';
        const centre = areaRecord ? ringCentroid(incident.ring) : null;
        return {
          label: incident.label.slice(0, 80),
          ...(areaRecord ? { kind: 'area', ring: incident.ring } : {}),
          latitude: centre?.latitude ?? incident.latitude,
          longitude: centre?.longitude ?? incident.longitude,
          severity: incident.severity,
          status: incident.status,
          createdAt: Number.isFinite(incident.createdAt)
            ? incident.createdAt
            : Date.now(),
          updatedAt: Number.isFinite(incident.updatedAt)
            ? incident.updatedAt
            : Date.now(),
        };
      });
  } catch (error) {
    console.warn('[Command] Saved incidents could not be read:', error);
    return [];
  }
}

function writeStoredIncidents(incidents, storage) {
  try {
    storage?.setItem(
      INCIDENT_STORAGE_KEY,
      JSON.stringify(
        incidents.map(({ annotationId, ...incident }) => incident),
      ),
    );
  } catch (error) {
    console.warn('[Command] Incidents could not be saved:', error);
  }
}

function readStoredUiControl(id) {
  if (typeof localStorage === 'undefined') return null;
  try {
    const state = JSON.parse(
      localStorage.getItem('godsEyeView.v1.uiMemory') || '{}',
    )?.[id];
    return state && typeof state === 'object' ? state : null;
  } catch (error) {
    console.warn('[Command] Saved UI state could not be read:', error);
    return null;
  }
}

export function initIncidentCommand({
  viewer,
  annotations,
  requestRender = governorRequestRender,
  storage = typeof localStorage === 'undefined' ? null : localStorage,
} = {}) {
  const toggle = document.getElementById('command-mode-toggle');
  const panel = document.getElementById('command-mode-panel');
  const form = document.getElementById('incident-form');
  const status = document.getElementById('command-mode-status');
  const count = document.getElementById('incident-count');
  const statusCounts = document.getElementById('incident-status-counts');
  const severityCounts = document.getElementById('incident-severity-counts');
  const clear = document.getElementById('incident-clear');
  const place = document.getElementById('incident-place');
  const area = document.getElementById('incident-area');
  const list = document.getElementById('incident-list');
  const filter = document.getElementById('incident-status-filter');
  if (!toggle || !panel || !form || !annotations || !viewer) return null;

  const storedToggle = readStoredUiControl('command-mode-toggle');
  let active =
    toggle.classList.contains('active') ||
    storedToggle?.active === true ||
    storedToggle?.pressed === true;
  let destroyed = false;
  const incidents = [];
  const listeners = [];
  let placeHandler = null;
  let placeLease = null;
  let areaVertices = [];
  let drawingArea = false;
  let areaCursor = null;
  const areaPreviewSource = new Cesium.CustomDataSource(
    'gev-command-area-preview',
  );
  viewer.dataSources.add(areaPreviewSource);
  const areaPreviewLine = areaPreviewSource.entities.add({
    polyline: {
      positions: new Cesium.CallbackProperty(() => {
        const points = areaVertices.slice();
        if (areaCursor) points.push(areaCursor);
        if (points.length >= 3) points.push(points[0]);
        if (points.length < 2) return [];
        return Cesium.Cartesian3.fromDegreesArray(points.flat());
      }, false),
      width: 3,
      material: new Cesium.PolylineDashMaterialProperty({
        color: Cesium.Color.fromCssColorString('#ffb547').withAlpha(0.9),
        dashLength: 14,
      }),
      clampToGround: true,
    },
    show: false,
  });
  const areaPreviewFill = areaPreviewSource.entities.add({
    polygon: {
      hierarchy: new Cesium.CallbackProperty(() => {
        const points = areaVertices.slice();
        if (areaCursor) points.push(areaCursor);
        if (points.length < 3) return null;
        return new Cesium.PolygonHierarchy(
          Cesium.Cartesian3.fromDegreesArray(points.flat()),
        );
      }, false),
      material: Cesium.Color.fromCssColorString('#ffb547').withAlpha(0.16),
      classificationType: Cesium.ClassificationType.BOTH,
    },
    show: false,
  });
  const areaPreviewPoints = [];
  const syncAreaPreview = () => {
    const visible = drawingArea;
    areaPreviewLine.show = visible;
    areaPreviewFill.show =
      visible && (areaVertices.length >= 2 || !!areaCursor);
    while (areaPreviewPoints.length < areaVertices.length) {
      areaPreviewPoints.push(
        areaPreviewSource.entities.add({
          position: Cesium.Cartesian3.ZERO,
          point: {
            pixelSize: 9,
            color: Cesium.Color.fromCssColorString('#ffb547'),
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          show: false,
        }),
      );
    }
    areaPreviewPoints.forEach((entity, index) => {
      const point = areaVertices[index];
      entity.show = visible;
      if (point)
        entity.position = Cesium.Cartesian3.fromDegrees(point[0], point[1]);
    });
    requestRender('command-area-preview');
  };
  let statusFilter = 'all';
  const storedIncidents = readStoredIncidents(storage);

  const listen = (target, type, listener) => {
    target.addEventListener(type, listener);
    listeners.push([target, type, listener]);
  };
  const setStatus = (message, error = false) => {
    if (status) {
      status.textContent = message;
      status.dataset.state = error ? 'error' : 'ok';
    }
  };
  const sync = () => {
    toggle.classList.toggle('active', active);
    toggle.setAttribute('aria-pressed', String(active));
    panel.hidden = !active;
    document.body.classList.toggle('command-mode', active);
    const visibleIncidents =
      statusFilter === 'all'
        ? incidents
        : incidents.filter((incident) => incident.status === statusFilter);
    if (count) count.textContent = String(incidents.length);
    const renderCounts = (target, values, className) => {
      if (!target) return;
      target.replaceChildren(
        ...values.map((value) => {
          const chip = document.createElement('span');
          const total = incidents.filter(
            (incident) => incident[className] === value,
          ).length;
          chip.className = `incident-count-chip ${className}-${value}`;
          chip.setAttribute('aria-label', `${value}: ${total}`);
          chip.title = `${value}: ${total}`;
          chip.textContent = `${className === 'status' ? STATUS_COUNT_LABELS[value] : value} ${total}`;
          return chip;
        }),
      );
    };
    renderCounts(statusCounts, INCIDENT_STATUSES, 'status');
    renderCounts(severityCounts, INCIDENT_SEVERITIES, 'severity');
    if (list) {
      list.replaceChildren(
        ...visibleIncidents.map((incident) => {
          const row = document.createElement('div');
          row.className = `incident-list-item severity-${incident.severity} status-${incident.status}`;
          row.innerHTML = `<span class="incident-list-status-symbol" aria-hidden="true"></span><span class="incident-list-type" aria-hidden="true"></span><span class="incident-list-severity">${incident.severity}</span><span class="incident-list-label"></span><span class="incident-list-time"></span>`;
          const type = incident.kind === 'area' ? 'area' : 'point';
          const typeIndicator = row.querySelector('.incident-list-type');
          typeIndicator.classList.add(`incident-list-type-${type}`);
          typeIndicator.title =
            type === 'area' ? 'Event area' : 'Point incident';
          typeIndicator.setAttribute(
            'aria-label',
            type === 'area' ? 'Event area' : 'Point incident',
          );
          const statusSymbol =
            incident.status === 'active'
              ? '!'
              : ['contained', 'resolved'].includes(incident.status)
                ? '✓'
                : incident.status === 'investigating'
                  ? '?'
                  : '+';
          row.querySelector('.incident-list-status-symbol').textContent = statusSymbol;
          row.querySelector('.incident-list-label').textContent =
            incident.label;
          row.querySelector('.incident-list-time').textContent =
            formatIncidentTime(incident.updatedAt);
          const statusSelect = document.createElement('select');
          statusSelect.className = 'pp-select incident-status';
          statusSelect.setAttribute(
            'aria-label',
            `Status for ${incident.label}`,
          );
          statusSelect.replaceChildren(
            ...INCIDENT_STATUSES.map((value) => {
              const option = document.createElement('option');
              option.value = value;
              option.textContent = value;
              option.selected = value === incident.status;
              return option;
            }),
          );
          statusSelect.addEventListener('change', async () => {
            const previousStatus = incident.status;
            const previousId = incident.annotationId;
            incident.status = statusSelect.value;
            incident.updatedAt = Date.now();
            try {
              if (previousId) annotations.remove?.(previousId);
              const result = await annotations.annotate(
                [incidentMarkerSpec(incident)],
                { persist: true },
              );
              if (!result?.ok)
                throw new Error('marker update returned no result');
              incident.annotationId = result.ids?.[0] || null;
              writeStoredIncidents(incidents, storage);
              setStatus(`Status updated · ${incident.label}`);
            } catch (error) {
              incident.status = previousStatus;
              incident.annotationId = previousId;
              console.warn('[Command] Incident status marker failed:', error);
              setStatus('Incident status marker could not be updated.', true);
            }
            sync();
          });
          const focus = document.createElement('button');
          focus.type = 'button';
          focus.className = 'pp-mode-btn incident-focus';
          focus.textContent = 'Focus';
          focus.addEventListener('click', () => {
            viewer.camera.flyTo({
              destination: Cesium.Cartesian3.fromDegrees(
                incident.longitude,
                incident.latitude,
                1200,
              ),
              duration: 0.8,
            });
          });
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'pp-mode-btn incident-remove';
          remove.textContent = 'Remove';
          remove.addEventListener('click', () => {
            if (incident.annotationId)
              annotations.remove?.(incident.annotationId);
            const index = incidents.indexOf(incident);
            if (index >= 0) incidents.splice(index, 1);
            writeStoredIncidents(incidents, storage);
            setStatus(`Incident removed · ${incident.label}`);
            sync();
          });
          row.append(statusSelect, focus, remove);
          return row;
        }),
      );
    }
    requestRender('command-mode');
  };
  const onFilter = () => {
    statusFilter = filter?.value || 'all';
    sync();
  };
  const onToggle = () => {
    active = !active;
    setStatus(active ? 'Command mode ready' : 'Command mode offline');
    sync();
  };
  const createIncidentFromForm = async () => {
    if (destroyed) return;
    const fields = new FormData(form);
    const parsed = parseIncidentForm({
      label: fields.get('label'),
      latitude: fields.get('latitude'),
      longitude: fields.get('longitude'),
      severity: fields.get('severity'),
    });
    if (!parsed.ok) {
      setStatus(parsed.error, true);
      return;
    }
    const incident = parsed.incident;
    incident.status = 'new';
    let result;
    try {
      result = await annotations.annotate([incidentMarkerSpec(incident)], {
        persist: true,
      });
    } catch (error) {
      console.warn('[Command] Incident marker failed:', error);
      setStatus('Incident marker could not be placed.', true);
      return;
    }
    if (!result?.ok) {
      setStatus('Incident marker could not be placed.', true);
      return;
    }
    incidents.push(incident);
    incident.annotationId = result.ids?.[0] || null;
    incident.createdAt = Date.now();
    incident.updatedAt = incident.createdAt;
    writeStoredIncidents(incidents, storage);
    form.reset();
    form.elements.severity.value = 'medium';
    setStatus(`Incident recorded · ${incident.label}`);
    sync();
  };
  const createAreaFromForm = async () => {
    const label = String(form.elements.label.value || '').trim();
    if (!label) {
      setStatus('Enter an incident name before drawing an area.', true);
      form.elements.label.focus();
      return;
    }
    if (areaVertices.length < 3) {
      setStatus('Draw at least three points before finishing.', true);
      return;
    }
    const centre = ringCentroid(areaVertices);
    const incident = {
      kind: 'area',
      label: label.slice(0, 80),
      ring: areaVertices.map(([lon, lat]) => [lon, lat]),
      latitude: centre.latitude,
      longitude: centre.longitude,
      severity: SEVERITIES.has(form.elements.severity.value)
        ? form.elements.severity.value
        : 'medium',
      status: 'new',
      createdAt: Date.now(),
    };
    incident.updatedAt = incident.createdAt;
    try {
      const result = await annotations.annotate(
        [incidentMarkerSpec(incident)],
        {
          persist: true,
        },
      );
      if (!result?.ok) throw new Error('area marker returned no result');
      incident.annotationId = result.ids?.[0] || null;
      incidents.push(incident);
      writeStoredIncidents(incidents, storage);
      areaVertices = [];
      areaCursor = null;
      drawingArea = false;
      area.classList.remove('active');
      stopPlacing();
      syncAreaPreview();
      form.reset();
      form.elements.severity.value = 'medium';
      setStatus(`Event area recorded · ${incident.label}`);
      sync();
    } catch (error) {
      console.warn('[Command] Event area failed:', error);
      setStatus('Event area could not be created.', true);
    }
  };
  const onSubmit = async (event) => {
    event.preventDefault();
    await createIncidentFromForm();
  };
  const onClear = () => {
    if (!incidents.length) {
      setStatus('No incidents to clear.');
      return;
    }
    const ids = incidents
      .map((incident) => incident.annotationId)
      .filter(Boolean);
    if (typeof annotations.remove === 'function') annotations.remove(ids);
    else annotations.clear();
    incidents.length = 0;
    writeStoredIncidents(incidents, storage);
    setStatus('Annotation board cleared.');
    sync();
  };
  const stopPlacing = () => {
    placeHandler?.destroy();
    placeHandler = null;
    if (placeLease) releasePointer(placeLease);
    placeLease = null;
    if (place) place.classList.remove('active');
    areaCursor = null;
    syncAreaPreview();
  };
  const onPlace = () => {
    if (drawingArea) {
      drawingArea = false;
      areaVertices = [];
      areaCursor = null;
      area.classList.remove('active');
      stopPlacing();
      setStatus('Event area cancelled.');
      syncAreaPreview();
      return;
    }
    if (placeHandler) {
      stopPlacing();
      setStatus('Placement cancelled.');
      return;
    }
    placeLease = claimPointer('incident-command');
    if (!placeLease) {
      setStatus('Another map tool is using the pointer.', true);
      return;
    }
    setStatus('Click the globe to place the incident.');
    place.classList.add('active');
    placeHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    placeHandler.setInputAction(async (event) => {
      const canvas = viewer.scene.canvas;
      const width = canvas.clientWidth || canvas.width || 1;
      const height = canvas.clientHeight || canvas.height || 1;
      const point = pickWorldFromScreen(
        viewer,
        event.position.x / width,
        event.position.y / height,
      );
      if (!point) {
        setStatus('Click on the globe surface.', true);
        return;
      }
      form.elements.latitude.value = point.lat.toFixed(5);
      form.elements.longitude.value = point.lon.toFixed(5);
      stopPlacing();
      if (String(form.elements.label.value || '').trim()) {
        await createIncidentFromForm();
      } else {
        setStatus('Coordinates captured. Add an incident name.');
        form.elements.label.focus();
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  };
  const onArea = () => {
    if (drawingArea) {
      drawingArea = false;
      areaVertices = [];
      areaCursor = null;
      area.classList.remove('active');
      stopPlacing();
      setStatus('Event area cancelled.');
      return;
    }
    placeLease = claimPointer('incident-command');
    if (!placeLease) {
      setStatus('Another map tool is using the pointer.', true);
      return;
    }
    drawingArea = true;
    areaVertices = [];
    area.classList.add('active');
    syncAreaPreview();
    setStatus('Click three or more points, then finish the area.');
    placeHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    placeHandler.setInputAction((event) => {
      const canvas = viewer.scene.canvas;
      const point = pickWorldFromScreen(
        viewer,
        event.position.x / (canvas.clientWidth || canvas.width || 1),
        event.position.y / (canvas.clientHeight || canvas.height || 1),
      );
      if (!point) {
        setStatus('Click on the globe surface.', true);
        return;
      }
      areaVertices.push([point.lon, point.lat]);
      syncAreaPreview();
      setStatus(
        `${areaVertices.length} area point${areaVertices.length === 1 ? '' : 's'} captured.`,
      );
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    placeHandler.setInputAction((event) => {
      const canvas = viewer.scene.canvas;
      const point = pickWorldFromScreen(
        viewer,
        event.endPosition.x / (canvas.clientWidth || canvas.width || 1),
        event.endPosition.y / (canvas.clientHeight || canvas.height || 1),
      );
      areaCursor = point ? [point.lon, point.lat] : null;
      syncAreaPreview();
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
  };
  const onKeyDown = async (event) => {
    if (!drawingArea || !placeHandler) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      await createAreaFromForm();
      return;
    }
    if (event.key !== 'Escape') return;
    stopPlacing();
    if (drawingArea) {
      drawingArea = false;
      areaVertices = [];
      areaCursor = null;
      area.classList.remove('active');
      setStatus('Event area cancelled.');
      syncAreaPreview();
    }
  };

  listen(toggle, 'click', onToggle);
  listen(form, 'submit', onSubmit);
  if (clear) listen(clear, 'click', onClear);
  if (place) listen(place, 'click', onPlace);
  if (area) listen(area, 'click', onArea);
  if (filter) listen(filter, 'change', onFilter);
  listen(document, 'keydown', onKeyDown);
  void (async () => {
    for (const incident of storedIncidents) {
      try {
        const result = await annotations.annotate(
          [incidentMarkerSpec(incident)],
          { persist: true },
        );
        if (result?.ok) {
          incident.annotationId = result.ids?.[0] || null;
          incidents.push(incident);
        }
      } catch (error) {
        console.warn(
          `[Command] Saved incident could not be restored: ${incident.label}`,
          error,
        );
      }
    }
    sync();
    if (incidents.length)
      setStatus(
        `Restored ${incidents.length} saved incident${incidents.length === 1 ? '' : 's'}.`,
      );
  })();
  sync();

  const api = {
    get active() {
      return active;
    },
    get incidents() {
      return incidents.slice();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopPlacing();
      listeners.forEach(([target, type, listener]) =>
        target.removeEventListener(type, listener),
      );
      document.body.classList.remove('command-mode');
      areaPreviewSource.entities.removeAll();
      viewer.dataSources.remove(areaPreviewSource, true);
    },
  };
  window.__gevIncidentCommand = api;
  return api;
}
