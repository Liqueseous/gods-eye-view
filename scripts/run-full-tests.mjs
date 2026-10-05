#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VITE_CLI = 'node_modules/vite/bin/vite.js';

function runNode(label, args) {
  console.log(`\n[full-test] ${label}`);
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(`[full-test] ${label} failed to start: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

async function findAvailablePort() {
  const listener = createNetServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const { port } = listener.address();
  await new Promise((resolve, reject) => {
    listener.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function waitForServer(server, url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Vite exited before becoming ready (code ${server.exitCode})`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // Vite is still starting; retry until the bounded startup deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Vite did not become ready within 30 seconds');
}

async function runTrackingRegression() {
  const port = await findAvailablePort();
  const url = `http://127.0.0.1:${port}`;
  console.log('\n[full-test] Tracking regression (temporary Vite server)');
  const server = spawn(
    process.execPath,
    [VITE_CLI, '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { cwd: ROOT, env: process.env, stdio: 'inherit' },
  );

  try {
    await waitForServer(server, url);
    return runNode('Headless tracking invariants', [
      'scripts/track-regression.mjs',
      '--url',
      url,
    ]);
  } catch (error) {
    console.error(`[full-test] Tracking regression could not run: ${error.message}`);
    return 1;
  } finally {
    if (server.exitCode === null) {
      const exited = new Promise((resolve) => server.once('exit', resolve));
      server.kill();
      await exited;
    }
  }
}

async function main() {
  let failed = false;
  const stages = [
    ['All source and server unit tests', ['scripts/run-unit-tests.mjs']],
    ['Production build', [VITE_CLI, 'build']],
  ];

  for (const [label, args] of stages) {
    const status = runNode(label, args);
    if (status !== 0) failed = true;
  }

  if ((await runTrackingRegression()) !== 0) failed = true;
  if (failed) console.error('\n[full-test] One or more stages failed.');
  else console.log('\n[full-test] All stages passed.');
  return failed ? 1 : 0;
}

process.exitCode = await main();