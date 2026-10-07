import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadMass511SourcesFromOpenData } from '../../server/providers/cctv/sources.js';
import {
  MASS511_CAMERAS_URL,
  MASS511_IMAGE_ORIGIN,
} from '../../server/providers/cctv/constants.js';

const camera = (overrides = {}) => ({
  Id: 'ma-1',
  Latitude: 42.3601,
  Longitude: -71.0589,
  Location: 'Boston',
  Roadway: 'I-93',
  Direction: 'North',
  Views: [
    {
      Status: 'Enabled',
      Url: 'https://mass511.com/map/Cctv/ma-1',
      Description: 'I-93 northbound',
    },
  ],
  ...overrides,
});

test('Massachusetts 511 loader requires an API key and maps enabled views', async (t) => {
  const saved = process.env.MASS511_API_KEY;
  process.env.MASS511_API_KEY = 'test-key';
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return Response.json([camera()]);
  });
  try {
    const [source] = await loadMass511SourcesFromOpenData();
    assert.equal(requested[0], `${MASS511_CAMERAS_URL}&key=test-key`);
    assert.equal(source.id, 'mass511-ma-1');
    assert.equal(source.cityId, 'massachusetts');
    assert.equal(source.provider, 'Massachusetts 511');
    assert.equal(source.headingDeg, 0);
    assert.equal(source.url, `${MASS511_IMAGE_ORIGIN}ma-1`);
  } finally {
    if (saved === undefined) delete process.env.MASS511_API_KEY;
    else process.env.MASS511_API_KEY = saved;
  }
});

test('Massachusetts 511 loader rejects invalid rows and off-host frames', async (t) => {
  const saved = process.env.MASS511_API_KEY;
  process.env.MASS511_API_KEY = 'test-key';
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json([
      camera({ Id: 'off-state', Latitude: 40.9 }),
      camera({
        Id: 'evil',
        Views: [{ Status: 'Enabled', Url: 'https://evil.example/cam' }],
      }),
      camera({
        Id: 'down',
        Views: [
          {
            Status: 'Enabled',
            Url: 'https://mass511.com/map/Cctv/down',
            Description: 'Camera down',
          },
        ],
      }),
    ]),
  );
  try {
    assert.deepEqual(await loadMass511SourcesFromOpenData(), []);
  } finally {
    if (saved === undefined) delete process.env.MASS511_API_KEY;
    else process.env.MASS511_API_KEY = saved;
  }
});
