import { governorRequestRender } from '../renderGovernor.js';

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
  annotations,
  requestRender = governorRequestRender,
} = {}) {
  const toggle = document.getElementById('command-mode-toggle');
  const panel = document.getElementById('command-mode-panel');
  const form = document.getElementById('incident-form');
  const status = document.getElementById('command-mode-status');
  const count = document.getElementById('incident-count');
  const clear = document.getElementById('incident-clear');
  if (!toggle || !panel || !form || !annotations) return null;

  let active = false;
  let destroyed = false;
  const incidents = [];
  const listeners = [];

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
    annotations.clear();
    incidents.length = 0;
    setStatus('Annotation board cleared.');
    sync();
  };

  listen(toggle, 'click', onToggle);
  listen(form, 'submit', onSubmit);
  if (clear) listen(clear, 'click', onClear);
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
      listeners.forEach(([target, type, listener]) =>
        target.removeEventListener(type, listener),
      );
      document.body.classList.remove('command-mode');
    },
  };
  window.__gevIncidentCommand = api;
  return api;
}
