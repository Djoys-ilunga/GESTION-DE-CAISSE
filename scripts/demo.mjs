// Synthetic demo only. No reset, production connection or default password.
import { createRequire } from 'node:module';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
require('dotenv').config({ path: join(root, '.env'), quiet: true });
const { Client } = require('pg');
const directory = fileURLToPath(new URL('../../scratch/caissepro-demo/', import.meta.url));
mkdirSync(directory, { recursive: true, mode: 0o700 });
const stateFile = join(directory, 'state.json');
function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...options });
  if (r.status !== 0) throw new Error('DEMO_COMMAND_FAILED');
}
function save(data) {
  writeFileSync(stateFile, JSON.stringify(data), { mode: 0o600 });
}
function read() {
  const s = JSON.parse(readFileSync(stateFile, 'utf8'));
  const u = new URL(s.url);
  assert.match(u.pathname, /^\/caissepro_demo_[a-f0-9]+$/);
  assert.equal(u.hostname, '127.0.0.1');
  return s;
}
async function secureRuntime(s) {
  if (s.runtimeUrl) return;
  const db = new Client({ connectionString: s.url });
  await db.connect();
  try {
    const role = 'caissepro_demo_api_' + randomBytes(8).toString('hex'),
      password = randomBytes(32).toString('hex');
    await db.query(
      `CREATE ROLE "${role}" LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${password}'`,
    );
    await db.query(`GRANT caissepro_runtime,caissepro_auth_runtime TO "${role}"`);
    const u = new URL(s.url);
    u.username = role;
    u.password = password;
    s.runtimeUrl = u.toString();
    save(s);
  } finally {
    await db.end();
  }
}
const action = process.argv[2];
if (action === 'prepare') {
  if (existsSync(stateFile)) {
    const s = read();
    assert.equal(
      s.ready,
      true,
      'Une préparation interrompue existe : diagnostiquer sans supprimer les données.',
    );
    const schemaCheck = new Client({ connectionString: s.url });
    let pending;
    try {
      await schemaCheck.connect();
      const applied = (
        await schemaCheck.query(
          'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
        )
      ).rows.map((r) => r.migration_name);
      pending = readdirSync(join(root, 'apps/api/prisma/migrations')).filter(
        (n) => /^\d/.test(n) && !applied.includes(n),
      );
    } finally {
      await schemaCheck.end();
    }
    if (pending.length) run(process.execPath, ['scripts/demo-database-backup.mjs']);
    run('pnpm', ['--filter', '@caissepro/api', 'db:deploy'], {
      env: { ...process.env, DATABASE_URL: s.url },
    });
    await secureRuntime(s);
    console.info('Démonstration existante conservée ; migrations mises à jour.');
    process.exit(0);
  }
  const adminUrl = new URL(process.env.DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost'].includes(adminUrl.hostname));
  const name = 'caissepro_demo_' + randomBytes(8).toString('hex');
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  adminUrl.hostname = '127.0.0.1';
  adminUrl.pathname = '/' + name;
  const s = {
    name,
    url: adminUrl.toString(),
    ready: false,
    port: 3001,
    createdAt: new Date().toISOString(),
  };
  save(s);
  const demoEnv = { ...process.env, DATABASE_URL: s.url };
  run('pnpm', ['--filter', '@caissepro/api', 'db:deploy'], { env: demoEnv });
  process.env.DATABASE_URL = s.url;
  const { PrismaService } = require('./dist/prisma.service.js');
  const { PasswordService } = require('./dist/auth/password.service.js');
  const { installRoles } = require('./dist/auth/admin.service.js');
  const { CentralAccess } = require('./dist/data/central-access.js');
  const { LedgerService } = require('./dist/data/ledger.service.js');
  const { ExpensesService } = require('./dist/expenses/expenses.service.js');
  const db = new PrismaService();
  await db.$connect();
  try {
    const companyId = randomUUID(),
      agencies = [randomUUID(), randomUUID()],
      registers = [randomUUID(), randomUUID()];
    const profiles = [
      ['admin', 'ADMINISTRATOR'],
      ['direction', 'DIRECTOR'],
      ['finance-source', 'FINANCE_MANAGER'],
      ['finance-reception', 'FINANCE_MANAGER'],
      ['caisse', 'CASHIER'],
      ['audit', 'AUDITOR'],
    ];
    const password = randomBytes(24).toString('base64url');
    const hash = await new PasswordService().hash(password);
    const accounts = [],
      users = [];
    await db.$transaction(
      async (tx) => {
        await tx.company.create({
          data: { id: companyId, code: 'CAISSEPRO-DEMO', name: 'CaissePro — DONNÉES FICTIVES' },
        });
        await installRoles(tx, companyId);
        for (let i = 0; i < 2; i++) {
          await tx.agency.create({
            data: {
              id: agencies[i],
              companyId,
              code: 'DEMO-' + (i + 1),
              name: 'Agence fictive ' + (i + 1),
            },
          });
          await tx.cashRegister.create({
            data: {
              id: registers[i],
              companyId,
              agencyId: agencies[i],
              code: 'CAISSE-' + (i + 1),
              name: 'Caisse fictive ' + (i + 1),
            },
          });
          for (const currency of ['USD', 'CDF'])
            for (const kind of ['TREASURY', 'CLEARING']) {
              const row = {
                id: randomUUID(),
                companyId,
                agencyId: agencies[i],
                cashRegisterId: kind === 'TREASURY' ? registers[i] : null,
                code: kind === 'TREASURY' ? 'CAISSE' : 'CONTREPARTIE',
                currency,
                kind,
              };
              await tx.treasuryAccount.create({ data: row });
              accounts.push(row);
            }
        }
        for (const [label, roleCode] of profiles) {
          const id = randomUUID(),
            memberId = randomUUID(),
            email = label + '@demo.caissepro.test';
          await tx.user.create({
            data: { id, email, displayName: 'DÉMO ' + label, mustChangePassword: false },
          });
          await tx.userCredential.create({ data: { userId: id, passwordHash: hash } });
          await tx.companyMember.create({ data: { id: memberId, companyId, userId: id } });
          const role = await tx.role.findUniqueOrThrow({
            where: { companyId_code: { companyId, code: roleCode } },
          });
          await tx.memberRole.create({ data: { companyId, memberId, roleId: role.id } });
          for (let i = 0; i < 2; i++) {
            await tx.agencyGrant.create({ data: { companyId, memberId, agencyId: agencies[i] } });
            await tx.cashRegisterGrant.create({
              data: { companyId, memberId, agencyId: agencies[i], cashRegisterId: registers[i] },
            });
          }
          users.push({ id, email, role: roleCode });
        }
      },
      { timeout: 30000 },
    );
    const access = new CentralAccess(db),
      ledger = new LedgerService(access),
      ctx = { companyId, userId: users[2].id };
    for (let i = 0; i < 2; i++) {
      const sessionId = randomUUID();
      await access.run(ctx, (tx) =>
        tx.cashSession.create({
          data: {
            id: sessionId,
            companyId,
            agencyId: agencies[i],
            cashRegisterId: registers[i],
            openedById: ctx.userId,
          },
        }),
      );
      for (const currency of ['USD', 'CDF'])
        await ledger.receipt(ctx, {
          agencyId: agencies[i],
          idempotencyKey: randomUUID(),
          accountId: accounts.find(
            (a) => a.agencyId === agencies[i] && a.currency === currency && a.kind === 'TREASURY',
          ).id,
          counterAccountId: accounts.find(
            (a) => a.agencyId === agencies[i] && a.currency === currency && a.kind === 'CLEARING',
          ).id,
          cashSessionId: sessionId,
          currency,
          amount: currency === 'USD' ? '1000.00' : '2800000.00',
        });
    }
    const expenses = new ExpensesService(access, ledger);
    for (const currency of ['USD', 'CDF'])
      await expenses.configure({ companyId, userId: users[0].id }, currency, {
        expectedVersion: null,
        requireEvidence: false,
        limits: ['CASHIER', 'FINANCE_MANAGER', 'DIRECTOR'].flatMap((role) =>
          ['REQUEST', 'APPROVE', 'PAY'].map((action) => ({
            role,
            action,
            maximum: currency === 'USD' ? '500.00' : '1400000.00',
          })),
        ),
      });
    writeFileSync(
      join(directory, 'acces-prives.txt'),
      'DÉMONSTRATION FICTIVE UNIQUEMENT\nEntreprise : CAISSEPRO-DEMO\nMot de passe aléatoire local des comptes démo : ' +
        password +
        '\n' +
        users.map((u) => u.email + ' : ' + u.role).join('\n') +
        '\n',
      { mode: 0o600 },
    );
    const complete = { ...s, ready: true, companyId, users };
    save(complete);
    await secureRuntime(complete);
    console.info(
      'Démonstration isolée créée : deux caisses, six utilisateurs et fonds synthétiques. Accès conservés dans scratch/caissepro-demo/acces-prives.txt, hors Git.',
    );
  } finally {
    await db.$disconnect();
  }
} else if (action === 'start') {
  const s = read();
  assert.equal(s.ready, true);
  const child = spawn(process.execPath, ['apps/api/dist/main.js'], {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      DATABASE_URL: (() => {
        const u = new URL(s.runtimeUrl);
        u.hostname = process.env.CAISSEPRO_DEMO_DB_HOST ?? u.hostname;
        return u.toString();
      })(),
      API_PORT: String(s.port),
      API_HOST: '127.0.0.1',
      API_DEPLOYMENT_ID: 'caissepro-demo',
      AUTH_RATE_LIMIT_SECRET: randomBytes(32).toString('hex'),
    },
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
} else if (action === 'backup-test') {
  const s = read(),
    archive = join(directory, 'demo-backup.dump');
  const name = 'caissepro_demo_restore_' + randomBytes(8).toString('hex');
  const db = new Client({ connectionString: s.url });
  await db.connect();
  await db.query(`CREATE DATABASE "${name}"`);
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = (await db.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
    // The dump and comparisons share a snapshot even while demo users are active.
    const r = spawnSync(
      'docker',
      [
        'compose',
        'exec',
        '-T',
        'postgres',
        'pg_dump',
        '-U',
        'caissepro',
        '-Fc',
        '--snapshot',
        snapshot,
        s.name,
      ],
      { cwd: root, maxBuffer: 32 * 1024 * 1024 },
    );
    assert.equal(r.status, 0, 'Échec pg_dump');
    writeFileSync(archive, r.stdout, { mode: 0o600 });
    const checksum = createHash('sha256').update(r.stdout).digest('hex');
    writeFileSync(archive + '.sha256', checksum + '\n', { mode: 0o600 });
    assert.equal(createHash('sha256').update(readFileSync(archive)).digest('hex'), checksum);
    const restored = spawnSync(
      'docker',
      [
        'compose',
        'exec',
        '-T',
        'postgres',
        'pg_restore',
        '-U',
        'caissepro',

        '--exit-on-error',
        '-d',
        name,
      ],
      { cwd: root, input: r.stdout },
    );
    assert.equal(restored.status, 0, 'Échec pg_restore');
    const u = new URL(s.url);
    u.pathname = '/' + name;
    const copy = new Client({ connectionString: u.toString() });
    await copy.connect();
    try {
      const tables = (
        await db.query(
          "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
        )
      ).rows;
      for (const { tablename } of tables) {
        assert.match(tablename, /^[A-Za-z_]+$/);
        const sql = `SELECT row_to_json(t)::text AS v FROM "${tablename}" t ORDER BY row_to_json(t)::text`;
        assert.ok(
          JSON.stringify((await db.query(sql)).rows) ===
            JSON.stringify((await copy.query(sql)).rows),
          'Données ou métadonnées restaurées différentes.',
        );
      }
      for (const sql of [
        "SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY relname",
        "SELECT proname,pg_get_userbyid(proowner) AS owner,prosecdef,proconfig FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY proname,oid::regprocedure::text",
      ])
        assert.ok(
          JSON.stringify((await db.query(sql)).rows) ===
            JSON.stringify((await copy.query(sql)).rows),
          'Données ou métadonnées restaurées différentes.',
        );
      console.info(
        'Sauvegarde PostgreSQL restaurée et comparée : toutes les tables publiques identiques. Archive privée conservée hors Git.',
      );
    } finally {
      await copy.end();
    }
  } finally {
    await db.query('ROLLBACK');
    await db.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await db.end();
  }
} else throw new Error('Utiliser prepare, start ou backup-test.');
