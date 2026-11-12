// Real upgrade test: replay untouched historical migrations, post CDF/USD,
// freeze every existing row in PostgreSQL JSONB, migrate, compare and roll back
// a deliberately failed migration. Never connects to a non-local database.
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { mkdtempSync, openSync, closeSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { localDockerEndpoint } from './demo-macos.mjs';
import assert from 'node:assert/strict';
const bccUpgrade = process.argv.includes('--bcc');
const targetMigration = bccUpgrade
  ? '20261111000200_bcc_exchange'
  : '20261111000100_extensible_currencies';
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
require('dotenv').config({ path: new URL('../.env', import.meta.url), quiet: true });
const { Client } = require('pg');
const base = new URL(process.env.DATABASE_URL);
if (
  !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) ||
  [...base.searchParams.keys()].some((key) => key !== 'schema')
)
  throw new Error('PostgreSQL local obligatoire');
const name = 'caissepro_test_' + randomBytes(8).toString('hex'),
  admin = new Client({ connectionString: base.toString() });
await admin.connect();
let db, restored;
const restoreName = name + '_restore';
let scratch;
try {
  await admin.query(`CREATE DATABASE "${name}"`);
  base.pathname = '/' + name;
  db = new Client({ connectionString: base.toString() });
  await db.connect();
  const directory = new URL('../apps/api/prisma/migrations/', import.meta.url),
    names = (await readdir(directory)).filter((n) => /^\d/.test(n) && n <= targetMigration).sort(),
    latest = names.at(-1);
  assert.equal(latest, targetMigration);
  for (const n of names.slice(0, -1))
    await db.query(await readFile(new URL(n + '/migration.sql', directory), 'utf8'));
  const c = randomUUID(),
    a = randomUUID(),
    u = randomUUID(),
    member = randomUUID(),
    role = randomUUID(),
    cash = randomUUID(),
    session = randomUUID();
  await db.query('INSERT INTO "Company"(id,name)VALUES($1,\'Migration financière\')', [c]);
  await db.query(
    'INSERT INTO "Agency"(id,"companyId",code,name)VALUES($1,$2,\'TEST\',\'Agence\')',
    [a, c],
  );
  await db.query('INSERT INTO "User"(id,email,"displayName")VALUES($1,$2,\'Migration\')', [
    u,
    u + '@example.test',
  ]);
  await db.query('INSERT INTO "CompanyMember"(id,"companyId","userId")VALUES($1,$2,$3)', [
    member,
    c,
    u,
  ]);
  await db.query('INSERT INTO "Role"(id,"companyId",code)VALUES($1,$2,\'ADMIN_TEST\')', [role, c]);
  await db.query('INSERT INTO "RolePermission" SELECT $1,$2,code FROM "Permission"', [c, role]);
  await db.query('INSERT INTO "MemberRole"VALUES($1,$2,$3)', [c, member, role]);
  await db.query('INSERT INTO "AgencyGrant"VALUES($1,$2,$3)', [c, member, a]);
  await db.query(
    'INSERT INTO "CashRegister"(id,"companyId","agencyId",code,name)VALUES($1,$2,$3,\'C1\',\'Caisse\')',
    [cash, c, a],
  );
  await db.query(
    'INSERT INTO "CashRegisterGrant"("companyId","memberId","agencyId","cashRegisterId")VALUES($1,$2,$3,$4)',
    [c, member, a, cash],
  );
  const treasury = {};
  for (const currency of ['CDF', 'USD']) {
    const account = randomUUID(),
      counter = randomUUID();
    treasury[currency] = account;
    await db.query(
      'INSERT INTO "TreasuryAccount"(id,"companyId","agencyId","cashRegisterId",code,currency,kind)VALUES($1,$2,$3,$4,\'CASH\',$5,\'TREASURY\'),($6,$2,$3,NULL,\'CLEAR\',$5,\'CLEARING\')',
      [account, c, a, cash, currency, counter],
    );
    await db.query('BEGIN');
    await db.query(
      "SELECT set_config('caissepro.company_id',$1,true),set_config('caissepro.actor_id',$2,true)",
      [c, u],
    );
    await db.query('SET LOCAL ROLE caissepro_runtime');
    if (currency === 'CDF')
      await db.query(
        'INSERT INTO "CashSession"(id,"companyId","agencyId","cashRegisterId","openedById")VALUES($1,$2,$3,$4,$5)',
        [session, c, a, cash, u],
      );
    const op = randomUUID(),
      draftId = randomUUID(),
      clientId = randomUUID(),
      amount = currency === 'CDF' ? '9007199254740993.01' : '123456.78';
    await db.query(
      `INSERT INTO "ImportedDraft"(id,"companyId","agencyId","authorId","clientDraftId",kind,currency,amount,description,version,"payloadHash","cashRegisterId","receiptProvenance","receiptCategory","receiptReference")VALUES($1,$2,$3,$4,$5,'RECEIPT',$6,$7,'Ancienne opération',1,$8,$9,'Payeur historique','Recette historique','REFERENCE-CONSERVEE')`,
      [draftId, c, a, u, clientId, currency, amount, 'b'.repeat(64), cash],
    );
    await db.query(
      'INSERT INTO "FinancialOperation"(id,"companyId","agencyId","createdById",kind,currency,"idempotencyKey","requestHash")VALUES($1,$2,$3,$4,\'RECEIPT\',$5,$6,$7)',
      [op, c, a, u, currency, draftId, 'a'.repeat(64)],
    );
    await db.query(
      'INSERT INTO "LedgerEntry"(id,"companyId","operationId","accountId","cashSessionId","lineNo",currency,side,amount)VALUES($1,$2,$3,$4,$5,1,$6,\'DEBIT\',$7),($8,$2,$3,$9,NULL,2,$6,\'CREDIT\',$7)',
      [randomUUID(), c, op, account, session, currency, amount, randomUUID(), counter],
    );
    await db.query(
      'INSERT INTO "AuditEvent"(id,"companyId","actorId",action,"targetType","targetId")VALUES($1,$2,$3,\'OPERATION_POSTED\',\'OPERATION\',$4)',
      [randomUUID(), c, u, op],
    );
    const year = new Date().getUTCFullYear();
    const sequence = (
      await db.query(
        `INSERT INTO "ReceiptCounter"("companyId",year,"lastSequence")VALUES($1,$2,1) ON CONFLICT("companyId",year)DO UPDATE SET "lastSequence"="ReceiptCounter"."lastSequence"+1 RETURNING "lastSequence"`,
        [c, year],
      )
    ).rows[0].lastSequence;
    await db.query(
      `INSERT INTO "CashReceipt"(id,"companyId","agencyId","cashRegisterId","sourceDraftId","sourceVersion","clientDraftId","operationId","createdById",currency,amount,provenance,category,description,reference,year,sequence)VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10,'Payeur historique','Recette historique','Ancienne opération','REFERENCE-CONSERVEE',$11,$12)`,
      [randomUUID(), c, a, cash, draftId, clientId, op, u, currency, amount, year, sequence],
    );
    await db.query('COMMIT');
  }
  // A closure snapshot produced by the historical SQL guard is immutable JSON.
  await db.query('BEGIN');
  await db.query(
    "SELECT set_config('caissepro.company_id',$1,true),set_config('caissepro.actor_id',$2,true)",
    [c, u],
  );
  await db.query('SET LOCAL ROLE caissepro_runtime');
  await db.query(
    'UPDATE "CashSession" SET state=\'CLOSED\',"closedById"=$1,"closedAt"=clock_timestamp() WHERE id=$2',
    [u, session],
  );
  await db.query(
    'INSERT INTO "CashClosureReport"(id,"companyId","cashRegisterId","sessionId","closedById","closedAt",snapshot)VALUES($1,$2,$3,$4,$5,clock_timestamp(),$6)',
    [randomUUID(), c, cash, session, u, { CDF: '9007199254740993.01', USD: '123456.78' }],
  );
  await db.query('COMMIT');
  if (bccUpgrade) {
    await db.query(
      'INSERT INTO "ExchangeRate"(id,"companyId","fromCurrency","toCurrency",rate,source,"effectiveAt")VALUES($1,$2,\'USD\',\'CDF\',2500,\'Taux historique conservé\',clock_timestamp())',
      [randomUUID(), c],
    );
    await db.query('BEGIN');
    await db.query(
      "SELECT set_config('caissepro.company_id',$1,true),set_config('caissepro.actor_id',$2,true)",
      [c, u],
    );
    await db.query(
      'INSERT INTO "TransferOrder"(id,"companyId","authorId","sourceCashRegisterId","destinationCashRegisterId","sourceAccountId","destinationAccountId","sourceCurrency","destinationCurrency",amount,"targetAmount",rate,"rateSource",description,"payloadHash")VALUES($1,$2,$3,$4,$4,$5,$6,\'USD\',\'CDF\',1,2500,2500,\'Manuel historique\',\'Brouillon historique\',$7)',
      [randomUUID(), c, u, cash, treasury.USD, treasury.CDF, 'c'.repeat(64)],
    );
    await db.query('COMMIT');
  }
  await db.query(
    "CREATE TEMP TABLE cp_before_rows AS SELECT ''::text relation,'{}'::jsonb value WITH NO DATA",
  );
  const tables = (
    await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
  ).rows.map((r) => r.tablename);
  for (const t of tables)
    await db.query(`INSERT INTO cp_before_rows SELECT $1,to_jsonb(t) FROM "${t}" t`, [t]);
  assert.equal((await db.query('SELECT count(*)::integer n FROM "CashReceipt"')).rows[0].n, 2);
  const flags = (
    await db.query(
      "SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY relname",
    )
  ).rows;
  const migration = await readFile(new URL(latest + '/migration.sql', directory), 'utf8');
  // Intentional post-DDL failure proves the whole new migration is transactional.
  await assert.rejects(
    db.query(
      migration.replace(
        'COMMIT;',
        () => "DO $$ BEGIN RAISE EXCEPTION 'UPGRADE_TEST_ROLLBACK'; END $$; COMMIT;",
      ),
    ),
    /UPGRADE_TEST_ROLLBACK/,
  );
  await db.query('ROLLBACK');
  assert.equal(
    (await db.query("SELECT typtype FROM pg_type WHERE typname='Currency'")).rows[0].typtype,
    bccUpgrade ? 'd' : 'e',
  );
  if (bccUpgrade)
    assert.equal((await db.query('SELECT to_regclass(\'public."RateQuote"\') r')).rows[0].r, null);
  await db.query(migration);
  for (const t of tables) {
    const extra = bccUpgrade
      ? t === 'TransferOrder'
        ? ['rateQuoteId', 'rateOrigin', 'rateEvidence']
        : t === 'ExchangeRate'
          ? ['transferOrderId', 'rateEvidence']
          : []
      : [];
    const projection = extra.length
      ? `to_jsonb(t)-ARRAY[${extra.map((k) => "'" + k + "'").join(',')}]`
      : 'to_jsonb(t)';
    const filter =
      bccUpgrade && t === 'Permission'
        ? "WHERE code<>'fx:manual'"
        : bccUpgrade && t === 'RolePermission'
          ? `WHERE "permissionCode"<>'fx:manual'`
          : '';
    const r = await db.query(
      `SELECT count(*)::integer n FROM ((SELECT value FROM cp_before_rows WHERE relation=$1 EXCEPT ALL SELECT ${projection} FROM "${t}" t) UNION ALL (SELECT ${projection} FROM "${t}" t ${filter} EXCEPT ALL SELECT value FROM cp_before_rows WHERE relation=$1)) mismatch`,
      [t],
    );
    assert.equal(r.rows[0].n, 0, 'Valeurs historiques modifiées : ' + t);
  }
  const after = (
    await db.query(
      "SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY relname",
    )
  ).rows.filter((r) => flags.some((f) => f.relname === r.relname));
  assert.deepEqual(after, flags);
  assert.equal(
    (
      await db.query(
        'SELECT count(*)::integer n FROM "CompanyCurrency" WHERE "companyId"=$1 AND active',
        [c],
      )
    ).rows[0].n,
    2,
  );
  assert.equal((await db.query("SELECT caissepro_currency_precision('JPY') p")).rows[0].p, 0);
  // A custom pg_dump is restored into a second disposable DB and compared on-server.
  const root = fileURLToPath(new URL('../', import.meta.url));
  let endpoint = process.env.DOCKER_HOST;
  if (!endpoint) {
    const c = spawnSync(
      'docker',
      ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(c.status, 0);
    endpoint = c.stdout.trim();
  }
  endpoint = localDockerEndpoint(endpoint);
  const dockerEnv = { ...process.env };
  for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'])
    delete dockerEnv[key];
  const docker = ['--host=' + endpoint, 'compose', 'exec', '-T', 'postgres'];
  scratch = mkdtempSync(join(tmpdir(), 'caissepro-upgrade-'));
  const archive = join(scratch, 'backup.dump');
  let fd = openSync(archive, 'wx', 0o600);
  try {
    assert.equal(
      spawnSync(
        'docker',
        [
          ...docker,
          'pg_dump',
          '--format=custom',
          '--username=' + decodeURIComponent(base.username),
          '--dbname=' + name,
        ],
        { cwd: root, env: dockerEnv, stdio: ['ignore', fd, 'pipe'], timeout: 60000 },
      ).status,
      0,
      'pg_dump doit réussir',
    );
  } finally {
    closeSync(fd);
  }
  assert.equal(readFileSync(archive).subarray(0, 5).toString(), 'PGDMP');
  await admin.query(`CREATE DATABASE "${restoreName}"`);
  fd = openSync(archive, 'r');
  try {
    assert.equal(
      spawnSync(
        'docker',
        [
          ...docker,
          'pg_restore',
          '--exit-on-error',
          '--username=' + decodeURIComponent(base.username),
          '--dbname=' + restoreName,
        ],
        { cwd: root, env: dockerEnv, stdio: [fd, 'pipe', 'pipe'], timeout: 60000 },
      ).status,
      0,
      'pg_restore doit réussir',
    );
  } finally {
    closeSync(fd);
  }
  const restoreUrl = new URL(base);
  restoreUrl.pathname = '/' + restoreName;
  restored = new Client({ connectionString: restoreUrl.toString() });
  await restored.connect();
  const allTables = (
    await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
  ).rows.map((r) => r.tablename);
  for (const t of allTables) {
    const sql = `SELECT count(*)::text n,encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'[]'),'UTF8')),'hex') hash FROM "${t}" t`;
    assert.deepEqual(
      (await restored.query(sql)).rows,
      (await db.query(sql)).rows,
      'Restauration différente : ' + t,
    );
  }
  console.log(
    `Sauvegarde/restauration réelle vérifiée : ${allTables.length} tables identiques dans une deuxième base jetable.`,
  );
  console.log(
    `Migration ${targetMigration} vérifiée : ${tables.length} tables historiques préservées${bccUpgrade ? ', hors colonnes additives et nouveau droit FX manuel' : ''} (valeurs numériques exactes, identifiants, JSON et dates), RLS conservée, rollback DDL validé.`,
  );
} finally {
  await restored?.end();
  await db?.end();
  await admin.query(`DROP DATABASE IF EXISTS "${restoreName}" WITH (FORCE)`);
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.end();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}
