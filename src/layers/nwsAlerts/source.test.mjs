import test from 'node:test';
import assert from 'node:assert/strict';
import { createNwsAlertsSource } from './source.js';
import { normalizeNwsAlertSnapshot } from './records.js';
import { nwsAlertsProxy } from '../../../server/providers/nwsAlerts.js';

const ring = [
  [-97.9, 30.2],
  [-97.8, 30.2],
  [-97.8, 30.3],
  [-97.9, 30.2],
];
const validPayload = {
  features: [
    {
      id: 'urn:oid:test.1',
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: {
        status: 'Actual',
        event: 'Flash Flood Warning',
        severity: 'Severe',
      },
    },
  ],
};

function installHandler(plugin) {
  let handler;
  plugin.configureServer({
    middlewares: {
      use: (_path, callback) => {
        handler = callback;
      },
    },
  });
  return handler;
}

function responseCapture() {
  let status;
  let headers;
  let payload;
  return {
    response: {
      writeHead(nextStatus, nextHeaders) {
        status = nextStatus;
        headers = nextHeaders;
      },
      end(body) {
        payload = JSON.parse(body);
      },
    },
    read() {
      return { status, headers, payload };
    },
  };
}

test('a successful response yields normalized alert rows', async () => {
  let requested;
  const source = createNwsAlertsSource({
    fetchImpl: async (url) => {
      requested = String(url);
      return Response.json({
        rows: normalizeNwsAlertSnapshot(validPayload),
      });
    },
  });
  const rows = await source.getSnapshot();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stableId, 'urn:oid:test.1');
  assert.equal(requested, '/api/nws-alerts');
});

test('an upstream HTTP error is surfaced', async () => {
  const source = createNwsAlertsSource({
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  await assert.rejects(source.getSnapshot(), /NWS alerts HTTP 503/);
});

test('a malformed successful response is rejected', async () => {
  for (const payload of [{}, { rows: null }, { rows: {} }]) {
    const source = createNwsAlertsSource({
      fetchImpl: async () => Response.json(payload),
    });
    await assert.rejects(source.getSnapshot(), /Malformed NWS alerts snapshot/);
  }
});

test('response-body cancellation aborts the source request', async () => {
  const abort = new AbortController();
  const source = createNwsAlertsSource({
    fetchImpl: async () => ({
      ok: true,
      headers: new Headers(),
      text: async () => {
        abort.abort();
        return JSON.stringify({
          rows: normalizeNwsAlertSnapshot(validPayload),
        });
      },
    }),
  });
  await assert.rejects(source.getSnapshot({ signal: abort.signal }), {
    name: 'AbortError',
  });
});

test('the proxy caches concurrent and sequential requests', async () => {
  let calls = 0;
  const handler = installHandler(
    nwsAlertsProxy({
      fetchImpl: async () => {
        calls++;
        return Response.json(validPayload);
      },
    }),
  );
  const first = responseCapture();
  const second = responseCapture();
  await Promise.all([
    handler({ url: '/', method: 'GET' }, first.response),
    handler({ url: '/', method: 'GET' }, second.response),
  ]);
  assert.equal(first.read().status, 200);
  assert.equal(second.read().status, 200);
  assert.equal(calls, 1);

  const third = responseCapture();
  await handler({ url: '/', method: 'GET' }, third.response);
  assert.equal(third.read().status, 200);
  assert.equal(calls, 1);
});

test('the proxy serves a stale snapshot after an upstream failure', async () => {
  let nowMs = 0;
  let calls = 0;
  const handler = installHandler(
    nwsAlertsProxy({
      now: () => nowMs,
      fetchImpl: async () => {
        calls++;
        if (calls > 1) throw new Error('network down');
        return Response.json(validPayload);
      },
    }),
  );
  const first = responseCapture();
  await handler({ url: '/', method: 'GET' }, first.response);
  nowMs = 120_001;
  const second = responseCapture();
  await handler({ url: '/', method: 'GET' }, second.response);
  assert.equal(second.read().status, 200);
  assert.equal(second.read().headers['X-Data-Stale'], 'true');
  assert.equal(second.read().payload.stale, true);
  assert.equal(calls, 2);
});

test('the proxy rejects unsupported methods and routes', async () => {
  const handler = installHandler(
    nwsAlertsProxy({ fetchImpl: async () => Response.json(validPayload) }),
  );
  const method = responseCapture();
  await handler({ url: '/', method: 'POST' }, method.response);
  assert.equal(method.read().status, 405);
  assert.equal(method.read().headers.Allow, 'GET');

  const route = responseCapture();
  await handler({ url: '/other', method: 'GET' }, route.response);
  assert.equal(route.read().status, 404);
});
