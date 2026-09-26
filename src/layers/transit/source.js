import { fetchTransitHistory } from '../../sources/transitHistory.js';

/** Request transit snapshots through caller-owned transport. */
export function createTransitSource({
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  return {
    getHistory(feedId, vehicleId, { signal } = {}) {
      signal?.throwIfAborted();
      return fetchTransitHistory(feedId, vehicleId, signal, fetchImpl);
    },
    requestSnapshot(feedId, { signal } = {}) {
      signal?.throwIfAborted();
      if (typeof feedId !== 'string' || !feedId || feedId.length > 160)
        throw new TypeError('A transit feed identifier is required');
      return Promise.resolve(
        fetchImpl(`/api/transit/vehicles/${encodeURIComponent(feedId)}`, {
          signal,
          headers: { Accept: 'application/json' },
        }),
      ).then((response) => {
        signal?.throwIfAborted();
        return {
          ok: response.ok,
          status: response.status,
          headers: response.headers,
          async json() {
            const body = await response.json();
            signal?.throwIfAborted();
            return body;
          },
        };
      });
    },
    requestRouteDetails(feedId, routeId, { signal } = {}) {
      signal?.throwIfAborted();
      if (
        feedId !== 'mbta' ||
        typeof routeId !== 'string' ||
        !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(routeId)
      )
        throw new TypeError('A registered MBTA route id is required');
      return Promise.resolve(
        fetchImpl(
          `/api/transit/route-details/${encodeURIComponent(feedId)}/${encodeURIComponent(routeId)}`,
          {
            signal,
            headers: { Accept: 'application/json' },
          },
        ),
      ).then((response) => {
        signal?.throwIfAborted();
        return {
          ok: response.ok,
          status: response.status,
          headers: response.headers,
          async json() {
            const body = await response.json();
            signal?.throwIfAborted();
            if (
              response.ok &&
              (body?.feedId !== feedId ||
                body?.routeId !== routeId ||
                !Array.isArray(body.predictions) ||
                !Array.isArray(body.alerts))
            )
              throw new Error('Invalid MBTA route details response');
            return body;
          },
        };
      });
    },
  };
}
