// Catalogue additions only. No rates, ledger updates or implicit company activation.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2),
  apply = args.includes('--apply'),
  file = args.find((a) => a !== '--apply');
if (!file || args.length !== (apply ? 2 : 1))
  throw new Error('Usage : node scripts/import-currencies.mjs fichier-ISO.xml [--apply]');
const parsed = spawnSync(
  'python3',
  [fileURLToPath(new URL('./parse-iso-currencies.py', import.meta.url)), file],
  { encoding: 'utf8', maxBuffer: 2_000_000 },
);
if (parsed.status !== 0) throw new Error('Document ISO invalide ; import annulé.');
const rows = JSON.parse(parsed.stdout);
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
require('dotenv').config({ path: new URL('../.env', import.meta.url), quiet: true });
const { Client } = require('pg'),
  db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await db.query("SELECT pg_advisory_xact_lock(hashtext('caissepro-iso-catalog-import'))");
  const existing = (await db.query('SELECT code,"precision" FROM "CurrencyDefinition"')).rows;
  if (rows.some((r) => existing.some((e) => e.code === r.code && e.precision !== r.precision)))
    throw new Error(
      'Une précision existante diffère : analyse et migration explicite requises. Aucune donnée modifiée.',
    );
  const additions = rows.filter((r) => !existing.some((e) => e.code === r.code));
  if (existing.length + additions.length > 300) throw new Error('Capacité du catalogue dépassée.');
  console.log(
    'Source ISO : ' +
      rows[0].sourceDate +
      ' ; nouvelles devises : ' +
      (additions.map((r) => r.code).join(', ') || 'aucune'),
  );
  if (apply) {
    const names = new Intl.DisplayNames(['fr'], { type: 'currency' });
    for (const r of additions) {
      const symbol =
        new Intl.NumberFormat('fr-FR', { style: 'currency', currency: r.code })
          .formatToParts(0)
          .find((p) => p.type === 'currency')?.value ?? r.code;
      await db.query(
        'INSERT INTO "CurrencyDefinition"(code,"numericCode",name,symbol,"precision",active,"bccRateStatus","sourceDate")VALUES($1,$2,$3,$4,$5,true,\'UNVERIFIED\',$6)',
        [r.code, r.numericCode, names.of(r.code) ?? r.code, symbol, r.precision, r.sourceDate],
      );
    }
    await db.query('COMMIT');
    console.log('Ajouts enregistrés. Chaque entreprise doit les activer explicitement.');
  } else {
    await db.query('ROLLBACK');
    console.log(
      'Simulation uniquement ; utilisez --apply après sauvegarde et vérification de la source officielle.',
    );
  }
} catch {
  await db.query('ROLLBACK');
  process.exitCode = 1;
  console.error(
    'Import refusé ou conflit. Vérifiez le fichier ISO, les précisions et les droits du compte de migration ; aucune modification partielle.',
  );
} finally {
  await db.end();
}
