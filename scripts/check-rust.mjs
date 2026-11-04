import { spawnSync } from 'node:child_process';
for (const directory of ['packages/local-store/', 'apps/desktop/src-tauri/']) {
  const cwd = new URL(`../${directory}`, import.meta.url);
  for (const args of [
    ['fmt', '--check'],
    ['clippy', '--locked', '--all-targets', '--', '-D', 'warnings'],
  ]) {
    const result = spawnSync('cargo', args, { cwd, stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
