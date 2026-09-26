import { createTransitService } from '../../src/sources/transitService.js';
export { fetchTransitFeed } from '../../src/sources/transitService.js';

export function resolveTransitFeedUrl(
  feed,
  mtaBusApiKey = process.env.MTA_BUS_API_KEY,
) {
  if (feed?.id !== 'mta-nyc') return feed?.url || null;
  const key = String(mtaBusApiKey || '').trim();
  if (!key) throw new Error('MTA_BUS_API_KEY is required for NYC bus positions');
  const url = new URL(feed.url);
  url.searchParams.set('key', key);
  return url.toString();
}

/** Connect the reusable transit request service to development and preview. */
export function transitProxy(options = {}) {
  const service = createTransitService({
    ...options,
    resolveFeedUrl: options.resolveFeedUrl || resolveTransitFeedUrl,
  });
  function install(server) {
    server.middlewares.use('/api/transit', async (req, res) => {
      const response = await service.handle({
        url: `http://localhost/api/transit${req.url || '/'}`,
        method: req.method,
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    });
    server.httpServer?.once('close', service.close);
  }
  return {
    name: 'transit-proxy',
    closeBundle: service.close,
    configureServer: install,
    configurePreviewServer: install,
  };
}
