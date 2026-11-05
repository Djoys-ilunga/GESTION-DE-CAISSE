import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
require('dotenv').config({ path: new URL('../.env', import.meta.url), quiet: true });
const { Client } = require('pg');
const url = new URL(process.env.DATABASE_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  throw new Error('Les tests exigent un PostgreSQL local.');
const name = `caissepro_test_${randomBytes(8).toString('hex')}`;
const admin = new Client({ connectionString: url.toString() });
await admin.connect();
try {
  await admin.query(`CREATE DATABASE "${name}"`);
  url.pathname = `/${name}`;
  const env = {
    ...process.env,
    DATABASE_URL: url.toString(),
    CAISSEPRO_INTEGRITY_TEST: '1',
    AUTH_RATE_LIMIT_SECRET: randomBytes(32).toString('hex'),
  };
  for (const args of [
    ['--filter', '@caissepro/api', 'db:deploy'],
    ['--filter', '@caissepro/api', 'test:integration'],
  ]) {
    const result = spawnSync('pnpm', args, {
      cwd: root,
      env,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }
} finally {
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.end();
}
