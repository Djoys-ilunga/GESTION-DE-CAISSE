import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
require('dotenv').config({ path: new URL('../.env', import.meta.url), quiet: true });
const { Client } = require('pg');
const url = new URL(process.env.DATABASE_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  throw new Error('PostgreSQL local obligatoire.');
const name = `caissepro_test_${randomBytes(8).toString('hex')}`;
const admin = new Client({ connectionString: url.toString() });
await admin.connect();
let server, checks, restricted;
const loginRole = `caissepro_test_api_${randomBytes(8).toString('hex')}`;
let roleCreated = false;
const directory = mkdtempSync(join(tmpdir(), 'caissepro-contract-'));
const run = (program, args, options = {}) => {
  const result = spawnSync(program, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 180000,
    ...options,
  });
  const failureCode =
    result.stderr?.match(/CAISSEPRO_AUTH_CONTRACT_(?:FAILED:[A-Z_]+|PANIC_LINE_[0-9]+)/)?.[0] ?? '';
  if (result.status !== 0)
    throw new Error(
      'Contrôle de contrat refusé. Vérifier compilation, migrations et disponibilité des outils. ' +
        failureCode,
    );
  return result;
};
try {
  run('cargo', [
    'build',
    '--locked',
    '--manifest-path',
    'packages/session-core/Cargo.toml',
    '--example',
    'api_contract',
  ]);
  await admin.query(`CREATE DATABASE "${name}"`);
  url.pathname = `/${name}`;
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  const env = {
    ...process.env,
    DATABASE_URL: url.toString(),
    API_HOST: '127.0.0.1',
    API_PORT: String(port),
    API_DEPLOYMENT_ID: 'caissepro-auth-contract',
    AUTH_RATE_LIMIT_SECRET: randomBytes(32).toString('hex'),
  };
  run('pnpm', ['--filter', '@caissepro/api', 'db:deploy'], {
    env,
    shell: process.platform === 'win32',
  });
  const companyCode = 'CONTRACT-' + randomBytes(4).toString('hex').toUpperCase(),
    email = `${randomUUID()}@example.test`,
    password = randomBytes(24).toString('base64url'),
    renewedPassword = randomBytes(24).toString('base64url');
  const config = join(directory, 'initialisation.json');
  writeFileSync(
    config,
    JSON.stringify({
      companyCode,
      companyName: 'Entreprise synthétique',
      adminEmail: email,
      adminName: 'Administrateur synthétique',
    }),
    { mode: 0o600 },
  );
  run(process.execPath, ['scripts/bootstrap-admin.mjs', '--config', config, '--password-stdin'], {
    env,
    input: password + '\n',
  });
  // Compte d'exécution réel, sans héritage ni contournement RLS.
  const databasePassword = randomBytes(32).toString('hex');
  await admin.query(
    `CREATE ROLE "${loginRole}" LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${databasePassword}'`,
  );
  roleCreated = true;
  await admin.query(`GRANT caissepro_runtime, caissepro_auth_runtime TO "${loginRole}"`);
  const apiUrl = new URL(url);
  apiUrl.username = loginRole;
  apiUrl.password = databasePassword;
  restricted = new Client({ connectionString: apiUrl.toString() });
  await restricted.connect();
  const flags = (
    await restricted.query(
      'SELECT rolsuper,rolbypassrls,rolinherit,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user',
    )
  ).rows[0];
  assert.ok(Object.values(flags).every((flag) => flag === false));
  await assert.rejects(
    restricted.query('SELECT "passwordHash" FROM "UserCredential"'),
    (error) => error.code === '42501',
  );
  server = spawn(process.execPath, ['apps/api/dist/main.js'], {
    cwd: root,
    env: { ...env, DATABASE_URL: apiUrl.toString() },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) break;
    try {
      const response = await fetch(base + '/api/v1/health/ready', {
        signal: AbortSignal.timeout(500),
      });
      ready = response.ok;
    } catch {
      /* démarrage borné */
    }
    if (ready) break;
    await delay(100);
  }
  assert.ok(ready, 'Disponibilité réelle requise.');
  const binary = join(
    root,
    'packages/session-core/target/debug/examples/api_contract' +
      (process.platform === 'win32' ? '.exe' : ''),
  );
  const result = run(binary, [], {
    input: JSON.stringify({
      base,
      deployment: env.API_DEPLOYMENT_ID,
      companyCode,
      email,
      password,
      renewedPassword,
    }),
  });
  assert.match(result.stdout, /CAISSEPRO_AUTH_CONTRACT_PASSED/);
  assert.ok(!result.stdout.includes(password) && !result.stderr.includes(password));
  checks = new Client({ connectionString: url.toString() });
  await checks.connect();
  assert.equal(
    (await checks.query('SELECT count(*)::int AS n FROM "FinancialOperation"')).rows[0].n,
    4,
  );
  assert.equal((await checks.query('SELECT count(*)::int AS n FROM "LedgerEntry"')).rows[0].n, 10);
  assert.equal((await checks.query('SELECT count(*)::int AS n FROM "ImportedDraft"')).rows[0].n, 2);
  assert.equal((await checks.query('SELECT count(*)::int AS n FROM "CashReceipt"')).rows[0].n, 1);
  assert.equal(
    (await checks.query('SELECT count(*)::int AS n FROM "ExpenseRequest" WHERE state=\'PAID\''))
      .rows[0].n,
    1,
  );
  assert.equal(
    (await checks.query('SELECT count(*)::int AS n FROM "PaymentVoucher"')).rows[0].n,
    1,
  );
  assert.equal(
    (await checks.query('SELECT count(*)::int AS n FROM "ExpenseEvidence"')).rows[0].n,
    1,
  );
  assert.equal(
    (await checks.query('SELECT count(*)::int AS n FROM "TransferOrder" WHERE state=\'RECEIVED\''))
      .rows[0].n,
    2,
  );
  for (const kind of ['TRANSFER', 'FX'])
    assert.equal(
      (
        await checks.query('SELECT count(*)::int AS n FROM "FinancialOperation" WHERE kind=$1', [
          kind,
        ])
      ).rows[0].n,
      1,
    );
  console.info(
    '1 parcours Rust → API réelle → PostgreSQL réussi avec LOGIN restreint NOINHERIT/NOBYPASSRLS : authentification, brouillon transmis sans solde modifié, confirmation explicite unique, reçu numéroté, historique, soumission de dépense distincte, approbation par un directeur, réservation sans paiement, paiement explicite unique, bon de sortie, verrouillage et révocation. Rapports serveur, PDF et Excel vérifiés par le courtier natif. Transfert USD et conversion USD/CDF avec remise, réception distincte, bordereaux et rejeu idempotent réussis. SQL final : 4 opérations, 10 écritures, 1 reçu, 1 dépense payée, 1 bon, 2 brouillons de recette/dépense et 2 transferts reçus.',
  );
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = once(server, 'exit');
    server.kill('SIGTERM');
    if (!(await Promise.race([exited.then(() => true), delay(5000, false, { ref: false })])))
      server.kill('SIGKILL');
    await exited;
  }
  await checks?.end();
  await restricted?.end();
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  if (roleCreated) await admin.query(`DROP ROLE "${loginRole}"`);
  await admin.end();
  rmSync(directory, { recursive: true, force: true });
}
