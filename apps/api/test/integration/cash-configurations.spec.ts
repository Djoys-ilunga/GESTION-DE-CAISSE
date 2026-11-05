import 'reflect-metadata';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app';
import { PrismaService } from '../../src/prisma.service';
import { PasswordService } from '../../src/auth/password.service';
import { CentralAccess } from '../../src/data/central-access';
import { LedgerService } from '../../src/data/ledger.service';
import { fixture } from './fixture';
describe('Configurations monocaisse et multicaisse sur PostgreSQL réel', () => {
  let app: INestApplication, db: PrismaService, hash: string;
  const password = 'Phrase-de-test!Configuration-2026';
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
  async function prepareFixture(singleCash: boolean) {
    const f = await fixture(db, { singleCash });
    await db.userCredential.createMany({
      data: [f.userId, f.approverId].map((userId) => ({ userId, passwordHash: hash })),
    });
    return f;
  }
  async function login(f: Awaited<ReturnType<typeof fixture>>, userId = f.userId) {
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
  async function receipt(
    f: Awaited<ReturnType<typeof fixture>>,
    headers: Record<string, string>,
    cashRegisterId: string,
    currency: 'USD' | 'CDF',
    amount: string,
  ) {
    const id = randomUUID();
    await request(app.getHttpServer())
      .post('/api/v1/workspace/drafts/sync')
      .set(headers)
      .send({
        draft: {
          id,
          kind: 'receipt',
          currency,
          amount,
          description: 'Contrôle de configuration',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 600000).toISOString(),
          receiptDetails: {
            provenance: 'Client de test',
            category: 'VENTE',
            reference: '',
            supportingDocument: null,
          },
        },
        agencyId: f.agencyId,
        cashRegisterId,
        version: 1,
        expectedServerVersion: null,
      })
      .expect(201);
    const source = await db.importedDraft.findUniqueOrThrow({
      where: {
        companyId_authorId_clientDraftId: {
          companyId: f.companyId,
          authorId: f.userId,
          clientDraftId: id,
        },
      },
    });
    return request(app.getHttpServer())
      .post(`/api/v1/cash/drafts/${source.id}/confirm`)
      .set(headers)
      .send({ expectedVersion: 1, received: true });
  }
  it.each([
    { singleCash: true, label: 'monocaisse' },
    { singleCash: false, label: 'multicaisse' },
  ])(
    'préserve devises, approbation, décaissement et fermeture en $label',
    async ({ singleCash }) => {
      const f = await prepareFixture(singleCash),
        user = await login(f),
        approver = await login(f, f.approverId),
        ctx = { ...f.ctx, sessionId: user.sessionId };
      expect(await db.cashRegister.count({ where: { companyId: f.companyId } })).toBe(
        singleCash ? 1 : 2,
      );
      const list = await request(app.getHttpServer())
        .get('/api/v1/cash/registers')
        .set(user.headers)
        .expect(200);
      expect(list.body.items).toHaveLength(singleCash ? 1 : 2);
      expect(
        list.body.items
          .find((r: { id: string }) => r.id === f.registerId)
          .funds.map((v: { currency: string }) => v.currency)
          .sort(),
      ).toEqual(['CDF', 'USD']);
      await receipt(f, user.headers, f.registerId, 'USD', '10.50').then((r) =>
        expect(r.status).toBe(201),
      );
      await receipt(f, user.headers, f.registerId, 'CDF', '25.00').then((r) =>
        expect(r.status).toBe(201),
      );
      const ledger = app.get(LedgerService),
        expense = await ledger.requestExpense(ctx, {
          agencyId: f.agencyId,
          accountId: f.usd,
          currency: 'USD',
          amount: '4.00',
          description: 'Dépense approuvée',
        });
      const pay = {
        agencyId: f.agencyId,
        idempotencyKey: randomUUID(),
        expenseRequestId: expense.expenseRequestId,
        counterAccountId: f.clearingUsd,
        cashSessionId: f.sessionId,
      };
      await expect(ledger.payExpense(ctx, pay)).rejects.toThrow('EXPENSE_NOT_APPROVED');
      await expect(ledger.approveExpense(ctx, expense.expenseRequestId)).rejects.toThrow(
        'SELF_APPROVAL_FORBIDDEN',
      );
      await ledger.approveExpense(
        { ...f.approveCtx, sessionId: approver.sessionId },
        expense.expenseRequestId,
      );
      await ledger.payExpense(ctx, pay);
      expect((await ledger.balance(ctx, f.usd)).balance).toBe('6.50');
      expect((await ledger.balance(ctx, f.cdf)).balance).toBe('25.00');
      const open = await request(app.getHttpServer())
        .post(`/api/v1/cash/registers/${f.registerId}/open`)
        .set(user.headers)
        .expect(201);
      expect(open.body.id).toBe(f.sessionId);
      const count = await db.financialOperation.count({ where: { companyId: f.companyId } });
      await new CentralAccess(db).run(ctx, (tx) =>
        tx.cashSession.update({
          where: { id: f.sessionId },
          data: { state: 'CLOSED', closedAt: new Date(), closedById: f.userId },
        }),
      );
      const closed = await request(app.getHttpServer())
        .get('/api/v1/cash/registers')
        .set(user.headers)
        .expect(200);
      expect(
        closed.body.items.find((r: { id: string }) => r.id === f.registerId).session,
      ).toBeNull();
      const rejected = await receipt(f, user.headers, f.registerId, 'USD', '1.00');
      expect(rejected.status).toBe(409);
      expect(await db.financialOperation.count({ where: { companyId: f.companyId } })).toBe(count);
      expect((await ledger.balance(ctx, f.usd)).balance).toBe('6.50');
    },
  );
  it('ajoute une deuxième caisse sans réécrire les données financières existantes', async () => {
    const f = await prepareFixture(true),
      user = await login(f);
    expect((await receipt(f, user.headers, f.registerId, 'USD', '12.34')).status).toBe(201);
    const financialSnapshot = async () => ({
      operations: await db.financialOperation.findMany({
        where: { companyId: f.companyId },
        orderBy: { id: 'asc' },
      }),
      entries: await db.ledgerEntry.findMany({
        where: { companyId: f.companyId },
        orderBy: { id: 'asc' },
      }),
      receipts: await db.cashReceipt.findMany({
        where: { companyId: f.companyId },
        orderBy: { id: 'asc' },
      }),
      counters: await db.receiptCounter.findMany({ where: { companyId: f.companyId } }),
    });
    const before = await financialSnapshot(),
      id = randomUUID();
    await request(app.getHttpServer())
      .post('/api/v1/cash/registers')
      .set(user.headers)
      .send({
        id,
        agencyId: f.agencyId,
        code: 'NOUVELLE',
        name: 'Deuxième caisse',
        authorizedUserIds: [f.userId],
      })
      .expect(201);
    expect(await financialSnapshot()).toEqual(before);
    await request(app.getHttpServer()).get('/api/v1/auth/session').set(user.headers).expect(401);
    const refreshed = await login(f),
      catalog = await request(app.getHttpServer())
        .get('/api/v1/cash/registers')
        .set(refreshed.headers)
        .expect(200);
    expect(catalog.body.items).toHaveLength(2);
    const restricted = await login(f, f.approverId);
    const personalCatalog = await request(app.getHttpServer())
      .get('/api/v1/cash/registers')
      .set(restricted.headers)
      .expect(200);
    expect(personalCatalog.body.items).toHaveLength(1);
    expect(personalCatalog.body.items[0].id).toBe(f.registerId);
    expect(catalog.body.items.find((r: { id: string }) => r.id === id).funds).toEqual(
      expect.arrayContaining([
        { currency: 'CDF', balance: '0.00', reserved: '0.00', available: '0.00' },
        { currency: 'USD', balance: '0.00', reserved: '0.00', available: '0.00' },
      ]),
    );
    expect(
      catalog.body.items
        .find((r: { id: string }) => r.id === f.registerId)
        .funds.find((v: { currency: string }) => v.currency === 'USD').balance,
    ).toBe('12.34');
  });
});
