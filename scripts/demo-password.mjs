// Personalize only the local demo administrator through the authenticated API.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateDemoState } from './demo-macos.mjs';

const directory = fileURLToPath(new URL('../../scratch/caissepro-demo/', import.meta.url));
const email = 'admin@demo.caissepro.test';
const marker = email + ' : ADMINISTRATOR (mot de passe personnalisé)';
const base = 'http://127.0.0.1:3001/api/v1';

async function readPassword(label) {
  if (!process.stdin.isTTY)
    throw new Error('Utilisez une nouvelle fenêtre de Terminal interactive.');
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const terminal = createInterface({
    input: process.stdin,
    output,
    terminal: true,
    historySize: 0,
  });
  const abort = new AbortController();
  terminal.once('SIGINT', () => abort.abort());
  process.stdout.write(label + ' (saisie masquée) : ');
  try {
    return await terminal.question('', { signal: abort.signal });
  } finally {
    terminal.history = [];
    terminal.close();
    output.end();
    process.stdout.write('\n');
  }
}

export async function changeDemoPassword({
  dataDirectory = directory,
  prompt = readPassword,
  request = fetch,
} = {}) {
  let state, text;
  const accessFile = join(dataDirectory, 'acces-prives.txt');
  try {
    state = JSON.parse(readFileSync(join(dataDirectory, 'state.json'), 'utf8'));
    validateDemoState(state, new URL(state.url).port || '5432');
    text = readFileSync(accessFile, 'utf8');
  } catch {
    throw new Error(
      'Démonstration locale non préparée ou état invalide. Conservez les fichiers et relancez le lanceur.',
    );
  }
  const admin = state.users?.find((user) => user.email === email && user.role === 'ADMINISTRATOR');
  if (!admin?.id || !state.companyId || !/^Entreprise : CAISSEPRO-DEMO\r?$/m.test(text))
    throw new Error('Le compte administrateur de cette démonstration est introuvable.');
  const deviceId = randomUUID();

  const call = async (path, body, token) => {
    let response;
    try {
      response = await request(base + path, {
        method: body ? 'POST' : 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: 'Bearer ' + token, 'X-CaissePro-Device': deviceId } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new Error(
        path === '/auth/password'
          ? 'Résultat du changement inconnu. Essayez le nouveau mot de passe dans CaissePro avant une nouvelle tentative.'
          : 'API de démonstration inaccessible. Gardez le Terminal de lancement et Docker Desktop ouverts.',
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) throw new Error('Mot de passe actuel ou session non valide.');
      if (response.status === 429)
        throw new Error('Action temporairement limitée. Réessayez plus tard.');
      throw new Error('Le serveur a refusé la demande ; aucun succès n’est confirmé.');
    }
    try {
      return await response.json();
    } catch {
      throw new Error('Réponse serveur invalide ; aucun succès n’est confirmé.');
    }
  };

  const health = await call('/health/ready');
  if (
    health.service !== 'caissepro-api' ||
    health.deploymentId !== 'caissepro-demo' ||
    health.protocolVersion !== 1 ||
    health.status !== 'ready'
  )
    throw new Error('Le serveur local ne correspond pas à la démonstration attendue.');
  const original = text
    .match(/^Mot de passe aléatoire local des comptes démo : (.+)\r?$/m)?.[1]
    ?.replace(/\r$/, '');
  const current =
    text.includes(marker) || !original
      ? await prompt('Mot de passe actuel de l’administrateur')
      : original;
  const next = await prompt('Choisissez votre nouveau mot de passe (12 caractères minimum)');
  const confirmation = await prompt('Confirmez votre nouveau mot de passe');
  if (next.length < 12 || next.length > 128 || next === current || next !== confirmation)
    throw new Error(
      'Utilisez 12 à 128 caractères, différents du mot de passe actuel, et deux saisies identiques. Aucun changement envoyé.',
    );

  let token;
  try {
    const session = await call('/auth/login', {
      companyCode: 'CAISSEPRO-DEMO',
      email,
      password: current,
      deviceId,
    });
    token = session.accessToken;
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(token ?? '') ||
      session.profile?.company?.id !== state.companyId ||
      session.profile?.company?.code !== 'CAISSEPRO-DEMO' ||
      session.profile?.user?.id !== admin.id ||
      session.profile?.user?.email !== email
    )
      throw new Error('La session ne correspond pas au compte de démonstration attendu.');
    const result = await call(
      '/auth/password',
      { currentPassword: current, newPassword: next },
      token,
    );
    if (result.ok !== true)
      throw new Error(
        'Changement non confirmé. Essayez le nouveau mot de passe avant une nouvelle tentative.',
      );
    try {
      const latest = readFileSync(accessFile, 'utf8');
      if (
        !/^admin@demo\.caissepro\.test : ADMINISTRATOR(?: \(mot de passe personnalisé\))?\r?$/m.test(
          latest,
        )
      )
        throw new Error('ACCESS_FILE_CHANGED');
      writeFileSync(
        accessFile,
        latest.replace(
          /^admin@demo\.caissepro\.test : ADMINISTRATOR(?: \(mot de passe personnalisé\))?\r?$/m,
          marker,
        ),
        { mode: 0o600 },
      );
      return { fileUpdated: true };
    } catch {
      return { fileUpdated: false };
    }
  } finally {
    if (token) await call('/auth/logout', {}, token).catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) {
    console.error(
      'Utilisation : pnpm demo:password. Ne mettez aucun mot de passe dans la commande.',
    );
    process.exitCode = 1;
  } else {
    changeDemoPassword()
      .then(({ fileUpdated }) => {
        console.info(
          'Mot de passe administrateur modifié. Reconnectez-vous dans CaissePro avec celui que vous venez de choisir.',
        );
        console.info(
          'Les autres comptes conservent leur mot de passe initial. Le nouveau mot de passe n’a pas été enregistré dans un fichier.',
        );
        if (!fileUpdated)
          console.info(
            'Le fichier d’accès initial n’a pas pu être annoté : son ancien mot de passe ne convient plus à l’administrateur.',
          );
      })
      .catch((error) => {
        console.error(error.name === 'AbortError' ? 'Modification interrompue.' : error.message);
        process.exitCode = 1;
      });
  }
}
