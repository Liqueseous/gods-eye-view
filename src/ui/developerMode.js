/** Persisted opt-in switch for tools intended for development and QA. */
export const DEVELOPER_MODE_STORAGE_KEY = 'godsEyeView.developerMode.enabled';

function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

export function readDeveloperMode(storage = defaultStorage()) {
  try {
    return storage?.getItem(DEVELOPER_MODE_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writeDeveloperMode(enabled, storage = defaultStorage()) {
  try {
    storage?.setItem(DEVELOPER_MODE_STORAGE_KEY, String(Boolean(enabled)));
  } catch {
    // Storage can be unavailable in private or locked-down browser contexts.
  }
}

/** Bind the persisted switch and developer-only surfaces. */
export function initDeveloperMode({ storage, documentRef = globalThis.document } = {}) {
  const toggle = documentRef?.querySelector('#developer-mode-toggle');
  const analyst = documentRef?.querySelector('#analyst-console');
  if (!toggle || !analyst) return null;

  const apply = (enabled) => {
    const active = Boolean(enabled);
    toggle.checked = active;
    toggle.setAttribute('aria-checked', String(active));
    analyst.hidden = !active;
    analyst.classList.toggle('developer-only', active);
    documentRef.documentElement.classList.toggle('developer-mode', active);
  };
  const onChange = () => {
    writeDeveloperMode(toggle.checked, storage);
    apply(toggle.checked);
  };

  toggle.addEventListener('change', onChange);
  apply(readDeveloperMode(storage));

  return {
    enabled: () => toggle.checked,
    destroy() {
      toggle.removeEventListener('change', onChange);
    },
  };
}