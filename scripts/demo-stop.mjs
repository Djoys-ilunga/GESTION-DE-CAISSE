// Stop only positively identified API/Vite listeners from this checkout.
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const ports = [3001, 1420];

export function demoProcessRole({ port, executable, command, cwd }, projectRoot) {
  if (!['node', 'nodejs'].includes(basename(executable))) return null;
  const prefix = [executable, basename(executable), process.execPath].find((value) =>
    command.startsWith(value + ' '),
  );
  if (!prefix) return null;
  const args = command.slice(prefix.length + 1);
  if (
    port === 3001 &&
    cwd === projectRoot &&
    ['apps/api/dist/main.js', join(projectRoot, 'apps/api/dist/main.js')].includes(args)
  )
    return 'API';
  const suffix = ' --host 127.0.0.1 --port 1420 --strictPort';
  if (port !== 1420 || cwd !== join(projectRoot, 'apps/desktop') || !args.endsWith(suffix))
    return null;
  try {
    const entry = args.slice(0, -suffix.length);
    const script = realpathSync(isAbsolute(entry) ? entry : resolve(cwd, entry));
    if (
      script.startsWith(projectRoot + sep) &&
      script.endsWith(join('node_modules', 'vite', 'bin', 'vite.js'))
    )
      return 'interface';
  } catch {
    /* Unknown executables are never stopped. */
  }
  return null;
}

function run(program, args) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 3000 });
  if (result.error || ![0, 1].includes(result.status))
    throw new Error(`Diagnostic ${program} impossible. Aucun processus inconnu ne sera arrêté.`);
  return result.stdout.trim();
}

export async function stopDemoProcesses({
  projectRoot = root,
  execute = run,
  signal = (pid) => process.kill(pid, 'SIGTERM'),
  pause = delay,
  lockExists = existsSync,
} = {}) {
  projectRoot = realpathSync(projectRoot);
  const lock = join(dirname(projectRoot), 'scratch/caissepro-demo/lancement-macos.lock');
  const listeners = (port) => {
    const output = execute('lsof', ['-nP', '-t', '-iTCP:' + port, '-sTCP:LISTEN']);
    if (!output) return [];
    const pids = [...new Set(output.split(/\s+/).map(Number))];
    if (pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 1))
      throw new Error('Diagnostic de port invalide. Aucun arrêt effectué.');
    return pids;
  };
  const inspect = (pid, port) => {
    let executable = execute('ps', ['-p', String(pid), '-o', 'comm=']);
    if (!executable) return null;
    // Node 24 can expose a thread name through Linux ps; verify the executable.
    if (process.platform === 'linux' && executable === 'MainThread') {
      try {
        executable = realpathSync(`/proc/${pid}/exe`);
      } catch {
        throw new Error(`Exécutable du processus ${pid} non vérifiable ; arrêt refusé.`);
      }
    }
    const command = execute('ps', ['-p', String(pid), '-o', 'command=']);
    const started = execute('ps', ['-p', String(pid), '-o', 'lstart=']);
    const path = execute('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
      .split('\n')
      .find((line) => line.startsWith('n'))
      ?.slice(1);
    if (!command || !started || !path)
      throw new Error(`Processus ${pid} non identifiable ; arrêt refusé.`);
    let cwd;
    try {
      cwd = realpathSync(path);
    } catch {
      throw new Error(`Dossier du processus ${pid} non vérifiable ; arrêt refusé.`);
    }
    const role = demoProcessRole({ port, executable, command, cwd }, projectRoot);
    if (!role)
      throw new Error(
        `Port ${port} occupé par un processus non reconnu (${pid}). Ce processus ne sera pas arrêté.`,
      );
    return { pid, port, role, identity: JSON.stringify([executable, command, started, cwd]) };
  };
  // Inspect both ports before sending any signal, including when one is foreign.
  const targets = [];
  for (const port of ports)
    for (const pid of listeners(port)) {
      const target = inspect(pid, port);
      if (target) targets.push(target);
    }
  for (const target of targets) {
    const current = inspect(target.pid, target.port);
    if (!current) continue;
    if (current.identity !== target.identity)
      throw new Error('Un processus a changé pendant le diagnostic ; arrêt interrompu.');
    try {
      signal(target.pid);
    } catch (error) {
      if (error.code !== 'ESRCH')
        throw new Error(`Arrêt du processus ${target.pid} refusé.`, { cause: error });
    }
  }
  for (let attempt = 0; attempt < 40; attempt++) {
    if (ports.every((port) => listeners(port).length === 0) && !lockExists(lock))
      return targets.length;
    await pause(250);
  }
  throw new Error(
    'Un service ou le verrou de lancement reste actif. Fermez son Terminal avec Ctrl+C puis vérifiez ; aucun arrêt forcé ni suppression de données effectué.',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.platform !== 'darwin' || process.argv.length !== 2) {
    console.error('Utilisation sur macOS : pnpm demo:stop.');
    process.exitCode = 1;
  } else {
    stopDemoProcesses()
      .then((count) => {
        console.info(
          count
            ? 'Les anciens services CaissePro de ce dossier sont arrêtés ; les ports sont libérés.'
            : 'Aucun ancien service CaissePro sur les ports de démonstration.',
        );
        console.info(
          'PostgreSQL, les données et le mot de passe sont conservés. Relancez avec bash scripts/demo-macos.command.',
        );
      })
      .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
  }
}
