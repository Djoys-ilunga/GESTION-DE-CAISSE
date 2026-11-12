// Surface bounded test diagnostics as CI annotations, including for public job summaries.
// Commands operate on synthetic qualification fixtures, never an enterprise database.
import { spawn } from 'node:child_process';
const [command, ...args] = process.argv.slice(2);
if (!['cargo', 'pnpm'].includes(command)) throw new Error('Commande de qualification inconnue.');
const child = spawn(command, args, {
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: process.platform === 'win32' && command === 'pnpm',
});
let output = '';
for (const [stream, target] of [
  [child.stdout, process.stdout],
  [child.stderr, process.stderr],
])
  stream.on('data', (chunk) => {
    target.write(chunk);
    output = (output + chunk.toString()).slice(-32000);
  });
child.on('error', (error) => {
  console.error('Qualification impossible :', error.code);
  process.exitCode = 1;
});
child.on('close', (code) => {
  if (code !== 0) {
    const diagnostic =
      output
        .split('\n')
        .filter((line) =>
          /error|FAILED|panicked|Err\(|Err.*value|assertion|left:|right:|Caused by|failed|not found/i.test(
            line,
          ),
        )
        .join('\n')
        .slice(-6000) || output.slice(-3000);
    const escaped = diagnostic
      .replaceAll('%', '%25')
      .replaceAll('\r', '%0D')
      .replaceAll('\n', '%0A');
    console.error(`::error title=Qualification native::${escaped}`);
    process.exitCode = code ?? 1;
  } else {
    const summary = output
      .split('\n')
      .filter((line) => /test result: ok\.|Tests\s+[0-9]+ passed/.test(line))
      .join(' · ')
      .slice(-1500);
    const label = `${command} ${args.join(' ')} : ${summary || 'réussi'}`
      .replaceAll('%', '%25')
      .replaceAll('\r', '%0D')
      .replaceAll('\n', '%0A');
    console.log(`::notice title=Qualification native réussie::${label}`);
  }
});
