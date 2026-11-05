import 'reflect-metadata';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { syncManifestSchema, syncEventsSchema, draftSyncResultSchema } from '@caissepro/shared';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app';
import { PrismaService } from '../../src/prisma.service';
import { PasswordService } from '../../src/auth/password.service';
import { CentralAccess } from '../../src/data/central-access';
import { fixture } from './fixture';

describe('Synchronisation v2 avec API et PostgreSQL réels', () => {
  let app: INestApplication, db: PrismaService, hash: string;
  const password = 'Mot-de-passe-synthetique!Sync-2026';
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
    configureApp(app, []);
    await app.listen(0, '127.0.0.1');
  });
  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
  });
  async function setup() {
    const f = await fixture(db);
    await db.userCredential.createMany({
      data: [f.userId, f.approverId].map((userId) => ({ userId, passwordHash: hash })),
    });
    async function login(userId: string) {
      const deviceId = randomUUID(),
        company = await db.company.findUniqueOrThrow({ where: { id: f.companyId } });
      const r = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: `${userId}@example.test`, companyCode: company.code, password, deviceId })
        .expect(201);
      return {
        headers: { Authorization: `Bearer ${r.body.accessToken}`, 'X-CaissePro-Device': deviceId },
        sessionId: r.body.profile.sessionId as string,
      };
    }
    return { f, user: await login(f.userId), other: await login(f.approverId), login };
  }
  type Setup = Awaited<ReturnType<typeof setup>>;
  function body(s: Setup) {
    const created = new Date().toISOString();
    return {
      syncProtocol: 2,
      originalCreatedAt: created,
      updatedAt: created,
      draft: {
        id: randomUUID(),
        kind: 'expense-request',
        currency: 'USD',
        amount: '12.34',
        description: 'Brouillon privé synthétique',
        createdAt: created,
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        expenseDetails: {
          beneficiary: 'Bénéficiaire privé synthétique',
          reference: '',
          documents: [],
        },
      },
      agencyId: s.f.agencyId,
      cashRegisterId: s.f.registerId,
      version: 1,
      expectedServerVersion: null as number | null,
    };
  }
  function send(s: Setup, value: ReturnType<typeof body>) {
    return request(app.getHttpServer())
      .post('/api/v1/workspace/drafts/sync')
      .set(s.user.headers)
      .send(value);
  }
  it('déduplique six transmissions et retourne les identifiants sans aucun mouvement financier', async () => {
    const s = await setup(),
      value = body(s),
      responses = await Promise.all(Array.from({ length: 6 }, () => send(s, value)));
    expect(responses.map((r) => r.status)).toEqual(Array(6).fill(201));
    const a = draftSyncResultSchema.parse(responses[0]!.body);
    expect(a.outcome).toBe('accepted-as-draft');
    if (a.outcome !== 'accepted-as-draft') throw new Error('Accusé requis');
    expect(a.serverId).not.toBe(value.draft.id);
    expect(a.serverVersion).toBe(1);
    expect(new Set(responses.map((r) => r.body.serverId)).size).toBe(1);
    expect(await db.importedDraft.count({ where: { companyId: s.f.companyId } })).toBe(1);
    for (const table of [
      'FinancialOperation',
      'LedgerEntry',
      'ExpenseRequest',
      'ExpenseApproval',
      'FundReservation',
      'CashReceipt',
      'PaymentVoucher',
    ])
      expect(
        (
          await db.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*) AS n FROM "${table}" WHERE "companyId"=$1::uuid`,
            s.f.companyId,
          )
        )[0]!.n,
      ).toBe(0n);
    const events = syncEventsSchema.parse(
      (
        await request(app.getHttpServer())
          .get('/api/v1/workspace/sync/events')
          .set(s.user.headers)
          .expect(200)
      ).body,
    );
    expect(events.items.filter((e) => e.stage === 'STARTED')).toHaveLength(6);
    expect(events.items.filter((e) => e.stage === 'SUCCESS')).toHaveLength(6);
    expect(JSON.stringify(events)).not.toContain('Bénéficiaire');
    expect(JSON.stringify(events)).not.toContain('12.34');
  });
  it('retrouve après reconnexion une copie serveur avec UUID et dates conservés', async () => {
    const s = await setup(),
      value = body(s),
      first = (await send(s, value).expect(201)).body;
    const current = await s.login(s.f.userId);
    const manifest = syncManifestSchema.parse(
      (
        await request(app.getHttpServer())
          .get('/api/v1/workspace/sync/manifest')
          .set(current.headers)
          .expect(200)
      ).body,
    );
    expect(manifest.items[0]).toMatchObject({
      serverId: first.serverId,
      clientDraftId: value.draft.id,
      createdAt: value.originalCreatedAt,
      updatedAt: value.updatedAt,
      sourceState: 'draft',
    });
    const source = await request(app.getHttpServer())
      .get(`/api/v1/workspace/sync/drafts/${value.draft.id}`)
      .set(current.headers)
      .expect(200);
    expect(source.body.amount).toBe('12.34');
    expect(source.body.expenseDetails.beneficiary).toBe(value.draft.expenseDetails.beneficiary);
  });
  it('journalise le conflit, préserve les données puis accepte une correction versionnée explicite', async () => {
    const s = await setup(),
      value = body(s);
    await send(s, value).expect(201);
    const revised = {
      ...value,
      draft: { ...value.draft, description: 'Première correction' },
      version: 2,
      expectedServerVersion: 1,
      updatedAt: new Date().toISOString(),
    };
    await send(s, revised).expect(201);
    await send(s, {
      ...value,
      draft: { ...value.draft, description: 'Correction concurrente' },
      version: 2,
      expectedServerVersion: 1,
      updatedAt: new Date().toISOString(),
    }).expect(409);
    expect(
      (await db.importedDraft.findFirstOrThrow({ where: { companyId: s.f.companyId } }))
        .description,
    ).toBe('Première correction');
    const rebased = {
      ...revised,
      draft: { ...revised.draft, description: 'Correction explicitement retenue' },
      version: 3,
      expectedServerVersion: 2,
      updatedAt: new Date().toISOString(),
    };
    await send(s, rebased).expect(201);
    const row = await db.importedDraft.findFirstOrThrow({ where: { companyId: s.f.companyId } });
    expect(row.version).toBe(3);
    expect(row.clientCreatedAt?.toISOString()).toBe(value.originalCreatedAt);
    expect(
      await db.syncEvent.count({ where: { companyId: s.f.companyId, stage: 'CONFLICT' } }),
    ).toBe(1);
  });
  it('borne les tentatives par utilisateur et laisse les autres utilisateurs indépendants', async () => {
    const s = await setup(),
      value = body(s);
    for (let i = 0; i < 30; i++) await send(s, value).expect(201);
    await send(s, value).expect(429);
    await request(app.getHttpServer())
      .post('/api/v1/workspace/drafts/sync')
      .set(s.user.headers)
      .send({
        ...value,
        syncProtocol: undefined,
        originalCreatedAt: undefined,
        updatedAt: undefined,
      })
      .expect(429);
    expect(await db.importedDraft.count({ where: { companyId: s.f.companyId } })).toBe(1);
    expect(
      await db.syncEvent.count({ where: { companyId: s.f.companyId, stage: 'STARTED' } }),
    ).toBe(30);
    await request(app.getHttpServer())
      .post('/api/v1/workspace/drafts/sync')
      .set(s.other.headers)
      .send({ ...value, draft: { ...value.draft, id: randomUUID() } })
      .expect(201);
  });
  it('isole les copies et journaux, puis retire les brouillons sortis du périmètre autorisé', async () => {
    const s = await setup(),
      value = body(s);
    await send(s, value).expect(201);
    await request(app.getHttpServer())
      .get(`/api/v1/workspace/sync/drafts/${value.draft.id}`)
      .set(s.other.headers)
      .expect(404);
    const other = await request(app.getHttpServer())
      .get('/api/v1/workspace/sync/events')
      .set(s.other.headers)
      .expect(200);
    expect(other.body.items).toHaveLength(0);
    const member = await db.companyMember.findUniqueOrThrow({
      where: { companyId_userId: { companyId: s.f.companyId, userId: s.f.userId } },
    });
    await db.cashRegisterGrant.deleteMany({ where: { memberId: member.id } });
    const fresh = await s.login(s.f.userId);
    const manifest = await request(app.getHttpServer())
      .get('/api/v1/workspace/sync/manifest')
      .set(fresh.headers)
      .expect(200);
    expect(manifest.body.items).toHaveLength(0);
    const legacy = await request(app.getHttpServer())
      .get('/api/v1/workspace/drafts')
      .set(fresh.headers)
      .expect(200);
    expect(legacy.body).toHaveLength(0);
    await request(app.getHttpServer())
      .get(`/api/v1/workspace/drafts/${value.draft.id}`)
      .set(fresh.headers)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/api/v1/workspace/sync/drafts/${value.draft.id}`)
      .set(fresh.headers)
      .expect(404);
  });
  it('refuse la réécriture de l’origine et l’altération des journaux avec le rôle applicatif', async () => {
    const s = await setup(),
      value = body(s);
    await send(s, value).expect(201);
    await send(s, {
      ...value,
      originalCreatedAt: new Date(Date.parse(value.originalCreatedAt) - 1000).toISOString(),
      version: 2,
      expectedServerVersion: 1,
    }).expect(409);
    const access = new CentralAccess(db),
      ctx = { ...s.f.ctx, sessionId: s.user.sessionId };
    await expect(
      access.run(
        ctx,
        (tx) =>
          tx.$executeRaw`UPDATE "SyncEvent" SET code='expired' WHERE "companyId"=${s.f.companyId}::uuid`,
      ),
    ).rejects.toThrow();
    await expect(
      access.run(
        ctx,
        (tx) =>
          tx.$executeRaw`UPDATE "ImportedDraft" SET "clientCreatedAt"=now()-interval '1 day',version=version+1 WHERE "companyId"=${s.f.companyId}::uuid`,
      ),
    ).rejects.toThrow();
  });
  it('rejette une session révoquée avant tout nouvel envoi', async () => {
    const s = await setup(),
      value = body(s);
    await send(s, value).expect(201);
    await db.authSession.update({
      where: { id: s.user.sessionId },
      data: { revokedAt: new Date() },
    });
    await send(s, value).expect(401);
    expect(
      await db.syncEvent.count({ where: { companyId: s.f.companyId, stage: 'STARTED' } }),
    ).toBe(1);
  });
});
