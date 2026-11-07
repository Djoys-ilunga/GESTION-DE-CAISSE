import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = new URL('../../', import.meta.url);
test('Toutes les commandes IPC enregistrées ont une permission générée et une autorisation de fenêtre', () => {
  const runtime = readFileSync(new URL('apps/desktop/src-tauri/src/lib.rs', root), 'utf8');
  const build = readFileSync(new URL('apps/desktop/src-tauri/build.rs', root), 'utf8');
  const capability = JSON.parse(
    readFileSync(new URL('apps/desktop/src-tauri/capabilities/main.json', root), 'utf8'),
  );
  const commands = [...runtime.matchAll(/commands::([a-z_]+)/g)].map((m) => m[1]);
  assert.ok(commands.includes('transfer_action'));
  for (const command of commands) {
    assert.ok(build.includes(`"${command}"`), `Commande non déclarée : ${command}`);
    assert.ok(
      capability.permissions.includes('allow-' + command.replaceAll('_', '-')),
      `Permission de fenêtre absente : ${command}`,
    );
  }
  assert.deepEqual(capability.windows, ['main']);
  assert.ok(!capability.permissions.some((p) => /shell|fs:|sql:|http:/.test(p)));
});
