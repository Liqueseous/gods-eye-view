import { createAnalystEngine } from '../data/analystEngine.js';
import { parseAnalystPrompt } from '../data/analystPrompt.js';
import {
  analystProviders,
  resolveRegionRingWithFallback,
} from '../voice/gevActions.js';
import { CITY_POIS, findPoiByName } from '../locations.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function describeItem(item) {
  return item.callsign || item.name || item.label || item.place || item.id || 'Unnamed record';
}

function renderItems(list, items) {
  list.innerHTML = items.length
    ? items
        .map(
          (item) => `<li><div><strong>${escapeHtml(describeItem(item))}</strong>${item.description ? `<p>${escapeHtml(item.description)}</p>` : ''}${item.history ? `<p class="analyst-history">${escapeHtml(item.history)}</p>` : ''}${item.extract ? `<p class="analyst-history">${escapeHtml(item.extract)}</p>` : ''}</div><span>${escapeHtml(item.source || item.layerKey || '')}</span></li>`,
        )
        .join('')
    : '<li class="analyst-empty">No matching records in the loaded data.</li>';
}

function findNearestKnownLandmark(view) {
  if (!view) return null;
  let nearest = null;
  for (const [cityId, city] of Object.entries(CITY_POIS)) {
    for (const poi of city.pois) {
      const distanceKm = haversineKm(view.lat, view.lon, poi.lat, poi.lon);
      if (!nearest || distanceKm < nearest.distanceKm) nearest = { cityId, city, poi, distanceKm };
    }
  }
  return nearest?.distanceKm <= 100 ? nearest : null;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const radians = Math.PI / 180;
  const dLat = (lat2 - lat1) * radians;
  const dLon = (lon2 - lon1) * radians;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * radians) * Math.cos(lat2 * radians) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

async function queryLandmark(name, providers) {
  const match = name ? findPoiByName(name) : findNearestKnownLandmark(providers.getViewContext());
  const staticPoi = match
    ? match.poi || CITY_POIS[match.cityId]?.pois[match.index]
    : null;
  if (staticPoi?.description || staticPoi?.history) {
    return {
      ok: true,
      count: 1,
      items: [{
        layerKey: 'landmark',
        source: 'curated',
        name: staticPoi.name,
        description: staticPoi.description,
        history: staticPoi.history,
        yearBuilt: staticPoi.yearBuilt,
        architect: staticPoi.architect,
        style: staticPoi.style,
      }],
      scopeLabel: match ? `near ${match.city.name}` : 'in the current view',
    };
  }

  const lookupName = staticPoi?.name || name;
  if (!lookupName) return { ok: false, error: 'No known landmark is close to the current view.' };
  const response = await fetch(`/api/wikipedia/summary?name=${encodeURIComponent(lookupName)}`);
  const data = await response.json();
  if (!response.ok || !data.ok) return { ok: false, error: `No information found for "${lookupName}".` };
  return {
    ok: true,
    count: 1,
    items: [{ layerKey: 'landmark', source: 'Wikipedia', name: lookupName, description: data.description, extract: data.extract, url: data.url }],
    scopeLabel: 'Wikipedia lookup',
  };
}

/** Mount the local-first analyst surface. */
export function initAnalystConsole({
  viewer,
  dataManager,
  placeSearch,
  annotationResolver,
} = {}) {
  const root = document.getElementById('analyst-console');
  if (!root || !viewer || !dataManager) return null;
  const form = root.querySelector('form');
  const input = root.querySelector('#analyst-query');
  const status = root.querySelector('#analyst-status');
  const list = root.querySelector('#analyst-results');
  const toggle = root.querySelector('#analyst-console-toggle');
  const popover = root.querySelector('#analyst-console-popover');
  if (!form || !input || !status || !list || !toggle || !popover) return null;

  const engine = createAnalystEngine(
    analystProviders(viewer, dataManager, {
      placeSearch,
      resolveRegionRing: (name) =>
        resolveRegionRingWithFallback(name, placeSearch, annotationResolver),
    }),
  );
  let requestId = 0;

  const setOpen = (open) => {
    root.classList.toggle('collapsed', !open);
    toggle.setAttribute('aria-expanded', String(open));
  };

  const run = async (event) => {
    event?.preventDefault();
    const parsed = parseAnalystPrompt(input.value);
    if (!parsed.ok) {
      status.textContent = parsed.error;
      root.dataset.state = 'error';
      return;
    }
    const currentRequest = ++requestId;
    status.textContent = parsed.kind === 'landmark' ? 'LOOKING UP LANDMARK CONTEXT...' : 'QUERYING LIVE LOADED DATA...';
    root.dataset.state = 'busy';
    try {
      const providers = analystProviders(viewer, dataManager, {
        placeSearch,
        resolveRegionRing: (name) => resolveRegionRingWithFallback(name, placeSearch, annotationResolver),
      });
      const result = parsed.kind === 'landmark'
        ? await queryLandmark(parsed.landmarkName, providers)
        : await engine.query(parsed.spec);
      if (currentRequest !== requestId) return;
      if (!result.ok) {
        status.textContent = result.error;
        root.dataset.state = 'error';
        return;
      }
      renderItems(list, result.items);
      const truncation = result.truncated ? ` showing ${result.items.length}` : '';
      const note = result.coverage?.warmup || result.coverage?.note || '';
      status.textContent = parsed.kind === 'landmark'
        ? `1 landmark found ${result.scopeLabel}.`
        : `${result.count} ${parsed.layerLabel} ${result.scopeLabel}${truncation}.${note ? ` ${note}` : ''}`;
      root.dataset.state = 'ready';
    } catch (error) {
      if (currentRequest !== requestId) return;
      status.textContent = error instanceof Error ? error.message : String(error);
      root.dataset.state = 'error';
    }
  };

  const onToggle = () => setOpen(root.classList.contains('collapsed'));
  const onEscape = (event) => {
    if (event.key === 'Escape' && !root.classList.contains('collapsed')) {
      event.preventDefault();
      setOpen(false);
      toggle.focus();
    }
  };
  const onExample = (event) => {
    const button = event.target.closest('[data-analyst-example]');
    if (!button) return;
    input.value = button.dataset.analystExample || '';
    input.focus();
  };

  toggle.addEventListener('click', onToggle);
  form.addEventListener('submit', run);
  popover.addEventListener('click', onExample);
  root.addEventListener('keydown', onEscape);
  setOpen(false);

  return {
    engine,
    destroy() {
      requestId += 1;
      toggle.removeEventListener('click', onToggle);
      form.removeEventListener('submit', run);
      popover.removeEventListener('click', onExample);
      root.removeEventListener('keydown', onEscape);
    },
  };
}
