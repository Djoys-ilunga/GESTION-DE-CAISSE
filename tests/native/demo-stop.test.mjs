import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { demoProcessRole, stopDemoProcesses } from '../../scripts/demo-stop.mjs';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'caissepro-stop-')));
  const desktop = join(root, 'apps/desktop');
  const vite = join(root, 'node_modules/vite/bin/vite.js');
  mkdirSync(desktop, { recursive: true });
  mkdirSync(join(root, 'node_modules/vite/bin'), { recursive: true });
  writeFileSync(vite, '// Fixture only.');
  // This tests the macOS process classifier with synthetic ps/lsof records,
  // independently of the host Node binary's name (node.exe on Windows).
  const nodeExecutable = join(root, 'node');
  const records = [
    {
      pid: 12345,
      port: 3001,
      executable: nodeExecutable,
      command: nodeExecutable + ' apps/api/dist/main.js',
      cwd: root,
      started: 'Tue Nov 10 10:00:00 2026',
      alive: true,
    },
    {
      pid: 12346,
      port: 1420,
      executable: nodeExecutable,
      command: nodeExecutable + ' ' + vite + ' --host 127.0.0.1 --port 1420 --strictPort',
      cwd: desktop,
      started: 'Tue Nov 10 10:00:01 2026',
      alive: true,
    },
  ];
  const signals = [];
  const execute = (cmd, args) => {
    if (cmd === 'lsof' && args.includes('-t')) {
      const port = Number(args.find((arg) => arg.startsWith('-iTCP:')).slice(6));
      return records
        .filter((record) => record.port === port && record.alive)
        .map((record) => record.pid)
        .join('\n');
    }
    const record = records.find(
      (record) => record.pid === Number(args[args.indexOf('-p') + 1]) && record.alive,
    );
    if (!record) return '';
    if (cmd === 'lsof') return `p${record.pid}\nfcwd\nn${record.cwd}`;
    return { 'comm=': record.executable, 'command=': record.command, 'lstart=': record.started }[
      args.at(-1)
    ];
  };
  const options = {
    projectRoot: root,
    execute,
    signal: (pid) => {
      signals.push(pid);
      records.find((record) => record.pid === pid).alive = false;
    },
    pause: async () => {},
    lockExists: () => false,
  };
  return {
    root,
    records,
    signals,
    options,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('stops only identified API and Vite listeners and waits for the launcher lock to disappear', async () => {
  const f = fixture();
  try {
    let checks = 0;
    f.options.lockExists = () => ++checks < 3;
    assert.equal(await stopDemoProcesses(f.options), 2);
    assert.deepEqual(f.signals, [12345, 12346]);
    assert.equal(checks, 3);
    assert.equal(await stopDemoProcesses(f.options), 0);
  } finally {
    f.close();
  }
});

test('refuses every stop when either port belongs to another project', async () => {
  const f = fixture();
  try {
    f.records[1].cwd = tmpdir();
    await assert.rejects(stopDemoProcesses(f.options), /non reconnu/);
    assert.deepEqual(f.signals, []);
    assert.ok(f.records.every((record) => record.alive));
  } finally {
    f.close();
  }
});

test('refuses unrelated Node commands even when their working directory is this checkout', async () => {
  const f = fixture();
  try {
    const record = f.records[0];
    assert.equal(
      demoProcessRole(
        { ...record, command: record.executable + ' scripts/another-project.mjs' },
        f.root,
      ),
      null,
    );
    assert.equal(
      demoProcessRole(
        { ...record, executable: '/bin/sh', command: '/bin/sh apps/api/dist/main.js' },
        f.root,
      ),
      null,
    );
    assert.equal(demoProcessRole(record, f.root), 'API');
  } finally {
    f.close();
  }
});

test('rechecks process identity before signaling to detect a reused PID', async () => {
  const f = fixture();
  try {
    const original = f.options.execute;
    let count = 0;
    f.options.execute = (cmd, args) => {
      if (cmd === 'ps' && args.includes('lstart=') && args.includes('12345'))
        return String(++count);
      return original(cmd, args);
    };
    await assert.rejects(stopDemoProcesses(f.options), /a changé/);
    assert.deepEqual(f.signals, []);
  } finally {
    f.close();
  }
});

test('does not escalate to a forced kill or remove a lock when graceful shutdown fails', async () => {
  const f = fixture();
  try {
    f.options.signal = (pid) => f.signals.push(pid);
    await assert.rejects(stopDemoProcesses(f.options), /aucun arrêt forcé/);
    assert.deepEqual(f.signals, [12345, 12346]);
    assert.ok(f.records.every((record) => record.alive));
  } finally {
    f.close();
  }
});
