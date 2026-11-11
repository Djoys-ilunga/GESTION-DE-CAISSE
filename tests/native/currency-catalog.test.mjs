import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const root = new URL('../../', import.meta.url),
  parser = new URL('../../scripts/parse-iso-currencies.py', import.meta.url);
test('ISO monetary units agree with the dated official XML, including MGA, and the migration is reproducible', () => {
  const r = spawnSync(
    'python3',
    [
      parser.pathname,
      new URL('../../data/iso-4217-list-one-2024-06-25.xml', import.meta.url).pathname,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0);
  const iso = JSON.parse(r.stdout),
    catalog = JSON.parse(
      readFileSync(new URL('../../data/initial-currencies.json', import.meta.url), 'utf8'),
    );
  assert.equal(iso.length, catalog.length);
  for (const c of catalog)
    assert.deepEqual(
      iso.find((v) => v.code === c.code),
      {
        code: c.code,
        numericCode: c.numericCode,
        precision: c.precision,
        sourceDate: c.sourceDate,
      },
    );
  const checked = spawnSync('python3', ['scripts/generate-currency-migration.py', '--check'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(checked.status, 0, checked.stderr);
});
test('catalog importer refuses external XML entities without any network request', () => {
  const dir = mkdtempSync(join(tmpdir(), 'caissepro-iso-'));
  try {
    const file = join(dir, 'invalid.xml');
    writeFileSync(
      file,
      '<!DOCTYPE ISO_4217 [<!ENTITY external SYSTEM "file:///etc/passwd">]><ISO_4217 Pblshd="2024-06-25"><CcyTbl>&external;</CcyTbl></ISO_4217>',
    );
    assert.notEqual(spawnSync('python3', [parser.pathname, file], { encoding: 'utf8' }).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
