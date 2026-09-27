import { normalizeNwsAlertSnapshot } from '../../src/layers/nwsAlerts/records.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// NWS active alerts (public, keyless). Only alerts carrying inline
// polygon/multipolygon geometry render as precise shapes — zone-only (UGC)
// alerts are dropped by the normalizer rather than resolved through a
// second zone-geometry fetch.
const API_URL =
  'https://api.weather.gov/alerts/active?status=actual&message_type=alert';
const USER_AGENT = "God's Eye View (github.com/bilawalsidhu/gods-eye-view)";
const MIB = 1024 * 1024;
const CACHE_TTL_MS = 120_000;

/** Fixed-origin, bounded NWS alerts route for dev and preview. */
export function nwsAlertsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  const cache = new Map();
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 1200 });

  async function fetchAlerts() {
    const signal = AbortSignal.timeout(20_000);
    const response = await fetchImpl(API_URL, {
      signal,
      redirect: 'error',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/geo+json',
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('upstream_unavailable');
    }
    const payload = await readResponseJsonCapped(response, 16 * MIB, signal);
    const rows = normalizeNwsAlertSnapshot(payload);
    if (!rows) throw new Error('invalid_snapshot');
    return { fetchedAt: now(), rows };
  }

  async function acquire() {
    const key = 'alerts';
    const previous = cache.get(key);
    if (previous && now() - previous.savedAt < CACHE_TTL_MS)
      return { value: previous.value, stale: false };
    try {
      const { promise } = coalesceProxyRequest(inFlight, key, async () => {
        const value = await fetchAlerts();
        cache.set(key, { value, savedAt: now() });
        return value;
      });
      return { value: await promise, stale: false };
    } catch (error) {
      if (previous) return { value: previous.value, stale: true };
      throw error;
    }
  }

  async function handler(req, res) {
    const json = (status, value, stale = false) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 429 ? { 'Retry-After': '60' } : {}),
        ...(stale ? { 'X-Data-Stale': 'true' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const path = (req.url || '/').split('?')[0];
    if (path !== '/' && path !== '')
      return json(404, { error: 'unknown_route' });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    try {
      const { value, stale } = await acquire();
      json(200, stale ? { ...value, stale: true } : value, stale);
    } catch (error) {
      json(502, { error: 'nws_alerts_unavailable' });
    }
  }

  return {
    name: 'nws-alerts',
    configureServer({ middlewares }) {
      middlewares.use('/api/nws-alerts', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/nws-alerts', handler);
    },
  };
}
