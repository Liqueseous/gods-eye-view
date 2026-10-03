const MTA_STATIONS_URL =
  'https://data.ny.gov/resource/39hk-dx4f.json?$limit=3000';
export const MTA_STATIONS_MAX_BYTES = 2 * 1024 * 1024;
export const MTA_STATIONS_MAX_RECORDS = 3000;

/** Fetch the fixed official station dataset; callers own caching and coalescing. */
export async function fetchMtaStationCoordinates(fetchImpl, signal) {
  const response = await fetchImpl(MTA_STATIONS_URL, {
    signal,
    headers: { Accept: 'application/json' },
    redirect: 'error',
  });
  if (!response.ok)
    throw new Error(`MTA station dataset returned HTTP ${response.status}`);
  const reader = response.body?.getReader?.();
  let bytes = 0;
  let text = '';
  if (reader) {
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MTA_STATIONS_MAX_BYTES)
        throw new Error('MTA station dataset is too large');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } else {
    text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MTA_STATIONS_MAX_BYTES)
      throw new Error('MTA station dataset is too large');
  }
  const rows = JSON.parse(text);
  if (!Array.isArray(rows))
    throw new Error('MTA station dataset is not an array');
  const coordinates = new Map();
  for (const row of rows.slice(0, MTA_STATIONS_MAX_RECORDS)) {
    const id = String(row?.gtfs_stop_id || '').trim();
    const lat = Number(row?.gtfs_latitude);
    const lon = Number(row?.gtfs_longitude);
    if (
      id &&
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      Math.abs(lat) <= 90 &&
      Math.abs(lon) <= 180
    )
      coordinates.set(id, { lat, lon });
  }
  return coordinates;
}
