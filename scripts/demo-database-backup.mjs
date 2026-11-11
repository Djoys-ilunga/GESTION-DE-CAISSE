// Consistent custom-format backup of the existing local demo only; never resets a DB.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  openSync,
  closeSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { localDockerEndpoint, validateDemoState } from './demo-macos.mjs';
const root = fileURLToPath(new URL('../', import.meta.url)),
  directory = fileURLToPath(new URL('../../scratch/caissepro-demo/', import.meta.url));
const state = JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8'));
validateDemoState(state);
let endpoint = process.env.DOCKER_HOST;
if (!endpoint) {
  const r = spawnSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], {
    encoding: 'utf8',
    cwd: root,
    timeout: 10000,
  });
  if (r.status !== 0) throw new Error('Docker local indisponible.');
  endpoint = r.stdout.trim();
}
endpoint = localDockerEndpoint(endpoint);
const url = new URL(state.url),
  name = url.pathname.slice(1);
const env = { ...process.env };
delete env.DOCKER_HOST;
delete env.DOCKER_CONTEXT;
delete env.DOCKER_TLS_VERIFY;
delete env.DOCKER_CERT_PATH;
const destination = join(directory, 'backups');
mkdirSync(destination, { recursive: true, mode: 0o700 });
const file = join(
    destination,
    `avant-migration-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}.dump`,
  ),
  partial = file + '.partial';
let fd;
try {
  fd = openSync(partial, 'wx', 0o600);
  const r = spawnSync(
    'docker',
    [
      '--host=' + endpoint,
      'compose',
      'exec',
      '-T',
      'postgres',
      'pg_dump',
      '--format=custom',
      '--username=' + decodeURIComponent(url.username),
      '--dbname=' + name,
    ],
    { cwd: root, env, stdio: ['ignore', fd, 'pipe'], timeout: 120000 },
  );
  closeSync(fd);
  fd = undefined;
  if (r.status !== 0) throw new Error('Sauvegarde PostgreSQL échouée ; migration non démarrée.');
  const checkFd = openSync(partial, 'r');
  let checked;
  try {
    checked = spawnSync(
      'docker',
      ['--host=' + endpoint, 'compose', 'exec', '-T', 'postgres', 'pg_restore', '--list'],
      { cwd: root, env, stdio: [checkFd, 'pipe', 'pipe'], timeout: 30000 },
    );
  } finally {
    closeSync(checkFd);
  }
  if (checked.status !== 0)
    throw new Error('Archive PostgreSQL illisible ; migration non démarrée.');
  renameSync(partial, file);
  const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
  writeFileSync(file + '.sha256', hash + '  ' + file.split('/').at(-1) + '\n', { mode: 0o600 });
  console.log('Sauvegarde locale créée et archive vérifiée : ' + file);
} catch (e) {
  if (fd !== undefined) closeSync(fd);
  rmSync(partial, { force: true });
  throw e;
}
