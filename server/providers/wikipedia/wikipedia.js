/**
 * Wikipedia integration for landmark information lookup.
 * Provides extract summaries and basic metadata for landmarks not in CITY_POIS.
 * 
 * @module server/providers/wikipedia
 */

const WIKIPEDIA_API_BASE = 'https://en.wikipedia.org/api/rest_v1';
const USER_AGENT = 'GodsEyeView/1.0 (geospatial application)';

/**
 * In-memory cache for Wikipedia lookups (session-scoped).
 * Key: normalized landmark name, Value: { extract, url, timestamp }
 */
const wikiCache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60; // 1 hour

/**
 * Fetch Wikipedia summary for a landmark or place.
 * @param {string} name - Landmark name
 * @param {object} options
 * @param {Function} options.fetchImpl - Fetch implementation (for testing)
 * @returns {Promise<{ok: boolean, extract?: string, url?: string, error?: string}>}
 */
export async function fetchWikipediaSummary(name, { fetchImpl = fetch } = {}) {
  if (!name || typeof name !== 'string') {
    return { ok: false, error: 'Invalid landmark name' };
  }

  const normalized = name.trim().toLowerCase();
  const cached = wikiCache.get(normalized);
  const now = Date.now();

  // Return cached result if still valid
  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    return { ok: true, extract: cached.extract, url: cached.url, cached: true };
  }

  try {
    // Wikipedia REST API page summary endpoint
    const encodedTitle = encodeURIComponent(name.trim());
    const url = `${WIKIPEDIA_API_BASE}/page/summary/${encodedTitle}`;

    const response = await fetchImpl(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      // 404 means article not found, not an error
      if (response.status === 404) {
        return { ok: false, error: 'not_found' };
      }
      return { ok: false, error: `HTTP ${response.status}` };
    }

    const data = await response.json();

    // Extract relevant information
    const result = {
      ok: true,
      extract: data.extract || '',
      url: data.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodedTitle}`,
      description: data.description || '',
      thumbnail: data.thumbnail?.source,
    };

    // Cache the result
    wikiCache.set(normalized, {
      extract: result.extract,
      url: result.url,
      description: result.description,
      timestamp: now,
    });

    return result;
  } catch (error) {
    return { ok: false, error: error.message || 'Network error' };
  }
}

/**
 * Get landmark information with fallback to Wikipedia.
 * @param {string} name - Landmark name
 * @param {object} staticInfo - Static landmark data from CITY_POIS (if available)
 * @param {object} options
 * @returns {Promise<object>}
 */
export async function getLandmarkInfo(name, staticInfo = null, options = {}) {
  // If we have static info, use it
  if (staticInfo?.description || staticInfo?.history) {
    return {
      ok: true,
      name,
      source: 'static',
      description: staticInfo.description || '',
      history: staticInfo.history || '',
      yearBuilt: staticInfo.yearBuilt,
      architect: staticInfo.architect,
      style: staticInfo.style,
    };
  }

  // Fallback to Wikipedia
  const wiki = await fetchWikipediaSummary(name, options);
  if (!wiki.ok) {
    return {
      ok: false,
      error: wiki.error === 'not_found' 
        ? 'No information available for this landmark'
        : 'Unable to fetch landmark information',
    };
  }

  return {
    ok: true,
    name,
    source: 'wikipedia',
    description: wiki.description || '',
    extract: wiki.extract,
    url: wiki.url,
    thumbnail: wiki.thumbnail,
  };
}

/**
 * Clear the Wikipedia cache (for testing or memory management).
 */
export function clearWikipediaCache() {
  wikiCache.clear();
}

/**
 * Install Wikipedia API routes.
 */
export function wikipediaProxy({ fetchImpl = fetch } = {}) {
  function install(middlewares) {
    middlewares.use('/api/wikipedia/summary', async (req, res) => {
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
        return;
      }

      const requestUrl = new URL(req.url || '', 'http://localhost');
      const name = requestUrl.searchParams.get('name');

      if (!name) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: false, error: 'name parameter is required' }));
        return;
      }

      const result = await fetchWikipediaSummary(name, { fetchImpl });

      res.statusCode = result.ok ? 200 : (result.error === 'not_found' ? 404 : 500);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.end(JSON.stringify(result));
    });
  }

  return { install };
}
