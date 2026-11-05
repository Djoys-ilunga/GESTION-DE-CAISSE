import { spawnSync } from 'node:child_process';
const cwd = new URL('../packages/session-core/', import.meta.url);
for (const args of [
  ['fmt', '--check'],
  ['clippy', '--locked', '--all-targets', '--', '-D', 'warnings'],
  ['test', '--locked'],
]) {
  const result = spawnSync('cargo', args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
