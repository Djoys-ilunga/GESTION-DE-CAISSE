import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseEnv } from 'node:util';
import {
  databasePort,
  localDockerEndpoint,
  validateDemoState,
  validateLocalConfig,
  withDatabasePort,
} from '../../scripts/demo-macos.mjs';

const env = {
  DATABASE_URL: 'postgresql://caissepro:local-test@127.0.0.1:5432/caissepro?schema=public',
  POSTGRES_PASSWORD: 'local-test',
};
const state = {
  ready: true,
  port: 3001,
  url: 'postgresql://caissepro:local-test@127.0.0.1:5432/caissepro_demo_123abc?schema=public',
  runtimeUrl: 'postgresql://runtime:local-test@127.0.0.1:5432/caissepro_demo_123abc?schema=public',
};

test('accepts the expected local Compose configuration and isolated demo', () => {
  validateLocalConfig(env);
  validateDemoState(state);
  assert.equal(
    localDockerEndpoint('unix:///Users/demo/.docker/run/docker.sock'),
    'unix:///Users/demo/.docker/run/docker.sock',
  );
});

test('refuses remote, redirected or unrelated database connections without revealing credentials', () => {
  for (const value of [
    env.DATABASE_URL.replace('127.0.0.1', 'server.example'),
    env.DATABASE_URL.replace('/caissepro?', '/production?'),
    env.DATABASE_URL.replace(':5432', ':15432'),
    env.DATABASE_URL + '&host=server.example',
    env.DATABASE_URL + '&service=production',
    env.DATABASE_URL.replace('local-test', 'secret-value'),
    'not-a-url',
  ]) {
    assert.throws(
      () => validateLocalConfig({ ...env, DATABASE_URL: value }),
      (error) => {
        assert.ok(!error.message.includes('secret-value'));
        return true;
      },
    );
  }
});

test('refuses remote Docker endpoints', () => {
  for (const endpoint of ['ssh://server', 'tcp://127.0.0.1:2375', 'https://server', ''])
    assert.throws(() => localDockerEndpoint(endpoint));
});

test('persists a custom local database port without changing passwords or unrelated settings', () => {
  const original = `# Local configuration\nDATABASE_URL=${env.DATABASE_URL}\nPOSTGRES_PASSWORD=${env.POSTGRES_PASSWORD}\nVITE_API_BASE_URL=http://127.0.0.1:3000\n`;
  const updated = withDatabasePort(original, '5433');
  const config = parseEnv(updated);
  validateLocalConfig(config);
  assert.equal(new URL(config.DATABASE_URL).port, '5433');
  assert.equal(config.POSTGRES_PORT, '5433');
  assert.equal(config.POSTGRES_PASSWORD, env.POSTGRES_PASSWORD);
  assert.equal(config.VITE_API_BASE_URL, 'http://127.0.0.1:3000');
  assert.ok(updated.startsWith('# Local configuration\n'));
  assert.equal(withDatabasePort(updated, '5433'), updated);
  const custom = {
    ...state,
    url: state.url.replace(':5432', ':5433'),
    runtimeUrl: state.runtimeUrl.replace(':5432', ':5433'),
  };
  validateDemoState(custom, '5433');
  assert.throws(() => validateDemoState(custom, '5432'));
  assert.throws(() => validateLocalConfig({ ...config, POSTGRES_PORT: '5432' }));
  assert.throws(() => withDatabasePort(original.replace('127.0.0.1', 'remote.example'), '5433'));
});

test('rejects invalid and reserved database ports', () => {
  for (const port of ['0', '80', '1023', '65536', '05433', '5433:5432', '3001', '1420', 'abc'])
    assert.throws(() => databasePort(port));
});

test('refuses incomplete, inconsistent or non-local saved demo state', () => {
  for (const candidate of [
    { ...state, ready: false },
    { ...state, port: 3000 },
    { ...state, url: state.url.replace('caissepro_demo_123abc', 'caissepro') },
    { ...state, runtimeUrl: state.runtimeUrl.replace('127.0.0.1', 'server.example') },
    { ...state, runtimeUrl: state.runtimeUrl.replace('123abc', '456def') },
    { ...state, runtimeUrl: state.runtimeUrl + '&host=server.example' },
  ])
    assert.throws(() => validateDemoState(candidate));
});

test(
  'refuses launching outside macOS before invoking setup or database commands',
  {
    skip: process.platform === 'darwin',
  },
  () => {
    const result = spawnSync(process.execPath, ['scripts/demo-macos.mjs'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /nécessite macOS/);
    assert.equal(result.stdout, '');
  },
);

// Command doubles verify orchestration on Linux; they do not qualify native macOS.
test(
  'local launch waits for the API, passes public native settings and stops its own server',
  {
    skip: process.platform === 'win32',
  },
  () => {
    const fixture = mkdtempSync(join(tmpdir(), 'caissepro-mac-launch-'));
    try {
      const project = join(fixture, 'project with spaces');
      const scripts = join(project, 'scripts');
      const bin = join(fixture, 'bin');
      const data = join(fixture, 'scratch', 'caissepro-demo');
      const apiDirectory = join(project, 'apps/api/dist');
      for (const directory of [scripts, bin, data, apiDirectory])
        mkdirSync(directory, { recursive: true });
      const launcher = join(scripts, 'demo-macos.mjs');
      copyFileSync(new URL('../../scripts/demo-macos.mjs', import.meta.url), launcher);
      writeFileSync(
        join(project, '.env'),
        `DATABASE_URL=${env.DATABASE_URL}\nPOSTGRES_PASSWORD=${env.POSTGRES_PASSWORD}\n`,
      );
      const savedState = JSON.stringify(state);
      writeFileSync(join(data, 'state.json'), savedState);
      writeFileSync(join(data, 'acces-prives.txt'), 'Synthetic test data only.');
      const platform = join(fixture, 'platform.mjs');
      writeFileSync(platform, "Object.defineProperty(process, 'platform', { value: 'darwin' });");
      const stub = `#!${process.execPath}
const {appendFileSync}=require('node:fs');
const {basename}=require('node:path');
const cmd=basename(process.argv[1]), args=process.argv.slice(2);
appendFileSync(process.env.MAC_LAUNCH_TEST_LOG,JSON.stringify({cmd,args,api:process.env.VITE_API_BASE_URL,deployment:process.env.VITE_API_DEPLOYMENT_ID,host:process.env.DOCKER_HOST,override:process.env.CAISSEPRO_DEMO_DB_HOST})+'\\n');
if(cmd==='pnpm' && args[0]==='--version') console.log('11.25.0');
if(cmd==='pnpm' && args[0]==='dev:desktop') {
  if(process.env.MAC_LAUNCH_TEST_SIGNAL) {
    const {readFileSync}=require('node:fs');
    setTimeout(()=>process.kill(Number(readFileSync(process.env.MAC_LAUNCH_TEST_SIGNAL==='interrupt'?process.env.MAC_LAUNCH_TEST_OWNER:process.env.MAC_LAUNCH_TEST_PID,'utf8')),process.env.MAC_LAUNCH_TEST_SIGNAL==='interrupt'?'SIGINT':'SIGTERM'),200);
    setInterval(()=>{},1000);
  } else setTimeout(()=>process.exit(Number(process.env.MAC_LAUNCH_TEST_DESKTOP_EXIT || 0)),200);
}
if(cmd==='docker' && args[0]==='context') console.log(process.env.MAC_LAUNCH_TEST_ENDPOINT);
`;
      for (const cmd of ['pnpm', 'xcode-select', 'xcrun', 'perl', 'rustup', 'docker', 'open'])
        writeFileSync(join(bin, cmd), stub, { mode: 0o700 });
      writeFileSync(
        join(apiDirectory, 'main.js'),
        `
import {createServer} from 'node:http';
import {writeFileSync} from 'node:fs';
writeFileSync(process.env.MAC_LAUNCH_TEST_PID,String(process.pid));
writeFileSync(process.env.MAC_LAUNCH_TEST_OWNER,String(process.ppid));
if(process.env.API_DEPLOYMENT_ID!=='caissepro-demo'||process.env.API_PORT!=='3001'||new URL(process.env.DATABASE_URL).username!=='runtime') throw new Error('Incorrect demo API environment');
const server=createServer((req,res)=>{res.statusCode=req.url==='/api/v1/health/ready'?200:404;res.end();});
server.listen(3001,'127.0.0.1');
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
`,
      );
      const log = join(fixture, 'commands.jsonl');
      const runEnv = {
        ...process.env,
        PATH: bin + ':' + process.env.PATH,
        DOCKER_CONTEXT: 'test-local',
        MAC_LAUNCH_TEST_ENDPOINT: 'unix:///test/docker.sock',
        MAC_LAUNCH_TEST_LOG: log,
        MAC_LAUNCH_TEST_PID: join(fixture, 'api.pid'),
        MAC_LAUNCH_TEST_OWNER: join(fixture, 'owner.pid'),
        CAISSEPRO_DEMO_DB_HOST: 'remote.invalid',
      };
      for (const key of ['DATABASE_URL', 'POSTGRES_PASSWORD']) delete runEnv[key];
      const run = (args = []) =>
        spawnSync(process.execPath, ['--import', platform, launcher, ...args], {
          cwd: project,
          env: runEnv,
          encoding: 'utf8',
          timeout: 15000,
        });
      let result = run(['--check']);
      assert.equal(result.status, 0, result.stderr);
      let commands = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
      assert.ok(
        !commands.some(({ args }) => ['install', 'db:up', 'demo:prepare'].includes(args[0])),
      );
      runEnv.MAC_LAUNCH_TEST_ENDPOINT = 'ssh://remote.invalid';
      result = run();
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Docker distant refusé/);
      runEnv.MAC_LAUNCH_TEST_ENDPOINT = 'unix:///test/docker.sock';
      result = run();
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(join(data, 'state.json'), 'utf8'), savedState);
      assert.ok(!existsSync(join(data, 'lancement-macos.lock')));
      assert.throws(
        () => process.kill(Number(readFileSync(runEnv.MAC_LAUNCH_TEST_PID, 'utf8')), 0),
        { code: 'ESRCH' },
      );
      const originalConfig = readFileSync(join(project, '.env'), 'utf8');
      result = run(['--db-port=5433']);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Une démo existe sur un autre port/);
      assert.equal(readFileSync(join(project, '.env'), 'utf8'), originalConfig);
      commands = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
      const desktop = commands.find(({ cmd, args }) => cmd === 'pnpm' && args[0] === 'dev:desktop');
      assert.equal(desktop.api, 'http://127.0.0.1:3001');
      assert.equal(desktop.deployment, 'caissepro-demo');
      assert.equal(desktop.host, 'unix:///test/docker.sock');
      assert.equal(desktop.override, undefined);
      assert.ok(commands.some(({ cmd, args }) => cmd === 'open' && args[0] === '-t'));
      assert.ok(!commands.some(({ args }) => args[0] === 'db:deploy' || args.includes('down')));
      runEnv.MAC_LAUNCH_TEST_DESKTOP_EXIT = '2';
      result = run();
      assert.equal(result.status, 1);
      assert.match(result.stderr, /lancement natif a échoué/);
      assert.ok(!existsSync(join(data, 'lancement-macos.lock')));
      assert.equal(readFileSync(join(data, 'state.json'), 'utf8'), savedState);
      assert.throws(
        () => process.kill(Number(readFileSync(runEnv.MAC_LAUNCH_TEST_PID, 'utf8')), 0),
        { code: 'ESRCH' },
      );
      delete runEnv.MAC_LAUNCH_TEST_DESKTOP_EXIT;
      const customState = {
        ...state,
        url: state.url.replace(':5432', ':5433'),
        runtimeUrl: state.runtimeUrl.replace(':5432', ':5433'),
      };
      writeFileSync(join(data, 'state.json'), JSON.stringify(customState));
      result = run(['--db-port=5433', '--check']);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(join(project, '.env'), 'utf8'), originalConfig);
      result = run(['--db-port=5433']);
      assert.equal(result.status, 0, result.stderr);
      const customConfig = parseEnv(readFileSync(join(project, '.env'), 'utf8'));
      assert.equal(customConfig.POSTGRES_PORT, '5433');
      assert.equal(new URL(customConfig.DATABASE_URL).port, '5433');
      result = run(['--check']);
      assert.equal(result.status, 0, result.stderr);
      runEnv.MAC_LAUNCH_TEST_SIGNAL = 'interrupt';
      result = run();
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stderr, /serveur démo s’est arrêté/);
      assert.ok(!existsSync(join(data, 'lancement-macos.lock')));
      assert.throws(
        () => process.kill(Number(readFileSync(runEnv.MAC_LAUNCH_TEST_PID, 'utf8')), 0),
        { code: 'ESRCH' },
      );
      runEnv.MAC_LAUNCH_TEST_SIGNAL = 'api-exit';
      result = run();
      assert.equal(result.status, 1);
      assert.match(result.stderr, /serveur démo s’est arrêté de façon inattendue/);
      assert.match(result.stderr, /api-macos.log/);
      assert.ok(!existsSync(join(data, 'lancement-macos.lock')));
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  },
);
