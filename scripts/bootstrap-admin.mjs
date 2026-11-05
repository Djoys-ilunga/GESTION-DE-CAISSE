import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { z } = require('zod');
require('dotenv').config({ path: new URL('../.env', import.meta.url), quiet: true });
const { PrismaService } = require('./dist/prisma.service.js');
const { PasswordService } = require('./dist/auth/password.service.js');
const { installRoles } = require('./dist/auth/admin.service.js');
const { randomUUID } = await import('node:crypto');
const args = process.argv.slice(2),
  option = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
const configFile = option('--config');
if (!configFile) {
  console.error('Usage : pnpm setup:admin -- --config /chemin/initialisation.json');
  process.exit(1);
}
async function readPassword() {
  if (args.includes('--password-stdin')) {
    let value = '';
    for await (const chunk of process.stdin) {
      value += chunk.toString();
      if (Buffer.byteLength(value) > 512) throw new Error('PASSWORD_INVALID');
    }
    return value.replace(/\r?\n$/, '');
  }
  if (!process.stdin.isTTY) throw new Error('INTERACTIVE_TERMINAL_REQUIRED');
  let muted = true;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const terminal = createInterface({ input: process.stdin, output, terminal: true });
  process.stdout.write('Mot de passe initial (12 caractères minimum, saisie masquée) : ');
  try {
    return await terminal.question('');
  } finally {
    terminal.history = [];
    terminal.close();
    muted = false;
    process.stdout.write('\n');
  }
}
const schema = z
  .object({
    companyCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9][A-Z0-9-]{2,31}$/),
    companyName: z.string().trim().min(2).max(160),
    adminEmail: z
      .email()
      .max(254)
      .transform((v) => v.toLowerCase()),
    adminName: z.string().trim().min(2).max(160),
  })
  .strict();
let db;
try {
  const input = schema.parse(JSON.parse(readFileSync(resolve(configFile), 'utf8')));
  const password = z
    .string()
    .min(12)
    .max(128)
    .parse(await readPassword());
  const hash = await new PasswordService().hash(password);
  db = new PrismaService();
  await db.$connect();
  await db.$transaction(
    async (tx) => {
      if (
        (await tx.company.findUnique({ where: { code: input.companyCode } })) ||
        (await tx.user.findUnique({ where: { email: input.adminEmail } }))
      )
        throw new Error('ALREADY_EXISTS');
      const companyId = randomUUID(),
        agencyId = randomUUID(),
        registerId = randomUUID(),
        userId = randomUUID(),
        memberId = randomUUID();
      await tx.company.create({
        data: { id: companyId, code: input.companyCode, name: input.companyName },
      });
      await installRoles(tx, companyId);
      await tx.agency.create({
        data: { id: agencyId, companyId, code: 'PRINCIPALE', name: 'Agence principale' },
      });
      await tx.cashRegister.create({
        data: {
          id: registerId,
          companyId,
          agencyId,
          code: 'PRINCIPALE',
          name: 'Caisse principale',
        },
      });
      await tx.treasuryAccount.createMany({
        data: ['CDF', 'USD'].flatMap((currency) => [
          {
            id: randomUUID(),
            companyId,
            agencyId,
            cashRegisterId: registerId,
            code: 'CAISSE',
            currency,
            kind: 'TREASURY',
          },
          {
            id: randomUUID(),
            companyId,
            agencyId,
            code: 'CONTREPARTIE',
            currency,
            kind: 'CLEARING',
          },
        ]),
      });
      await tx.user.create({
        data: {
          id: userId,
          email: input.adminEmail,
          displayName: input.adminName,
          mustChangePassword: true,
        },
      });
      await tx.userCredential.create({ data: { userId, passwordHash: hash } });
      await tx.companyMember.create({ data: { id: memberId, companyId, userId } });
      const role = await tx.role.findUniqueOrThrow({
        where: { companyId_code: { companyId, code: 'ADMINISTRATOR' } },
      });
      await tx.memberRole.create({ data: { companyId, memberId, roleId: role.id } });
      await tx.agencyGrant.create({ data: { companyId, memberId, agencyId } });
      await tx.cashRegisterGrant.create({
        data: { companyId, memberId, agencyId, cashRegisterId: registerId },
      });
      await tx.authEvent.create({
        data: {
          id: randomUUID(),
          companyId,
          actorId: userId,
          subjectId: userId,
          code: 'USER_CREATED',
        },
      });
    },
    { timeout: 15000 },
  );
  console.info(
    'Entreprise et administrateur initial créés. Le mot de passe doit être renouvelé à la première connexion. Aucun mouvement financier n’a été créé.',
  );
} catch {
  console.error(
    'Initialisation refusée. Vérifier les migrations, la configuration, les champs et l’absence d’entreprise/utilisateur déjà existants. Aucun secret n’est affiché.',
  );
  process.exitCode = 1;
} finally {
  await db?.$disconnect();
}
