import 'reflect-metadata';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { transferViewSchema } from '@caissepro/shared';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app';
import { PrismaService } from '../../src/prisma.service';
import { PasswordService } from '../../src/auth/password.service';
import { CentralAccess } from '../../src/data/central-access';
import { LedgerService } from '../../src/data/ledger.service';
import { fixture } from './fixture';

describe('Transferts : API et PostgreSQL réels', () => {
  let app: INestApplication, db: PrismaService, hash: string;
  const password = 'Transferts-tests!Phrase2026';
  beforeAll(async () => {
    if (
      process.env.CAISSEPRO_INTEGRITY_TEST !== '1' ||
      !/^\/caissepro_test_[0-9a-f]+$/.test(new URL(process.env.DATABASE_URL!).pathname)
    )
      throw new Error('Base jetable obligatoire');
    db = new PrismaService();
    await db.$connect();
    hash = await new PasswordService().hash(password);
    const m = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(db)
      .compile();
    app = m.createNestApplication({ logger: false });
    configureApp(app, []);
    await app.listen(0, '127.0.0.1');
  });
  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
  });
  type F = Awaited<ReturnType<typeof fixture>>;
  async function login(f: F, userId: string) {
    const deviceId = randomUUID(),
      company = await db.company.findUniqueOrThrow({ where: { id: f.companyId } });
    const r = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ companyCode: company.code, email: `${userId}@example.test`, password, deviceId })
      .expect(201);
    return {
      headers: { Authorization: `Bearer ${r.body.accessToken}`, 'X-CaissePro-Device': deviceId },
      ctx: { companyId: f.companyId, userId, sessionId: r.body.profile.sessionId as string },
    };
  }
  async function setup(funds = '100.00') {
    const f = await fixture(db);
    await db.treasuryAccount.create({
      data: {
        id: randomUUID(),
        companyId: f.companyId,
        agencyId: f.otherAgencyId,
        cashRegisterId: f.otherRegisterId,
        code: 'CASH',
        currency: 'CDF',
        kind: 'TREASURY',
      },
    });
    await db.userCredential.createMany({
      data: [f.userId, f.approverId, f.viewerId].map((userId) => ({ userId, passwordHash: hash })),
    });
    const source = await login(f, f.userId),
      receiver = await login(f, f.approverId),
      viewer = await login(f, f.viewerId);
    if (funds !== '0.00')
      for (const currency of ['USD', 'CDF'] as const)
        await app.get(LedgerService).receipt(source.ctx, {
          agencyId: f.agencyId,
          idempotencyKey: randomUUID(),
          accountId: currency === 'USD' ? f.usd : f.cdf,
          counterAccountId: currency === 'USD' ? f.clearingUsd : f.clearingCdf,
          cashSessionId: f.sessionId,
          currency,
          amount: funds,
        });
    const body = {
      id: randomUUID(),
      sourceCashRegisterId: f.registerId,
      destinationCashRegisterId: f.otherRegisterId,
      sourceCurrency: 'USD',
      destinationCurrency: 'USD',
      amount: '20.00',
      rate: null as string | null,
      rateSource: '',
      description: 'Transfert de fonds',
    };
    return { f, source, receiver, viewer, body };
  }
  type S = Awaited<ReturnType<typeof setup>>;
  const post = (s: S, path: string, body: object, receiver = false) =>
    request(app.getHttpServer())
      .post(`/api/v1/transfers${path}`)
      .set(receiver ? s.receiver.headers : s.source.headers)
      .send(body);
  const handover = (s: S, id = s.body.id) =>
    post(s, `/${id}/handover`, { expectedVersion: 1, handedOver: true, rateValidated: true });
  const receive = (s: S, id = s.body.id) =>
    post(s, `/${id}/receive`, { expectedVersion: 2, received: true }, true);
  async function balance(s: S, accountId = s.f.usd) {
    return app.get(LedgerService).balance(s.source.ctx, accountId);
  }
  it.each(['USD', 'CDF'])(
    'transfert %s : deux confirmations distinctes, réservation, écritures et bordereau immuable',
    async (currency) => {
      const s = await setup();
      s.body.sourceCurrency = currency;
      s.body.destinationCurrency = currency;
      const start = await post(s, '/drafts', s.body).expect(201);
      expect(transferViewSchema.parse(start.body).state).toBe('DRAFT');
      expect(
        await db.financialOperation.count({
          where: { companyId: s.f.companyId, kind: 'TRANSFER' },
        }),
      ).toBe(0);
      const account = currency === 'USD' ? s.f.usd : s.f.cdf;
      await handover(s).expect(201);
      expect(await balance(s, account)).toMatchObject({
        balance: '100.00',
        reserved: '20.00',
        available: '80.00',
      });
      await post(s, `/${s.body.id}/receive`, { expectedVersion: 2, received: true }).expect(409);
      const r = await receive(s).expect(201),
        view = transferViewSchema.parse(r.body);
      expect(view.state).toBe('RECEIVED');
      expect(view.slip?.number).toContain('TRF-');
      expect(view.slip?.handedOverByName).toBeTruthy();
      expect(await balance(s, account)).toMatchObject({
        balance: '80.00',
        reserved: '0.00',
        available: '80.00',
      });
      const lines = await db.ledgerEntry.findMany({
        where: { companyId: s.f.companyId, operationId: view.operationId! },
      });
      expect(lines).toHaveLength(2);
      expect(lines.map((l) => l.amount.toFixed(2))).toEqual(['20.00', '20.00']);
      expect(await db.cashReceipt.count({ where: { companyId: s.f.companyId } })).toBe(0);
      expect(
        await db.financialOperation.count({ where: { companyId: s.f.companyId, kind: 'RECEIPT' } }),
      ).toBe(2);
      await expect(
        app
          .get(CentralAccess)
          .run(s.receiver.ctx, (tx) =>
            tx.transferOrder.update({ where: { id: s.body.id }, data: { description: 'Altéré' } }),
          ),
      ).rejects.toThrow();
      const history = await request(app.getHttpServer())
        .get('/api/v1/transfers')
        .set(s.receiver.headers)
        .expect(200);
      expect(history.body.items[0].id).toBe(s.body.id);
    },
  );
  it.each([
    { from: 'USD', to: 'CDF', rate: '2800.125', amount: '1.00', target: '2800.13' },
    { from: 'CDF', to: 'USD', rate: '0.000357142857', amount: '2800.00', target: '1.00' },
  ])('conversion $from → $to : taux explicite et arrondi exact', async (c) => {
    const s = await setup('10000.00');
    Object.assign(s.body, {
      sourceCurrency: c.from,
      destinationCurrency: c.to,
      rate: c.rate,
      rateSource: 'Taux validé au guichet',
      amount: c.amount,
    });
    const d = await post(s, '/drafts', s.body).expect(201);
    expect(d.body.targetAmount).toBe(c.target);
    await post(s, `/${s.body.id}/handover`, {
      expectedVersion: 1,
      handedOver: true,
      rateValidated: false,
    }).expect(409);
    await handover(s).expect(201);
    const r = await receive(s).expect(201);
    const op = await db.financialOperation.findUniqueOrThrow({
      where: { id: r.body.operationId },
      include: { entries: true, rate: true },
    });
    expect(op.kind).toBe('FX');
    expect(op.entries).toHaveLength(4);
    expect(op.targetAmount!.toFixed(2)).toBe(c.target);
    expect(op.rate!.rate.toString()).toBe(c.rate);
    for (const currency of ['USD', 'CDF']) {
      const amounts = op.entries
        .filter((e) => e.currency === currency)
        .map((e) => e.amount.toFixed(2));
      expect(amounts).toHaveLength(2);
      expect(amounts[0]).toBe(amounts[1]);
    }
  });
  it('convertit dans une caisse unique sans créer de seconde caisse ni confondre les devises', async () => {
    const s = await setup();
    Object.assign(s.body, {
      destinationCashRegisterId: s.f.registerId,
      destinationCurrency: 'CDF',
      rate: '2800',
      rateSource: 'Guichet',
    });
    await post(s, '/drafts', s.body).expect(201);
    await handover(s).expect(201);
    await receive(s).expect(201);
    expect(await balance(s)).toMatchObject({ balance: '80.00', reserved: '0.00' });
    expect(await balance(s, s.f.cdf)).toMatchObject({ balance: '56100.00', reserved: '0.00' });
    expect(await db.cashRegister.count({ where: { companyId: s.f.companyId } })).toBe(2);
  });
  it('annule les écritures et le taux si la création du bordereau échoue après comptabilisation', async () => {
    const s = await setup();
    Object.assign(s.body, { destinationCurrency: 'CDF', rate: '2800', rateSource: 'Guichet' });
    await post(s, '/drafts', s.body).expect(201);
    await handover(s).expect(201);
    const fn = 'test_transfer_failure_' + s.body.id.replaceAll('-', '');
    await db.$executeRawUnsafe(
      `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'CAISSEPRO_TEST_FAILURE'; END $$`,
    );
    await db.$executeRawUnsafe(
      `CREATE TRIGGER ${fn} BEFORE UPDATE ON "TransferOrder" FOR EACH ROW WHEN (NEW.id='${s.body.id}'::uuid AND NEW.state='RECEIVED') EXECUTE FUNCTION ${fn}()`,
    );
    try {
      await receive(s).expect(409);
      expect(
        await db.financialOperation.count({ where: { companyId: s.f.companyId, kind: 'FX' } }),
      ).toBe(0);
      expect(await db.exchangeRate.count({ where: { companyId: s.f.companyId } })).toBe(0);
      expect(
        (await db.transferOrder.findUniqueOrThrow({ where: { id: s.body.id } })).slip,
      ).toBeNull();
      expect(await balance(s)).toMatchObject({ balance: '100.00', reserved: '20.00' });
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER ${fn} ON "TransferOrder"`);
      await db.$executeRawUnsafe(`DROP FUNCTION ${fn}()`);
    }
  });
  it('calcule les grands montants sans arrondi intermédiaire', async () => {
    const s = await setup('9999999999999999.99');
    Object.assign(s.body, {
      sourceCurrency: 'CDF',
      destinationCurrency: 'USD',
      rate: '0.123456789123',
      rateSource: 'Test de précision',
      amount: '9999999999999999.99',
    });
    const r = await post(s, '/drafts', s.body).expect(201);
    // Independent integer arithmetic in the test: amount in cents × rate scaled to 12 decimals.
    const scaled = 999999999999999999n * 123456789123n;
    const cents = (scaled + 500000000000n) / 1000000000000n;
    expect(r.body.targetAmount).toBe(`${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`);
    await handover(s).expect(201);
    const received = await receive(s).expect(201);
    expect(received.body.targetAmount).toBe(r.body.targetAmount);
  });
  it('refuse les taux absents, négatifs, non finis et les champs financiers affirmés par le client', async () => {
    const s = await setup();
    for (const rate of [null, '0', '-1', 'NaN', 'Infinity', '1e3', '0.0000000000001'])
      await post(s, '/drafts', {
        ...s.body,
        destinationCurrency: 'CDF',
        rate,
        rateSource: 'Test',
      }).expect(400);
    await post(s, '/drafts', { ...s.body, targetAmount: '900.00' }).expect(400);
    await post(s, '/drafts', { ...s.body, destinationCashRegisterId: s.f.registerId }).expect(400);
    await post(s, '/drafts', {
      ...s.body,
      destinationCurrency: 'CDF',
      rate: '0.000000000001',
      rateSource: 'Test',
      amount: '0.01',
    }).expect(409);
  });
  it('déduplique les transmissions et refuse un UUID réutilisé avec un autre montant', async () => {
    const s = await setup();
    await Promise.all(Array.from({ length: 4 }, () => post(s, '/drafts', s.body).expect(201)));
    expect(await db.transferOrder.count({ where: { companyId: s.f.companyId } })).toBe(1);
    await post(s, '/drafts', { ...s.body, amount: '21.00' }).expect(409);
  });
  it('déduplique remises et réceptions concurrentes sans deuxième mouvement', async () => {
    const s = await setup();
    await post(s, '/drafts', s.body).expect(201);
    await Promise.all(Array.from({ length: 4 }, () => handover(s).expect(201)));
    await Promise.all(Array.from({ length: 4 }, () => receive(s).expect(201)));
    expect(
      await db.financialOperation.count({ where: { companyId: s.f.companyId, kind: 'TRANSFER' } }),
    ).toBe(1);
    expect((await balance(s)).balance).toBe('80.00');
  });
  it('n’autorise qu’une remise concurrente quand les fonds ne couvrent pas les deux', async () => {
    const s = await setup('30.00'),
      id = randomUUID();
    await post(s, '/drafts', s.body).expect(201);
    await post(s, '/drafts', { ...s.body, id }).expect(201);
    const results = await Promise.all([handover(s), handover(s, id)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await balance(s)).toMatchObject({
      balance: '30.00',
      reserved: '20.00',
      available: '10.00',
    });
  });
  it('interdit de dépenser les fonds réservés même sans accès à la caisse destination', async () => {
    const s = await setup('30.00');
    await post(s, '/drafts', s.body).expect(201);
    await handover(s).expect(201);
    const member = await db.companyMember.findFirstOrThrow({
      where: { companyId: s.f.companyId, userId: s.f.userId },
    });
    await db.cashRegisterGrant.deleteMany({
      where: { companyId: s.f.companyId, memberId: member.id, cashRegisterId: s.f.otherRegisterId },
    });
    expect((await balance(s)).available).toBe('10.00');
    const ledger = app.get(LedgerService),
      ex = await ledger.requestExpense(s.source.ctx, {
        agencyId: s.f.agencyId,
        accountId: s.f.usd,
        currency: 'USD',
        amount: '15.00',
        description: 'Ne pas dépenser les fonds remis',
      });
    await expect(ledger.approveExpense(s.receiver.ctx, ex.expenseRequestId)).rejects.toThrow(
      'INSUFFICIENT_FUNDS',
    );
  });
  it('applique sessions ouvertes, permissions, périmètres et révocation', async () => {
    const s = await setup();
    await post(s, '/drafts', s.body).expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/transfers/${s.body.id}/handover`)
      .set(s.viewer.headers)
      .send({ expectedVersion: 1, handedOver: true, rateValidated: true })
      .expect(403);
    const foreign = await fixture(db);
    await post(s, '/drafts', {
      ...s.body,
      id: randomUUID(),
      destinationCashRegisterId: foreign.registerId,
    }).expect(403);
    await post(s, `/${s.body.id}/handover`, {
      expectedVersion: 1,
      handedOver: false,
      rateValidated: true,
    }).expect(400);
    await post(s, `/${s.body.id}/receive`, { expectedVersion: 1, received: true }, true).expect(
      409,
    );
    await db.authSession.update({
      where: { id: s.source.ctx.sessionId },
      data: { revokedAt: new Date() },
    });
    await handover(s).expect(401);
  });
  it('rollback complet si la session de destination est fermée avant réception', async () => {
    const s = await setup();
    await post(s, '/drafts', s.body).expect(201);
    await handover(s).expect(201);
    await app.get(CentralAccess).run(s.receiver.ctx, (tx) =>
      tx.cashSession.update({
        where: { id: s.f.otherSessionId },
        data: { state: 'CLOSED', closedById: s.f.approverId, closedAt: new Date() },
      }),
    );
    await receive(s).expect(409);
    expect((await db.transferOrder.findUniqueOrThrow({ where: { id: s.body.id } })).state).toBe(
      'HANDED_OVER',
    );
    expect(
      await db.financialOperation.count({ where: { companyId: s.f.companyId, kind: 'TRANSFER' } }),
    ).toBe(0);
    expect((await balance(s)).reserved).toBe('20.00');
  });
  it('rejette les transitions SQL forgées et conserve les montants immuables dès transmission', async () => {
    const s = await setup();
    await post(s, '/drafts', s.body).expect(201);
    const access = app.get(CentralAccess);
    await expect(
      access.run(s.source.ctx, (tx) =>
        tx.transferOrder.update({
          where: { id: s.body.id },
          data: { amount: '1.00', targetAmount: '1.00', version: 2 },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      access.run(s.receiver.ctx, (tx) =>
        tx.transferOrder.update({
          where: { id: s.body.id },
          data: {
            state: 'RECEIVED',
            version: 2,
            receivedById: s.f.approverId,
            operationId: randomUUID(),
          },
        }),
      ),
    ).rejects.toThrow();
    const hidden = await access.run({ companyId: randomUUID(), userId: s.f.viewerId }, (tx) =>
      tx.transferOrder.findMany(),
    );
    expect(hidden).toEqual([]);
  });
});
