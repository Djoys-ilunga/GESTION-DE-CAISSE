import 'reflect-metadata';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app';
import { PrismaService } from '../../src/prisma.service';
import { PasswordService } from '../../src/auth/password.service';
import { AuthService } from '../../src/auth/auth.service';
import { installRoles } from '../../src/auth/admin.service';
import { CentralAccess } from '../../src/data/central-access';
import { LedgerService } from '../../src/data/ledger.service';
import { fixture } from './fixture';
describe('Authentification HTTP et PostgreSQL réels', () => {
  let app: INestApplication,
    db: PrismaService,
    f: Awaited<ReturnType<typeof fixture>>,
    companyCode: string,
    hash: string;
  const password = 'Phrase-de-test!CaissePro-2026';
  beforeAll(async () => {
    if (
      process.env.CAISSEPRO_INTEGRITY_TEST !== '1' ||
      !/^\/caissepro_test_[0-9a-f]+$/.test(new URL(process.env.DATABASE_URL!).pathname)
    )
      throw new Error('Base jetable obligatoire.');
    db = new PrismaService();
    await db.$connect();
    hash = await new PasswordService().hash(password);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(db)
      .compile();
    app = module.createNestApplication({ logger: false });
    configureApp(app, ['http://127.0.0.1:1420']);
    await app.listen(0, '127.0.0.1');
  });
  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
  });
  beforeEach(async () => {
    f = await fixture(db);
    companyCode = (await db.company.findUniqueOrThrow({ where: { id: f.companyId } })).code;
    await db.$transaction((tx) => installRoles(tx, f.companyId));
    for (const [userId, code] of [
      [f.userId, 'CASHIER'],
      [f.approverId, 'ADMINISTRATOR'],
      [f.viewerId, 'AUDITOR'],
    ]) {
      const member = await db.companyMember.findUniqueOrThrow({
        where: { companyId_userId: { companyId: f.companyId, userId: userId! } },
      });
      const role = await db.role.findUniqueOrThrow({
        where: { companyId_code: { companyId: f.companyId, code: code! } },
      });
      await db.memberRole.deleteMany({ where: { memberId: member.id } });
      await db.memberRole.create({
        data: { companyId: f.companyId, memberId: member.id, roleId: role.id },
      });
      await db.userCredential.create({ data: { userId: userId!, passwordHash: hash } });
    }
  });
  async function login(
    userId = f.userId,
    deviceId = randomUUID(),
    email = `${userId}@example.test`,
  ) {
    const r = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, companyCode, password, deviceId })
      .expect(201);
    return { token: r.body.accessToken as string, profile: r.body.profile, deviceId };
  }
  const headers = (session: { token: string; deviceId: string }) => ({
    Authorization: `Bearer ${session.token}`,
    'X-CaissePro-Device': session.deviceId,
  });
  it('provisionne un premier administrateur sans mot de passe sur disque ni mouvement financier', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'caissepro-bootstrap-'));
    const code = 'BOOT-' + randomUUID().slice(0, 8).toUpperCase(),
      email = `${randomUUID()}@example.test`,
      configuration = join(directory, 'initialisation.json');
    try {
      writeFileSync(
        configuration,
        JSON.stringify({
          companyCode: code,
          companyName: 'Entreprise initiale test',
          adminEmail: email,
          adminName: 'Administrateur test',
        }),
        { mode: 0o600 },
      );
      const result = spawnSync(
        process.execPath,
        ['scripts/bootstrap-admin.mjs', '--config', configuration, '--password-stdin'],
        {
          cwd: resolve(__dirname, '../../../..'),
          env: process.env,
          input: password + '\n',
          encoding: 'utf8',
          timeout: 20000,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toContain(password);
      const company = await db.company.findUniqueOrThrow({ where: { code } });
      expect(await db.financialOperation.count({ where: { companyId: company.id } })).toBe(0);
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, companyCode: code, password, deviceId: randomUUID() })
        .expect(201);
      expect(response.body.profile.user.mustChangePassword).toBe(true);
      expect(response.body.profile.roles).toEqual(['ADMINISTRATOR']);
      const again = spawnSync(
        process.execPath,
        ['scripts/bootstrap-admin.mjs', '--config', configuration, '--password-stdin'],
        {
          cwd: resolve(__dirname, '../../../..'),
          env: process.env,
          input: password + '\n',
          encoding: 'utf8',
          timeout: 20000,
        },
      );
      expect(again.status).toBe(1);
      expect(again.stderr).not.toContain(password);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('refuse un jeton présenté pour un autre appareil', async () => {
    const session = await login();
    await request(app.getHttpServer())
      .get('/api/v1/auth/session')
      .set({ Authorization: `Bearer ${session.token}`, 'X-CaissePro-Device': randomUUID() })
      .expect(401);
  });
  it('ouvre une session valide sans stocker le jeton ou le mot de passe en clair', async () => {
    const session = await login();
    expect(session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session.profile.user.id).toBe(f.userId);
    expect(session.profile.roles).toEqual(['CASHIER']);
    expect(session.profile.offlineUntil).toBeTruthy();
    const row = await db.authSession.findUniqueOrThrow({
      where: { id: session.profile.sessionId },
    });
    expect(row.tokenHash).not.toBe(session.token);
    expect(hash).not.toContain(password);
    const r = await request(app.getHttpServer())
      .get('/api/v1/auth/session')
      .set(headers(session))
      .expect(200);
    expect(JSON.stringify(r.body)).not.toMatch(/passwordHash|tokenHash|accessToken/);
  });
  it('renvoie la même erreur pour utilisateur, entreprise ou mot de passe incorrect', async () => {
    const bodies = [
      { email: 'inconnu@example.test', companyCode, password },
      { email: `${f.userId}@example.test`, companyCode: 'INCONNUE', password },
      { email: `${f.userId}@example.test`, companyCode, password: 'incorrect' },
    ];
    const messages = [];
    for (const body of bodies) {
      const r = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ ...body, deviceId: randomUUID() })
        .expect(401);
      messages.push(r.body.message);
    }
    expect(new Set(messages).size).toBe(1);
  });
  it('limite les essais répétés et ne journalise pas les secrets', async () => {
    for (let i = 0; i < 5; i++)
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({
          email: `${f.userId}@example.test`,
          companyCode,
          password: 'incorrect',
          deviceId: randomUUID(),
        })
        .expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: `${f.userId}@example.test`, companyCode, password, deviceId: randomUUID() })
      .expect(429);
    const events = await db.authEvent.findMany({ where: { companyId: f.companyId } });
    expect(events.some((e) => e.code === 'LOGIN_FAILED')).toBe(true);
    expect(JSON.stringify(events)).not.toContain(password);
  });
  it('refuse une route privée sans session et un rôle insuffisant', async () => {
    await request(app.getHttpServer()).get('/api/v1/workspace/balances').expect(401);
    const session = await login();
    await request(app.getHttpServer()).get('/api/v1/admin/users').set(headers(session)).expect(403);
    await request(app.getHttpServer())
      .get('/api/v1/workspace/balances')
      .set(headers(session))
      .expect(200);
  });
  it('révoque immédiatement la session lors de la déconnexion', async () => {
    const session = await login();
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set(headers(session))
      .expect(201);
    await request(app.getHttpServer())
      .get('/api/v1/auth/session')
      .set(headers(session))
      .expect(401);
    expect(
      await db.authEvent.count({ where: { sessionId: session.profile.sessionId, code: 'LOGOUT' } }),
    ).toBe(1);
  });
  it('bloque les données d’une session verrouillée et renouvelle le jeton au déverrouillage', async () => {
    const session = await login();
    await request(app.getHttpServer()).post('/api/v1/auth/lock').set(headers(session)).expect(201);
    await request(app.getHttpServer())
      .get('/api/v1/workspace/balances')
      .set(headers(session))
      .expect(423);
    await request(app.getHttpServer())
      .post('/api/v1/auth/unlock')
      .set(headers(session))
      .send({ password: 'incorrect' })
      .expect(401);
    const unlocked = await request(app.getHttpServer())
      .post('/api/v1/auth/unlock')
      .set(headers(session))
      .send({ password })
      .expect(201);
    expect(unlocked.body.accessToken).not.toBe(session.token);
    await request(app.getHttpServer())
      .get('/api/v1/auth/session')
      .set(headers(session))
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/workspace/balances')
      .set(headers({ ...session, token: unlocked.body.accessToken }))
      .expect(200);
  });
  it('expire une session inactive et inscrit l’événement', async () => {
    const session = await login();
    await db.authSession.update({
      where: { id: session.profile.sessionId },
      data: { idleExpiresAt: new Date(Date.now() - 1000) },
    });
    await request(app.getHttpServer())
      .get('/api/v1/auth/session')
      .set(headers(session))
      .expect(401);
    expect(
      await db.authEvent.count({
        where: { sessionId: session.profile.sessionId, code: 'SESSION_EXPIRED' },
      }),
    ).toBe(1);
  });
  it('refuse un compte révoqué même avec un jeton antérieur valide', async () => {
    const session = await login();
    await db.user.update({ where: { id: f.userId }, data: { active: false } });
    await request(app.getHttpServer())
      .get('/api/v1/auth/session')
      .set(headers(session))
      .expect(401);
  });
  it('révoque les sessions après un changement de rôle ou de périmètre', async () => {
    const cashier = await login(),
      admin = await login(f.approverId);
    const member = await db.companyMember.findUniqueOrThrow({
      where: { companyId_userId: { companyId: f.companyId, userId: f.userId } },
    });
    await request(app.getHttpServer())
      .put(`/api/v1/admin/users/${f.userId}/access`)
      .set(headers(admin))
      .send({
        expectedVersion: member.authorizationVersion,
        access: {
          roles: ['AUDITOR'],
          agencyIds: [f.agencyId],
          cashRegisterIds: [f.registerId],
          active: true,
        },
      })
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/auth/session')
      .set(headers(cashier))
      .expect(401);
    const newSession = await login();
    expect(newSession.profile.roles).toEqual(['AUDITOR']);
    expect(newSession.profile.permissions).not.toContain('expense:pay');
  });
  it('applique les affectations aux caisses également dans les services SQL', async () => {
    const session = await login();
    const member = await db.companyMember.findUniqueOrThrow({
      where: { companyId_userId: { companyId: f.companyId, userId: f.userId } },
    });
    await db.cashRegisterGrant.deleteMany({
      where: { memberId: member.id, cashRegisterId: f.otherRegisterId },
    });
    const result = await request(app.getHttpServer())
      .get('/api/v1/workspace/balances')
      .set(headers(session))
      .expect(200);
    expect(result.body.balances).toHaveLength(2);
    expect(
      result.body.balances.every(
        (r: { cashRegisterId: string }) => r.cashRegisterId === f.registerId,
      ),
    ).toBe(true);
    const access = new CentralAccess(db);
    await expect(
      access.run({ ...f.ctx, sessionId: session.profile.sessionId }, (tx) =>
        access.requireCash(tx, f.ctx, f.otherRegisterId, 'ledger:read'),
      ),
    ).rejects.toThrow('CAISSEPRO_CASH_ACCESS_DENIED');
    await expect(
      new LedgerService(access).requestExpense(
        { ...f.ctx, sessionId: session.profile.sessionId },
        {
          agencyId: f.otherAgencyId,
          accountId: f.otherUsd,
          currency: 'USD',
          amount: '10.00',
          description: 'Caisse non affectée',
        },
      ),
    ).rejects.toThrow('CAISSEPRO_CASH_ACCESS_DENIED');
    expect(await db.expenseRequest.count({ where: { companyId: f.companyId } })).toBe(0);
  });
  it('crée un utilisateur avec renouvellement obligatoire du mot de passe', async () => {
    const admin = await login(f.approverId),
      email = `${randomUUID()}@example.test`;
    const r = await request(app.getHttpServer())
      .post('/api/v1/admin/users')
      .set(headers(admin))
      .send({
        email,
        displayName: 'Nouveau caissier',
        initialPassword: password,
        access: {
          roles: ['CASHIER'],
          agencyIds: [f.agencyId],
          cashRegisterIds: [f.registerId],
          active: true,
        },
      })
      .expect(201);
    expect(JSON.stringify(r.body)).not.toMatch(/passwordHash|initialPassword/);
    const first = await login(r.body.id, randomUUID(), email);
    expect(first.profile.user.mustChangePassword).toBe(true);
    expect(first.profile.offlineUntil).toBeNull();
    await request(app.getHttpServer())
      .get('/api/v1/workspace/balances')
      .set(headers(first))
      .expect(403);
    const nextPassword = 'Nouvelle-phrase!2026CaissePro';
    await request(app.getHttpServer())
      .post('/api/v1/auth/password')
      .set(headers(first))
      .send({ currentPassword: password, newPassword: nextPassword })
      .expect(201);
    await request(app.getHttpServer()).get('/api/v1/auth/session').set(headers(first)).expect(401);
    const fresh = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, companyCode, password: nextPassword, deviceId: randomUUID() })
      .expect(201);
    expect(fresh.body.profile.user.mustChangePassword).toBe(false);
  });
  it('préserve au moins un administrateur actif', async () => {
    const admin = await login(f.approverId),
      member = await db.companyMember.findUniqueOrThrow({
        where: { companyId_userId: { companyId: f.companyId, userId: f.approverId } },
      });
    await request(app.getHttpServer())
      .put(`/api/v1/admin/users/${f.approverId}/access`)
      .set(headers(admin))
      .send({
        expectedVersion: member.authorizationVersion,
        access: { roles: ['AUDITOR'], agencyIds: [], cashRegisterIds: [], active: false },
      })
      .expect(403);
  });
  it('isole les entreprises et interdit l’attribution d’une caisse étrangère', async () => {
    const other = await fixture(db),
      admin = await login(f.approverId),
      member = await db.companyMember.findUniqueOrThrow({
        where: { companyId_userId: { companyId: f.companyId, userId: f.userId } },
      });
    await request(app.getHttpServer())
      .put(`/api/v1/admin/users/${f.userId}/access`)
      .set(headers(admin))
      .send({
        expectedVersion: member.authorizationVersion,
        access: {
          roles: ['CASHIER'],
          agencyIds: [f.agencyId],
          cashRegisterIds: [other.registerId],
          active: true,
        },
      })
      .expect(403);
  });
  it('isole les brouillons par utilisateur et ne crée aucune écriture financière', async () => {
    const member = await db.companyMember.findUniqueOrThrow({
        where: { companyId_userId: { companyId: f.companyId, userId: f.viewerId } },
      }),
      role = await db.role.findUniqueOrThrow({
        where: { companyId_code: { companyId: f.companyId, code: 'CASHIER' } },
      });
    await db.memberRole.deleteMany({ where: { memberId: member.id } });
    await db.memberRole.create({
      data: { companyId: f.companyId, memberId: member.id, roleId: role.id },
    });
    await db.cashRegisterGrant.create({
      data: {
        companyId: f.companyId,
        memberId: member.id,
        agencyId: f.agencyId,
        cashRegisterId: f.registerId,
      },
    });
    const one = await login(),
      two = await login(f.viewerId);
    const draft = {
      id: randomUUID(),
      kind: 'receipt',
      currency: 'USD',
      amount: '12.34',
      description: 'Brouillon autorisé',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    };
    const body = {
      draft,
      agencyId: f.agencyId,
      cashRegisterId: f.registerId,
      version: 1,
      expectedServerVersion: null,
    };
    await request(app.getHttpServer())
      .post('/api/v1/workspace/drafts/sync')
      .set(headers(one))
      .send(body)
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/workspace/drafts/sync')
      .set(headers(one))
      .send(body)
      .expect(201);
    await request(app.getHttpServer())
      .get(`/api/v1/workspace/drafts/${draft.id}`)
      .set(headers(two))
      .expect(404);
    const access = new CentralAccess(db);
    expect(
      await access.run(
        { companyId: f.companyId, userId: f.viewerId, sessionId: two.profile.sessionId },
        (tx) => tx.importedDraft.findMany(),
      ),
    ).toHaveLength(0);
    expect(await db.financialOperation.count({ where: { companyId: f.companyId } })).toBe(0);
    expect(await db.importedDraft.count({ where: { companyId: f.companyId } })).toBe(1);
  });
  it('interdit l’altération du journal et n’expose que les événements autorisés', async () => {
    const cashier = await login(),
      admin = await login(f.approverId);
    await request(app.getHttpServer()).get('/api/v1/admin/logs').set(headers(cashier)).expect(403);
    const events = await request(app.getHttpServer())
      .get('/api/v1/admin/logs')
      .set(headers(admin))
      .expect(200);
    expect(events.body.every((e: { code: string }) => typeof e.code === 'string')).toBe(true);
    expect(JSON.stringify(events.body)).not.toMatch(/passwordHash|accessToken|tokenHash/);
    await expect(
      db.authEvent.updateMany({ where: { companyId: f.companyId }, data: { code: 'LOGOUT' } }),
    ).rejects.toThrow();
  });
  it('revalide une session révoquée à l’intérieur de la transaction de données', async () => {
    const session = await login();
    const auth = app.get(AuthService);
    const principal = await auth.authenticate(session.token);
    await db.authSession.update({
      where: { id: principal.sessionId },
      data: { revokedAt: new Date() },
    });
    await expect(
      new CentralAccess(db).run(
        {
          companyId: principal.companyId,
          userId: principal.userId,
          sessionId: principal.sessionId,
        },
        (tx) => tx.treasuryAccount.findMany(),
      ),
    ).rejects.toThrow('CAISSEPRO_SESSION_REVOKED');
  });
});
