import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function unusedPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
function startApi(port, overrides = {}) {
  return spawn(process.execPath, ['apps/api/dist/main.js'], {
    cwd: root,
    env: {
      ...process.env,
      API_HOST: '127.0.0.1',
      API_PORT: String(port),
      API_DEPLOYMENT_ID: 'caissepro-live-smoke',
      CORS_ORIGINS: 'http://127.0.0.1:1420',
      ...overrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
async function stopApi(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const completed = await Promise.race([
    exited.then(() => true),
    delay(5000, undefined, { ref: false }).then(() => false),
  ]);
  if (!completed) child.kill('SIGKILL');
  await exited;
}
test(
  'API compilée : PostgreSQL réel, disponibilité, CORS et fermeture',
  { timeout: 30000 },
  async () => {
    const port = await unusedPort(),
      child = startApi(port),
      url = `http://127.0.0.1:${port}/api/v1/health/ready`;
    try {
      let response;
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) assert.fail('L’API ne démarre pas avec PostgreSQL.');
        try {
          response = await fetch(url, {
            signal: AbortSignal.timeout(1000),
            headers: { Origin: 'http://127.0.0.1:1420' },
          });
          break;
        } catch {
          await delay(100);
        }
      }
      assert.ok(response, 'L’API doit répondre avant le délai.');
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('access-control-allow-origin'), 'http://127.0.0.1:1420');
      assert.deepEqual(await response.json(), {
        service: 'caissepro-api',
        protocolVersion: 2,
        deploymentId: 'caissepro-live-smoke',
        status: 'ready',
      });
      const payment = await fetch(`http://127.0.0.1:${port}/api/v1/payments`, {
        method: 'POST',
        signal: AbortSignal.timeout(1000),
      });
      assert.equal(
        payment.status,
        404,
        'Aucune route financière non authentifiée ne doit être exposée.',
      );
    } finally {
      await stopApi(child);
    }
    await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1000) }));
  },
);
test('API compilée : échec fermé si PostgreSQL est inaccessible', { timeout: 15000 }, async () => {
  const port = await unusedPort();
  const child = startApi(port, { DATABASE_URL: 'postgresql://unconfigured@127.0.0.1:1/caissepro' });
  let errors = '';
  child.stderr.on('data', (chunk) => {
    errors += chunk.toString();
  });
  try {
    const [code] = await once(child, 'exit', { signal: AbortSignal.timeout(10000) });
    assert.notEqual(code, 0);
    assert.match(errors, /Démarrage impossible/);
    assert.ok(
      !errors.includes('postgresql://'),
      'Les erreurs ne doivent pas révéler la configuration.',
    );
    await assert.rejects(
      fetch(`http://127.0.0.1:${port}/api/v1/health/ready`, { signal: AbortSignal.timeout(1000) }),
    );
  } finally {
    await stopApi(child);
  }
});
