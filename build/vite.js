import packageManifest from '../package.json' with { type: 'json' };
import { applicationHtmlPlugin } from './application-html.js';
import cesium from 'vite-plugin-cesium';

function buildMetadata() {
  return {
    version: process.env.GEV_VERSION || packageManifest.version,
    sourceVersion:
      process.env.GEV_SOURCE_VERSION ||
      packageManifest.sourceVersion ||
      packageManifest.version,
    sourceCommit:
      process.env.GEV_SOURCE_COMMIT ||
      packageManifest.sourceCommit ||
      'unknown',
    buildNumber:
      process.env.GEV_BUILD_NUMBER ||
      process.env.BUILD_NUMBER ||
      process.env.GITHUB_RUN_NUMBER ||
      'dev',
  };
}

/** Build browser assets with explicit inputs; never load environment or providers. */
export function createBrowserViteConfig({
  plugins = [],
  publicDir,
  googleApiKey,
  cesiumToken,
  host = 'localhost',
  port = 4173,
  command,
} = {}) {
  const metadata = buildMetadata();
  return {
    plugins: [cesium(), applicationHtmlPlugin(), ...plugins],
    ...(publicDir === undefined ? {} : { publicDir }),
    // A production build must not clean the dependency cache a running dev
    // server is still serving optimized module URLs from.
    ...(command === 'build' ? { cacheDir: 'node_modules/.vite-build' } : {}),
    optimizeDeps: {
      // First reached through the SDR worker or a dynamic import. Pre-bundle
      // them at startup so first use cannot invalidate already-transformed
      // URLs with Vite's "Outdated Optimize Dep" 504 response.
      include: [
        '@jtarrio/signals/demod/demodulator.js',
        '@jtarrio/signals/demod/modes.js',
        '@jtarrio/webrtlsdr/rtlsdr.js',
        'egm96-universal',
      ],
    },
    server: {
      host: host || 'localhost',
      port: parseInt(port, 10) || 4173,
      allowedHosts:
        host === '0.0.0.0' || host === '::'
          ? true
          : ['localhost', '127.0.0.1', '.local'],
      fs: {
        deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/ENVIRONMENT'],
      },
      // These headers protect the document containing Provider Settings.
      headers: {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "frame-ancestors 'none'",
      },
    },
    // `vite preview` reads its own host/port; it does not inherit `server.port`.
    // Explicit so a container's HOST/PORT env still binds correctly in preview.
    preview: {
      host: host || 'localhost',
      port: parseInt(port, 10) || 4173,
      strictPort: true,
      allowedHosts:
        host === '0.0.0.0' || host === '::'
          ? true
          : ['localhost', '127.0.0.1', '.local'],
      headers: {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "frame-ancestors 'none'",
      },
    },
    define: {
      'import.meta.env.GOOGLE_MAPS_API_KEY': JSON.stringify(googleApiKey),
      'import.meta.env.CESIUM_ION_TOKEN': JSON.stringify(cesiumToken),
      'import.meta.env.GEV_VERSION': JSON.stringify(metadata.version),
      'import.meta.env.GEV_BUILD_NUMBER': JSON.stringify(metadata.buildNumber),
      'import.meta.env.GEV_SOURCE_VERSION': JSON.stringify(
        metadata.sourceVersion,
      ),
      'import.meta.env.GEV_SOURCE_COMMIT': JSON.stringify(
        metadata.sourceCommit,
      ),
    },
    build: { chunkSizeWarningLimit: 1500 },
  };
}
