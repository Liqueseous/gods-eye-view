import { governorRequestRender } from '../renderGovernor.js';
import * as Cesium from 'cesium';
import { pickWorldFromScreen } from '../annotations/annotationResolver.js';
import { claimPointer, releasePointer } from '../data/inputOwnership.js';

const SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);
const COLORS = {
  low: 'cyan',
  medium: 'amber',
  high: 'red',
  critical: 'red',
};

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

export function initIncidentCommand({
  viewer,
  annotations,
  requestRender = governorRequestRender,
} = {}) {
  const toggle = document.getElementById('command-mode-toggle');
  const panel = document.getElementById('command-mode-panel');
  const form = document.getElementById('incident-form');
  const status = document.getElementById('command-mode-status');
  const count = document.getElementById('incident-count');
  const clear = document.getElementById('incident-clear');
  const place = document.getElementById('incident-place');
  const list = document.getElementById('incident-list');
  if (!toggle || !panel || !form || !annotations || !viewer) return null;

  let active = false;
  let destroyed = false;
  const incidents = [];
  const listeners = [];
  let placeHandler = null;
  let placeLease = null;

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
    if (count) count.textContent = String(incidents.length);
    if (list) {
      list.replaceChildren(
        ...incidents.map((incident) => {
          const row = document.createElement('div');
          row.className = `incident-list-item severity-${incident.severity}`;
          row.innerHTML = `<span class="incident-list-severity">${incident.severity}</span><span class="incident-list-label"></span>`;
          row.querySelector('.incident-list-label').textContent =
            incident.label;
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
            setStatus(`Incident removed · ${incident.label}`);
            sync();
          });
          row.append(focus, remove);
          return row;
        }),
      );
    }
    requestRender('command-mode');
  };
  const onToggle = () => {
    active = !active;
    setStatus(active ? 'Command mode ready' : 'Command mode offline');
    sync();
  };
  const onSubmit = async (event) => {
    event.preventDefault();
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
    let result;
    try {
      result = await annotations.annotate(
        [
          {
            type: 'pin',
            manual: true,
            label: `[${incident.severity.toUpperCase()}] ${incident.label}`,
            color: COLORS[incident.severity],
            latitude: incident.latitude,
            longitude: incident.longitude,
          },
        ],
        { persist: true },
      );
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
    form.reset();
    form.elements.severity.value = 'medium';
    setStatus(`Incident recorded · ${incident.label}`);
    sync();
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
    setStatus('Annotation board cleared.');
    sync();
  };
  const stopPlacing = () => {
    placeHandler?.destroy();
    placeHandler = null;
    if (placeLease) releasePointer(placeLease);
    placeLease = null;
    if (place) place.classList.remove('active');
  };
  const onPlace = () => {
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
    placeHandler.setInputAction((event) => {
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
      setStatus('Coordinates captured. Add an incident name.');
      form.elements.label.focus();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  };
  const onKeyDown = (event) => {
    if (event.key === 'Escape' && placeHandler) stopPlacing();
  };

  listen(toggle, 'click', onToggle);
  listen(form, 'submit', onSubmit);
  if (clear) listen(clear, 'click', onClear);
  if (place) listen(place, 'click', onPlace);
  listen(document, 'keydown', onKeyDown);
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
    },
  };
  window.__gevIncidentCommand = api;
  return api;
}
