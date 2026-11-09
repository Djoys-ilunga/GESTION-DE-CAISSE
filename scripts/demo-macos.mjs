// Local native demo only; no public deployment, reset or production migration.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, rmdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = fileURLToPath(new URL('../../scratch/caissepro-demo/', import.meta.url));
const guide = 'Voir docs/demonstration-macos.md.';

function localQuery(url) {
  return [...url.searchParams].every(([key, value]) => key === 'schema' && value === 'public');
}

export function localDockerEndpoint(endpoint) {
  if (!/^unix:\/\/\//.test(endpoint.trim()))
    throw new Error('Docker distant refusé : choisissez Docker Desktop local. ' + guide);
  return endpoint.trim();
}

export function validateLocalConfig(env) {
  let url;
  try {
    url = new URL(env.DATABASE_URL);
  } catch {
    throw new Error('DATABASE_URL locale absente ou invalide. ' + guide);
  }
  if (
    url.protocol !== 'postgresql:' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    (url.port && url.port !== '5432') ||
    url.pathname !== '/caissepro' ||
    url.username !== 'caissepro' ||
    !localQuery(url) ||
    !env.POSTGRES_PASSWORD ||
    decodeURIComponent(url.password) !== env.POSTGRES_PASSWORD
  )
    throw new Error(
      'Configuration différente de la base Docker locale attendue ; lancement refusé. ' + guide,
    );
}

export function validateDemoState(state) {
  if (state.ready !== true || state.port !== 3001)
    throw new Error('Démonstration incomplète : conserver les données et diagnostiquer. ' + guide);
  const admin = new URL(state.url);
  const runtime = new URL(state.runtimeUrl);
  if (
    !/^\/caissepro_demo_[a-f0-9]+$/.test(admin.pathname) ||
    ![admin, runtime].every(
      (url) =>
        url.protocol === 'postgresql:' &&
        url.hostname === '127.0.0.1' &&
        localQuery(url) &&
        (url.port === '' || url.port === '5432') &&
        url.pathname === admin.pathname,
    )
  )
    throw new Error('Connexion démo non locale ou incohérente ; lancement refusé. ' + guide);
}

function command(cmd, args, env, capture = false) {
  const result = spawnSync(cmd, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  });
  if (result.error || result.status !== 0)
    throw new Error(`Échec de ${cmd} ${args[0] ?? ''}. ${guide}`);
  return result.stdout?.trim();
}

async function available(port) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', () =>
      reject(new Error(`Port ${port} occupé ; fermez l'autre instance avant de relancer.`)),
    );
    server.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('Ce lanceur nécessite macOS. ' + guide);
  if (process.argv.slice(2).some((arg) => arg !== '--check'))
    throw new Error('Option inconnue. Utilisez --check ou aucune option.');
  if (!/^24\./.test(process.versions.node) || Number(process.versions.node.split('.')[1]) < 11)
    throw new Error('Installez Node.js 24.11 ou plus récent dans la branche 24 LTS. ' + guide);
  const env = { ...process.env };
  if (command('pnpm', ['--version'], env, true) !== '11.25.0')
    throw new Error('Installez pnpm 11.25.0. ' + guide);
  command('xcode-select', ['-p'], env, true);
  command('xcrun', ['--find', 'clang'], env, true);
  command('perl', ['-v'], env, true);
  command('rustup', ['run', '1.90.0', 'cargo', '--version'], env, true);
  const endpoint = env.DOCKER_CONTEXT
    ? command(
        'docker',
        ['context', 'inspect', env.DOCKER_CONTEXT, '--format', '{{.Endpoints.docker.Host}}'],
        env,
        true,
      )
    : env.DOCKER_HOST ||
      command(
        'docker',
        ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
        env,
        true,
      );
  env.DOCKER_HOST = localDockerEndpoint(endpoint);
  delete env.DOCKER_CONTEXT;
  delete env.CAISSEPRO_DEMO_DB_HOST;
  for (const key of [
    'COMPOSE_FILE',
    'COMPOSE_PROJECT_NAME',
    'COMPOSE_PROFILES',
    'COMPOSE_ENV_FILES',
  ])
    delete env[key];
  command('docker', ['info', '--format', '{{.ServerVersion}}'], env, true);
  command('docker', ['compose', 'version'], env, true);
  const config = existsSync(join(root, '.env'))
    ? { ...parseEnv(readFileSync(join(root, '.env'), 'utf8')), ...env }
    : env;
  if (config.DATABASE_URL || config.POSTGRES_PASSWORD) validateLocalConfig(config);
  const statePath = join(directory, 'state.json');
  if (existsSync(statePath)) validateDemoState(JSON.parse(readFileSync(statePath, 'utf8')));
  await available(3001);
  await available(1420);
  if (process.argv.includes('--check')) {
    console.info('Prérequis et configuration locale vérifiés ; aucune préparation effectuée.');
    return;
  }

  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, 'lancement-macos.lock');
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch {
    throw new Error('Un lancement est déjà actif ou a été interrompu. ' + guide);
  }
  const children = [];
  let interrupted = false;
  const stop = (signal = 'SIGTERM') => {
    for (const child of children) {
      if (!child.pid) continue;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
  };
  const interrupt = () => {
    interrupted = true;
    stop();
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    console.info('Préparation locale. La première compilation peut prendre plusieurs minutes.');
    command('pnpm', ['install', '--frozen-lockfile'], env);
    command('pnpm', ['setup:env'], env);
    validateLocalConfig({ ...parseEnv(readFileSync(join(root, '.env'), 'utf8')), ...env });
    command('pnpm', ['db:generate'], env);
    command('pnpm', ['db:up'], env);
    env.VITE_API_BASE_URL = 'http://127.0.0.1:3001';
    env.VITE_API_DEPLOYMENT_ID = 'caissepro-demo';
    command('pnpm', ['demo:prepare'], env);
    validateDemoState(JSON.parse(readFileSync(statePath, 'utf8')));
    if (interrupted) return;
    // Both ports must still be free after the potentially lengthy first build.
    await available(3001);
    await available(1420);
    const logPath = join(directory, 'api-macos.log');
    const log = openSync(logPath, 'a', 0o600);
    const api = spawn(process.execPath, ['scripts/demo.mjs', 'start'], {
      cwd: root,
      env,
      detached: true,
      stdio: ['ignore', log, log],
    });
    closeSync(log);
    children.push(api);
    let apiFailed = false;
    api.on('error', () => {
      apiFailed = true;
    });
    api.on('exit', () => {
      apiFailed = true;
    });
    let ready = false;
    for (let attempt = 0; attempt < 60 && !interrupted; attempt++) {
      if (apiFailed) break;
      try {
        const response = await fetch('http://127.0.0.1:3001/api/v1/health/ready', {
          signal: AbortSignal.timeout(1000),
          redirect: 'error',
        });
        ready = response.ok;
        await response.body?.cancel();
        if (ready) break;
      } catch {
        /* The owned API may still be starting. */
      }
      await delay(500);
    }
    if (interrupted) return;
    if (!ready || apiFailed) throw new Error(`API démo indisponible. Journal privé : ${logPath}`);
    console.info('Ouverture de CaissePro. Entreprise : CAISSEPRO-DEMO.');
    console.info(`Vos accès sont dans : ${join(directory, 'acces-prives.txt')}`);
    console.info(
      'Gardez ce Terminal ouvert. Ctrl+C arrête la démonstration en conservant les données.',
    );
    command('open', ['-t', join(directory, 'acces-prives.txt')], env, true);
    const desktop = spawn('pnpm', ['dev:desktop'], {
      cwd: root,
      env,
      detached: true,
      stdio: 'inherit',
    });
    children.push(desktop);
    const code = await new Promise((resolve, reject) => {
      desktop.once('error', reject);
      desktop.once('exit', (status) => resolve(status));
      api.once('exit', () => {
        stop();
        reject(new Error('Le serveur démo s’est arrêté. ' + guide));
      });
    });
    if (!interrupted && code !== 0)
      throw new Error('La compilation ou le lancement natif a échoué. ' + guide);
  } finally {
    stop();
    if (children.length) {
      await delay(1500);
      stop('SIGKILL');
    }
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    rmdirSync(lock);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
