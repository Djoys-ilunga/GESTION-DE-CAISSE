import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { changeDemoPassword } from '../../scripts/demo-password.mjs';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'caissepro-password-'));
  const old = randomBytes(24).toString('base64url');
  const next = randomBytes(24).toString('base64url');
  const companyId = randomUUID(),
    adminId = randomUUID(),
    token = randomBytes(32).toString('base64url');
  const state = {
    ready: true,
    port: 3001,
    companyId,
    url: 'postgresql://test:test@127.0.0.1:55432/caissepro_demo_123abc',
    runtimeUrl: 'postgresql://runtime:test@127.0.0.1:55432/caissepro_demo_123abc',
    users: [{ id: adminId, email: 'admin@demo.caissepro.test', role: 'ADMINISTRATOR' }],
  };
  const text = `DÉMONSTRATION FICTIVE UNIQUEMENT\nEntreprise : CAISSEPRO-DEMO\nMot de passe aléatoire local des comptes démo : ${old}\nadmin@demo.caissepro.test : ADMINISTRATOR\ncaisse@demo.caissepro.test : CASHIER\n`;
  writeFileSync(join(directory, 'state.json'), JSON.stringify(state));
  writeFileSync(join(directory, 'acces-prives.txt'), text);
  const health = {
    service: 'caissepro-api',
    protocolVersion: 2,
    deploymentId: 'caissepro-demo',
    status: 'ready',
  };
  const profile = {
    company: { id: companyId, code: 'CAISSEPRO-DEMO' },
    user: { id: adminId, email: 'admin@demo.caissepro.test' },
  };
  const calls = [],
    prompts = [],
    values = [next, next];
  const options = {
    dataDirectory: directory,
    prompt: async (label) => {
      prompts.push(label);
      return values.shift();
    },
    request: async (url, init) => {
      calls.push({ url, ...init });
      return Response.json(
        url.endsWith('/ready')
          ? health
          : url.endsWith('/login')
            ? { accessToken: token, profile }
            : { ok: true },
      );
    },
  };
  return {
    directory,
    old,
    next,
    text,
    state,
    health,
    profile,
    token,
    calls,
    prompts,
    values,
    options,
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test('changes only the matching local demo admin through authentication and saves no new secret', async () => {
  const f = fixture();
  try {
    assert.deepEqual(await changeDemoPassword(f.options), { fileUpdated: true });
    assert.equal(f.prompts.length, 2);
    const login = f.calls.find(({ url }) => url.endsWith('/login'));
    const change = f.calls.find(({ url }) => url.endsWith('/password'));
    assert.equal(JSON.parse(login.body).password, f.old);
    assert.equal(JSON.parse(login.body).email, 'admin@demo.caissepro.test');
    assert.deepEqual(JSON.parse(change.body), { currentPassword: f.old, newPassword: f.next });
    assert.equal(change.headers.Authorization, 'Bearer ' + f.token);
    assert.equal(change.headers['X-CaissePro-Device'], JSON.parse(login.body).deviceId);
    assert.equal(f.calls[0].headers['Content-Type'], undefined);
    assert.equal(f.calls[0].headers.Accept, 'application/json');
    assert.equal(login.headers['Content-Type'], 'application/json');
    assert.ok(
      f.calls.every(
        ({ url, redirect }) =>
          url.startsWith('http://127.0.0.1:3001/api/v1/') && redirect === 'error',
      ),
    );
    assert.ok(f.calls.at(-1).url.endsWith('/logout'));
    const saved = readFileSync(join(f.directory, 'acces-prives.txt'), 'utf8');
    assert.ok(saved.includes('ADMINISTRATOR (mot de passe personnalisé)'));
    assert.ok(saved.includes(f.old));
    assert.ok(saved.includes('caisse@demo.caissepro.test : CASHIER'));
    assert.ok(!saved.includes(f.next) && !saved.includes(f.token));
    assert.equal(readFileSync(join(f.directory, 'state.json'), 'utf8'), JSON.stringify(f.state));
    f.values.push(f.next, 'Another personal password', 'Another personal password');
    await changeDemoPassword(f.options);
    assert.equal(f.prompts.length, 5);
  } finally {
    f.close();
  }
});

test('refuses the wrong deployment before requesting or transmitting a password', async () => {
  const f = fixture();
  try {
    f.health.deploymentId = 'production';
    await assert.rejects(changeDemoPassword(f.options), /ne correspond pas/);
    assert.equal(f.prompts.length, 0);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].body, undefined);
  } finally {
    f.close();
  }
});

test('identifies a readiness failure before asking for credentials without printing response contents', async () => {
  for (const status of [400, 404, 500, 503]) {
    const f = fixture();
    try {
      f.options.request = async (url, init) => {
        f.calls.push({ url, ...init });
        return Response.json({ message: f.old }, { status });
      };
      await assert.rejects(changeDemoPassword(f.options), (error) => {
        assert.ok(error.message.includes('Vérification de disponibilité du serveur'));
        assert.ok(error.message.includes('HTTP ' + status));
        assert.ok(!error.message.includes(f.old));
        return true;
      });
      assert.equal(f.prompts.length, 0);
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0].body, undefined);
      assert.equal(readFileSync(join(f.directory, 'acces-prives.txt'), 'utf8'), f.text);
    } finally {
      f.close();
    }
  }
});

test('identifies password rejection while preserving the access file and closing the temporary session', async () => {
  const f = fixture();
  try {
    const request = f.options.request;
    f.options.request = async (url, init) => {
      if (url.endsWith('/password')) {
        f.calls.push({ url, ...init });
        return Response.json({ message: f.next }, { status: 403 });
      }
      return request(url, init);
    };
    await assert.rejects(changeDemoPassword(f.options), (error) => {
      assert.match(error.message, /Modification du mot de passe : HTTP 403/);
      assert.ok(!error.message.includes(f.next));
      return true;
    });
    assert.equal(f.calls.filter(({ url }) => url.endsWith('/password')).length, 1);
    assert.ok(f.calls.at(-1).url.endsWith('/logout'));
    assert.equal(readFileSync(join(f.directory, 'acces-prives.txt'), 'utf8'), f.text);
  } finally {
    f.close();
  }
});

test('refuses a different authenticated company or user and logs out the temporary session', async () => {
  const f = fixture();
  try {
    f.profile.company.id = randomUUID();
    await assert.rejects(changeDemoPassword(f.options), /ne correspond pas/);
    assert.ok(!f.calls.some(({ url }) => url.endsWith('/password')));
    assert.ok(f.calls.at(-1).url.endsWith('/logout'));
    assert.equal(readFileSync(join(f.directory, 'acces-prives.txt'), 'utf8'), f.text);
  } finally {
    f.close();
  }
});

test('rejects short, unchanged and mismatched choices before authenticating', async () => {
  for (const choose of [
    () => ['short', 'short'],
    (f) => [f.old, f.old],
    () => ['A long personal password', 'A different password'],
  ]) {
    const f = fixture();
    try {
      f.values.splice(0, 2, ...choose(f));
      await assert.rejects(changeDemoPassword(f.options), /Aucun changement envoyé/);
      assert.equal(f.calls.length, 1);
      assert.equal(readFileSync(join(f.directory, 'acces-prives.txt'), 'utf8'), f.text);
    } finally {
      f.close();
    }
  }
});

test('does not replay a password change with an uncertain response or annotate it as confirmed', async () => {
  const f = fixture();
  try {
    const request = f.options.request;
    f.options.request = async (url, init) => {
      if (url.endsWith('/password')) {
        f.calls.push({ url, ...init });
        throw new Error('connection lost');
      }
      return request(url, init);
    };
    await assert.rejects(changeDemoPassword(f.options), /Résultat du changement inconnu/);
    assert.equal(f.calls.filter(({ url }) => url.endsWith('/password')).length, 1);
    assert.ok(f.calls.at(-1).url.endsWith('/logout'));
    assert.equal(readFileSync(join(f.directory, 'acces-prives.txt'), 'utf8'), f.text);
  } finally {
    f.close();
  }
});
