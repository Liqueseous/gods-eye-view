import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransitService } from 'gods-eye-view/sources/transit-service';
import { createTransitSource } from 'gods-eye-view/layers/transit/source';
import { getTransitFeed, publicTransitCatalog } from '../data/transitFeeds.js';
import { resolveTransitFeedUrl } from '../../server/providers/transit.js';

const request = (path, method = 'GET') => ({
  url: `https://example.test${path}`,
  method,
});

test('portable service confines requests to registered feeds and GET', async (t) => {
  let calls = 0;
  const service = createTransitService({
    fetchImpl: async () => {
      calls++;
      throw new Error('unexpected');
    },
  });
  t.after(service.close);
  for (const path of [
    '/other',
    '/api/transit/vehicles/unknown',
    '/api/transit/vehicles/https%3A%2F%2Fexample.test',
  ]) {
    assert.equal((await service.handle(request(path))).status, 404);
  }
  for (const method of ['POST', 'HEAD', 'TRACE']) {
    assert.equal(
      (await service.handle(request('/api/transit/feeds', method))).status,
      405,
    );
  }
  const response = await service.handle(request('/api/transit/feeds'));
  assert.ok(response instanceof Response);
  assert.equal(response.status, 200);
  assert.ok((await response.json()).feeds.some((feed) => feed.id === 'mbta'));
  assert.ok((await (await service.handle(request('/api/transit/feeds'))).json()).feeds.some((feed) => feed.id === 'mta-nyc'));
  assert.equal(calls, 0);
  service.close();
  assert.equal(
    (await service.handle(request('/api/transit/feeds'))).status,
    503,
  );
});

test('MTA Bus Time API key is appended server-side and never exposed in the catalog', () => {
  const feed = getTransitFeed('mta-nyc');
  const url = new URL(resolveTransitFeedUrl(feed, 'test-secret'));
  assert.equal(url.origin, 'https://gtfsrt.prod.obanyc.com');
  assert.equal(url.pathname, '/vehiclePositions');
  assert.equal(url.searchParams.get('key'), 'test-secret');
  assert.throws(() => resolveTransitFeedUrl(feed, ''), /MTA_BUS_API_KEY is required/);
  const catalogEntry = publicTransitCatalog().find(({ id }) => id === 'mta-nyc');
  assert.ok(catalogEntry);
  assert.equal('url' in catalogEntry, false);
  assert.equal(JSON.stringify(catalogEntry).includes('test-secret'), false);
});

test('MTA service request uses the resolved key without returning it to clients', async (t) => {
  let requestedUrl = null;
  t.mock.method(console, 'warn', () => {});
  const service = createTransitService({
    resolveFeedUrl: (feed) => resolveTransitFeedUrl(feed, 'service-secret'),
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return new Response('unauthorized', { status: 401 });
    },
  });
  t.after(service.close);

  const response = await service.handle(request('/api/transit/vehicles/mta-nyc'));
  const responseText = await response.text();
  assert.equal(response.status, 502);
  assert.equal(
    new URL(requestedUrl).searchParams.get('key'),
    'service-secret',
  );
  assert.equal(responseText.includes('service-secret'), false);
});

test('MBTA route details return route-filtered predictions and alerts and cache briefly', async (t) => {
  const calls = [];
  const arrivalTime = new Date(Date.now() + 300_000).toISOString();
  const service = createTransitService({
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      calls.push(parsed);
      assert.equal(parsed.origin, 'https://api-v3.mbta.com');
      assert.equal(parsed.searchParams.get('filter[route]'), 'Red');
      if (parsed.pathname === '/predictions')
        return Response.json({
          data: [
            {
              id: 'prediction-red',
              attributes: { arrival_time: arrivalTime, trip_headsign: 'Alewife' },
              relationships: {
                route: { data: { id: 'Red' } },
                stop: { data: { id: '70073' } },
              },
            },
            {
              id: 'prediction-orange',
              attributes: { arrival_time: arrivalTime },
              relationships: { route: { data: { id: 'Orange' } } },
            },
          ],
          included: [
            { type: 'stop', id: '70073', attributes: { name: 'Harvard' } },
          ],
        });
      return Response.json({
        data: [
          {
            id: 'alert-red',
            attributes: {
              header: 'Red Line delays',
              effect: 'DELAY',
              severity: 4,
              informed_entity: [{ route: 'Red' }],
            },
          },
          {
            id: 'alert-orange',
            attributes: {
              header: 'Orange Line alert',
              informed_entity: [{ route: 'Orange' }],
            },
          },
        ],
      });
    },
  });
  t.after(service.close);

  const path = '/api/transit/route-details/mbta/Red';
  const first = await service.handle(request(path));
  assert.equal(first.status, 200);
  const details = await first.json();
  assert.equal(details.feedId, 'mbta');
  assert.equal(details.routeId, 'Red');
  assert.equal(details.predictions.length, 1);
  assert.equal(details.predictions[0].stopName, 'Harvard');
  assert.equal(details.predictions[0].arrivalTime, arrivalTime);
  assert.equal(details.alerts.length, 1);
  assert.equal(details.alerts[0].header, 'Red Line delays');
  assert.equal(calls.length, 2);

  const cached = await service.handle(request(path));
  assert.equal(cached.headers.get('x-route-data-cache'), 'HIT');
  assert.equal(calls.length, 2);
});

test('source sends snapshots and bounded history through the supplied transport', async () => {
  const calls = [];
  const controller = new AbortController();
  const payload = {
    version: 1,
    feedId: 'mbta',
    vehicleId: 'bus 1',
    fixes: [],
    epochs: [],
  };
  const source = createTransitSource({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return Response.json(url.includes('/trail/') ? payload : { count: 0 });
    },
  });
  assert.deepEqual(
    await (
      await source.requestSnapshot('mbta', { signal: controller.signal })
    ).json(),
    { count: 0 },
  );
  assert.deepEqual(
    await source.getHistory('mbta', 'bus 1', { signal: controller.signal }),
    payload,
  );
  assert.deepEqual(
    calls.map(({ url }) => url),
    ['/api/transit/vehicles/mbta', '/api/transit/trail/mbta/bus%201'],
  );
  assert.ok(calls.every(({ init }) => init.signal === controller.signal));
  controller.abort();
  assert.throws(
    () => source.requestSnapshot('mbta', { signal: controller.signal }),
    { name: 'AbortError' },
  );
  assert.throws(
    () => source.getHistory('mbta', 'bus 1', { signal: controller.signal }),
    { name: 'AbortError' },
  );
  assert.equal(calls.length, 2);
});

test('source requests validated MBTA route details through the same-origin proxy', async () => {
  const calls = [];
  const source = createTransitSource({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return Response.json({
        feedId: 'mbta',
        routeId: 'Red',
        fetchedAt: 123,
        predictions: [],
        alerts: [],
      });
    },
  });
  const response = await source.requestRouteDetails('mbta', 'Red');
  assert.deepEqual(await response.json(), {
    feedId: 'mbta',
    routeId: 'Red',
    fetchedAt: 123,
    predictions: [],
    alerts: [],
  });
  assert.equal(calls[0].url, '/api/transit/route-details/mbta/Red');
  assert.equal(calls[0].init.headers.Accept, 'application/json');
  assert.throws(
    () => source.requestRouteDetails('mta-nyc', 'M15'),
    /registered MBTA route id/,
  );
});

test('source retains history validation and never retries through another transport', async () => {
  let calls = 0;
  const source = createTransitSource({
    fetchImpl: async () => {
      calls++;
      return Response.json({
        version: 1,
        feedId: 'wrong',
        vehicleId: 'bus',
        fixes: [],
        epochs: [],
      });
    },
  });
  await assert.rejects(
    source.getHistory('mbta', 'bus'),
    /Invalid transit history response/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    source.getHistory('mbta', '../bus'),
    /Invalid transit vehicle identifier/,
  );
  assert.equal(calls, 1);
});

test('snapshot cancellation covers headers and body parsing', async () => {
  for (const phase of ['headers', 'body']) {
    const controller = new AbortController();
    const source = createTransitSource({
      fetchImpl: async () => {
        if (phase === 'headers') controller.abort();
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => {
            controller.abort();
            return { vehicles: [] };
          },
        };
      },
    });
    await assert.rejects(
      async () => {
        const response = await source.requestSnapshot('mbta', {
          signal: controller.signal,
        });
        await response.json();
      },
      { name: 'AbortError' },
    );
  }
});
