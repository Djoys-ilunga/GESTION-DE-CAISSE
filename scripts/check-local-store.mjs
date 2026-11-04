import { spawnSync } from 'node:child_process';
const directory = new URL('../packages/local-store/', import.meta.url);
for (const args of [
  ['fmt', '--check'],
  ['clippy', '--locked', '--all-targets', '--', '-D', 'warnings'],
  ['test', '--locked'],
]) {
  const result = spawnSync('cargo', args, { cwd: directory, stdio: 'inherit' });
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
