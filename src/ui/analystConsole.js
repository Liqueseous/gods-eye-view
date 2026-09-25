import { createAnalystEngine } from '../data/analystEngine.js';
import { parseAnalystPrompt } from '../data/analystPrompt.js';
import {
  analystProviders,
  resolveRegionRingWithFallback,
} from '../voice/gevActions.js';

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
          (item) => `<li><strong>${escapeHtml(describeItem(item))}</strong><span>${escapeHtml(item.layerKey || '')}</span></li>`,
        )
        .join('')
    : '<li class="analyst-empty">No matching records in the loaded data.</li>';
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
    status.textContent = 'QUERYING LIVE LOADED DATA...';
    root.dataset.state = 'busy';
    try {
      const result = await engine.query(parsed.spec);
      if (currentRequest !== requestId) return;
      if (!result.ok) {
        status.textContent = result.error;
        root.dataset.state = 'error';
        return;
      }
      renderItems(list, result.items);
      const truncation = result.truncated ? ` showing ${result.items.length}` : '';
      const note = result.coverage?.warmup || result.coverage?.note || '';
      status.textContent = `${result.count} ${parsed.layerLabel} ${result.scopeLabel}${truncation}.${note ? ` ${note}` : ''}`;
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
