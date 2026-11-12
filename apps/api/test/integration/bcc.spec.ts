import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID, createHash } from 'node:crypto';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app';
import { PrismaService } from '../../src/prisma.service';
import { PasswordService } from '../../src/auth/password.service';
import { CentralAccess } from '../../src/data/central-access';
import { LedgerService } from '../../src/data/ledger.service';
import {
  BCC_CONNECTOR,
  BCC_OFFICIAL_PAGES,
  type BccSourceConnector,
} from '../../src/exchange/bcc.provider';
import { BccRefreshCoordinator } from '../../src/exchange/bcc.refresh';
import { fixture } from './fixture';

describe('BCC : API/PostgreSQL réels, fournisseur synthétique injecté', () => {
  let app: INestApplication, db: PrismaService, hash: string;
  let f: Awaited<ReturnType<typeof fixture>>,
    source: Awaited<ReturnType<typeof login>>,
    receiver: Awaited<ReturnType<typeof login>>;
  const password = 'Tests-BCC-synthetiques!2026';
  let candidate: unknown,
    fault: Error | null = null;
  const retrieve = vi.fn(async () => {
    if (fault) throw fault;
    return {
      candidate,
      contentSha256: createHash('sha256').update(JSON.stringify(candidate)).digest('hex'),
      retrievedAt: new Date(),
    };
  });
  const connector: BccSourceConnector = {
    descriptor: {
      sourceUrl: BCC_OFFICIAL_PAGES[0],
      contractVersion: 'SYNTHETIC-TEST-ONLY-v1',
      verified: true,
    },
    retrieve,
  };
  const today = () => new Date(Date.now() + 3600000).toISOString().slice(0, 10);
  const makeCandidate = () => ({
    publicationDate: today(),
    publishedAt: null,
    sourceReference: `DONNÉES SYNTHÉTIQUES ${randomUUID()}`,
    quotes: [
      {
        currency: 'USD',
        unit: '1',
        unitEvidence: 'Fixture : un USD',
        buy: '2400',
        mean: '2500',
        sell: '2600',
      },
      {
        currency: 'EUR',
        unit: '100',
        unitEvidence: 'Fixture : cent EUR',
        buy: '290000',
        mean: '300000',
        sell: '310000',
      },
    ],
  });
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
      .overrideProvider(BCC_CONNECTOR)
      .useValue(connector)
      .compile();
    app = m.createNestApplication({ logger: false });
    configureApp(app, []);
    await app.listen(0, '127.0.0.1');
  });
  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
  });
  async function login(userId: string) {
    const company = await db.company.findUniqueOrThrow({ where: { id: f.companyId } }),
      deviceId = randomUUID();
    const r = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ companyCode: company.code, email: `${userId}@example.test`, password, deviceId })
      .expect(201);
    return {
      headers: { Authorization: `Bearer ${r.body.accessToken}`, 'X-CaissePro-Device': deviceId },
      ctx: { companyId: f.companyId, userId, sessionId: r.body.profile.sessionId as string },
    };
  }
  async function resetCooldown() {
    await db.bccRefreshState.update({
      where: { id: 'bcc' },
      data: { nextAllowedAt: null, leaseToken: null, leaseUntil: null },
    });
  }
  beforeEach(async () => {
    fault = null;
    retrieve.mockClear();
    candidate = makeCandidate();
    f = await fixture(db);
    await db.userCredential.createMany({
      data: [f.userId, f.approverId, f.viewerId].map((userId) => ({ userId, passwordHash: hash })),
    });
    source = await login(f.userId);
    receiver = await login(f.approverId);
    await db.bccSourceApproval.update({
      where: { id: 'bcc' },
      data: {
        approved: true,
        approvedAt: new Date(),
        contractVersion: connector.descriptor.contractVersion,
        evidence: 'Autorisation synthétique dans la base de test uniquement',
      },
    });
    await resetCooldown();
  });
  const refresh = () => app.get(BccRefreshCoordinator).refresh();
  const quote = (body: object) =>
    request(app.getHttpServer())
      .post('/api/v1/exchange-rates/quote')
      .set(source.headers)
      .send(body);
  const bccInput = () => ({ fromCurrency: 'USD', toCurrency: 'CDF', amount: '2.00', mode: 'BCC' });
  const manualInput = () => ({
    ...bccInput(),
    mode: 'MANUAL',
    manualRate: '2500',
    manualSource: 'Guichet de test',
    justification: 'Cotation négociée de test',
    manualEffectiveAt: new Date().toISOString(),
  });
  async function createOrder(q: { id: string; appliedRate: string; source: string }, status = 201) {
    return request(app.getHttpServer())
      .post('/api/v1/transfers/drafts')
      .set(source.headers)
      .send({
        id: randomUUID(),
        sourceCashRegisterId: f.registerId,
        destinationCashRegisterId: f.registerId,
        sourceCurrency: 'USD',
        destinationCurrency: 'CDF',
        amount: '2.00',
        rate: q.appliedRate,
        rateSource: q.source,
        rateQuoteId: q.id,
        description: 'Conversion synthétique BCC',
      })
      .expect(status);
  }
  async function funds() {
    await app.get(LedgerService).receipt(source.ctx, {
      agencyId: f.agencyId,
      idempotencyKey: randomUUID(),
      accountId: f.usd,
      counterAccountId: f.clearingUsd,
      cashSessionId: f.sessionId,
      currency: 'USD',
      amount: '100.00',
    });
  }

  it('exige authentification et permissions spécifiques sans modifier les rôles existants', async () => {
    await request(app.getHttpServer()).get('/api/v1/exchange-rates').expect(401);
    const member = await db.companyMember.findUniqueOrThrow({
      where: { companyId_userId: { companyId: f.companyId, userId: f.viewerId } },
    });
    const role = await db.role.create({
      data: { id: randomUUID(), companyId: f.companyId, code: 'BCC_READER_TEST' },
    });
    await db.rolePermission.create({
      data: { companyId: f.companyId, roleId: role.id, permissionCode: 'ledger:read' },
    });
    await db.memberRole.create({
      data: { companyId: f.companyId, memberId: member.id, roleId: role.id },
    });
    const read = await login(f.viewerId);
    await request(app.getHttpServer()).get('/api/v1/exchange-rates').set(read.headers).expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/exchange-rates/refresh')
      .set(read.headers)
      .send({ confirmed: true })
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/v1/exchange-rates/quote')
      .set(read.headers)
      .send(manualInput())
      .expect(403);
    await expect(
      app
        .get(CentralAccess)
        .run(source.ctx, (tx) =>
          tx.bccSourceApproval.update({ where: { id: 'bcc' }, data: { approved: true } }),
        ),
    ).rejects.toThrow();
  });
  it('isole les propositions par auteur et bloque leur utilisation par un autre utilisateur', async () => {
    await funds();
    const q = (await quote(manualInput()).expect(201)).body;
    expect(
      await app
        .get(CentralAccess)
        .run(receiver.ctx, (tx) => tx.rateQuote.findMany({ where: { id: q.id } })),
    ).toEqual([]);
    await request(app.getHttpServer())
      .post('/api/v1/transfers/drafts')
      .set(receiver.headers)
      .send({
        id: randomUUID(),
        sourceCashRegisterId: f.registerId,
        destinationCashRegisterId: f.registerId,
        sourceCurrency: 'USD',
        destinationCurrency: 'CDF',
        amount: '2.00',
        rate: q.appliedRate,
        rateSource: q.source,
        rateQuoteId: q.id,
        description: 'Refus de proposition étrangère',
      })
      .expect(409);
  });
  it('borne la validité d’une proposition à son TTL et à la fraîcheur réelle du taux', async () => {
    const q = (await quote(manualInput()).expect(201)).body;
    expect(Date.parse(q.expiresAt) - Date.parse(q.createdAt)).toBeLessThanOrEqual(900000);
    expect(Date.parse(q.expiresAt)).toBeGreaterThan(Date.parse(q.createdAt));
    const age = new Date(Date.now() - 97 * 3600000).toISOString();
    await quote({ ...manualInput(), manualEffectiveAt: age }).expect(409);
  });
  it('le module livré bloque la collecte interdite, explique la restriction et permet le taux manuel autorisé', async () => {
    const m = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(db)
      .compile();
    const normal = m.createNestApplication({ logger: false });
    configureApp(normal, []);
    await normal.listen(0, '127.0.0.1');
    const initial = await db.financialOperation.count();
    try {
      const info = await request(normal.getHttpServer())
        .get('/api/v1/exchange-rates')
        .set(source.headers)
        .expect(200);
      expect(info.body.source).toMatchObject({
        approved: false,
        code: 'BCC_AUTHORIZATION_REQUIRED',
      });
      expect(info.body.stale).toBe(true);
      const refresh = await request(normal.getHttpServer())
        .post('/api/v1/exchange-rates/refresh')
        .set(source.headers)
        .send({ confirmed: true })
        .expect(201);
      expect(refresh.body).toMatchObject({ performed: false, code: 'BCC_AUTHORIZATION_REQUIRED' });
      const denied = await request(normal.getHttpServer())
        .post('/api/v1/exchange-rates/quote')
        .set(source.headers)
        .send(bccInput())
        .expect(409);
      expect(denied.body.code).toBe('BCC_AUTHORIZATION_REQUIRED');
      const manual = await request(normal.getHttpServer())
        .post('/api/v1/exchange-rates/quote')
        .set(source.headers)
        .send(manualInput())
        .expect(201);
      expect(manual.body).toMatchObject({
        mode: 'MANUAL',
        targetAmount: '5000.00',
        publicationId: null,
        referenceRate: null,
      });
      expect(retrieve).not.toHaveBeenCalled();
      expect(await db.financialOperation.count()).toBe(initial);
      await funds();
      const funded = await db.financialOperation.count();
      const order = await request(normal.getHttpServer())
        .post('/api/v1/transfers/drafts')
        .set(source.headers)
        .send({
          id: randomUUID(),
          sourceCashRegisterId: f.registerId,
          destinationCashRegisterId: f.registerId,
          sourceCurrency: 'USD',
          destinationCurrency: 'CDF',
          amount: '2.00',
          rate: manual.body.appliedRate,
          rateSource: manual.body.source,
          rateQuoteId: manual.body.id,
          description: 'Conversion manuelle sans collecte BCC',
        })
        .expect(201);
      const hand = await request(normal.getHttpServer())
        .post(`/api/v1/transfers/${order.body.id}/handover`)
        .set(source.headers)
        .send({ expectedVersion: 1, handedOver: true, rateValidated: true })
        .expect(201);
      expect(hand.body.rateEvidence.kind).toBe('MANUAL');
      expect(await db.financialOperation.count()).toBe(funded);
      const done = await request(normal.getHttpServer())
        .post(`/api/v1/transfers/${order.body.id}/receive`)
        .set(receiver.headers)
        .send({ expectedVersion: 2, received: true })
        .expect(201);
      expect(done.body.targetAmount).toBe('5000.00');
      const operation = await db.financialOperation.findUniqueOrThrow({
        where: { id: done.body.operationId },
      });
      expect(operation.kind).toBe('FX');
      expect(await db.financialOperation.count()).toBe(funded + 1);
      const applied = await db.exchangeRate.findUniqueOrThrow({
        where: { id: operation.exchangeRateId! },
      });
      expect(applied.rateEvidence).toEqual(hand.body.rateEvidence);
    } finally {
      await normal.close();
    }
  });
  it('ingère et expose date, récupération, unités, trois cours et historique sans comptabiliser', async () => {
    const before = await db.financialOperation.count();
    expect((await refresh()).code).toBe('BCC_NEW_PUBLICATION');
    const r = await request(app.getHttpServer())
      .get('/api/v1/exchange-rates')
      .set(source.headers)
      .expect(200);
    expect(r.body.source.approved).toBe(true);
    expect(r.body.publication.publicationDate).toBe(today());
    expect(r.body.quotes.find((q: { currency: string }) => q.currency === 'EUR')).toMatchObject({
      unit: '100',
      rawMean: '300000.000000000000',
      mean: '3000.000000000000000000',
    });
    const h = await request(app.getHttpServer())
      .get('/api/v1/exchange-rates/history')
      .set(source.headers)
      .expect(200);
    expect(h.body.items[0].quotes.length).toBe(2);
    expect(await db.financialOperation.count()).toBe(before);
  });
  it('déduplique sans nouvelle publication et conserve les dates d’origine', async () => {
    const first = await refresh(),
      count = await db.bccPublication.count();
    const before = await db.bccPublication.findUniqueOrThrow({
      where: { id: first.publicationId! },
    });
    await resetCooldown();
    expect((await refresh()).code).toBe('BCC_NO_NEW_PUBLICATION');
    expect(await db.bccPublication.count()).toBe(count);
    expect(
      await db.bccPublication.findUniqueOrThrow({ where: { id: first.publicationId! } }),
    ).toEqual(before);
  });
  it('conserve une nouvelle publication sans remplacer la précédente', async () => {
    const a = await refresh();
    candidate = makeCandidate();
    await resetCooldown();
    const b = await refresh();
    expect(b.publicationId).not.toBe(a.publicationId);
    expect(await db.bccPublication.findUnique({ where: { id: a.publicationId! } })).not.toBeNull();
  });
  it('borne les actualisations concurrentes et les clics répétés', async () => {
    const r = await Promise.all(Array.from({ length: 6 }, () => refresh()));
    expect(r.filter((v) => v.performed)).toHaveLength(1);
    expect(retrieve).toHaveBeenCalledOnce();
    expect((await refresh()).performed).toBe(false);
  });
  it('conserve le dernier cours et marque la source indisponible en cas de panne avec temporisation', async () => {
    const p = await refresh();
    await resetCooldown();
    fault = new Error('Panne synthétique');
    expect((await refresh()).state).toBe('UNAVAILABLE');
    const state = await db.bccRefreshState.findUniqueOrThrow({ where: { id: 'bcc' } });
    expect(state.failures).toBe(1);
    expect(state.nextAllowedAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await db.bccPublication.findUnique({ where: { id: p.publicationId! } })).not.toBeNull();
    await quote(bccInput()).expect(201);
  });
  it.each([
    { rates: [] },
    {
      ...makeCandidate(),
      quotes: [
        {
          currency: 'USD',
          unit: '10',
          mean: '2500',
          buy: null,
          sell: null,
          unitEvidence: 'Fixture',
        },
      ],
    },
    {
      ...makeCandidate(),
      quotes: [
        { currency: 'USD', unit: '1', mean: '-1', buy: null, sell: null, unitEvidence: 'Fixture' },
      ],
    },
  ])('rejette un format, taux ou unité invalides sans publication partielle', async (value) => {
    candidate = value;
    const before = await db.bccPublication.count();
    expect((await refresh()).state).toBe('UNAVAILABLE');
    expect(await db.bccPublication.count()).toBe(before);
  });
  it('refuse une source non approuvée avant tout appel au fournisseur', async () => {
    await db.bccSourceApproval.update({ where: { id: 'bcc' }, data: { approved: false } });
    expect((await refresh()).performed).toBe(false);
    expect(retrieve).not.toHaveBeenCalled();
    await quote(bccInput()).expect(409);
  });
  it('calcule EUR/USD via CDF avec un seul type de cours et une seule publication', async () => {
    await db.companyCurrency.create({
      data: { companyId: f.companyId, code: 'EUR', active: true },
    });
    await refresh();
    const r = await quote({
      ...bccInput(),
      fromCurrency: 'EUR',
      toCurrency: 'USD',
      amount: '10.00',
    }).expect(201);
    expect(r.body.appliedRate).toBe('1.200000000000');
    expect(r.body.targetAmount).toBe('12.00');
    expect(r.body.snapshot.quotations).toHaveLength(2);
    await request(app.getHttpServer())
      .put('/api/v1/exchange-rates/policy')
      .set(source.headers)
      .send({
        expectedVersion: 1,
        allowManual: true,
        quoteKind: 'BUY',
        maxAgeHours: 96,
        quoteTtlMinutes: 15,
        confirmed: true,
      })
      .expect(200);
    const buy = await quote({ ...bccInput(), fromCurrency: 'EUR', toCurrency: 'USD' }).expect(201);
    expect(buy.body.appliedRate).toBe('1.208333333333');
    expect(buy.body.quoteKind).toBe('BUY');
  });
  it('refuse une devise non couverte, les taux forgés et les montants invalides', async () => {
    await db.companyCurrency.create({
      data: { companyId: f.companyId, code: 'JPY', active: true },
    });
    await refresh();
    await quote({ ...bccInput(), toCurrency: 'JPY' }).expect(409);
    await quote({ ...bccInput(), manualRate: '999' }).expect(400);
    await quote({ ...bccInput(), amount: '0' }).expect(400);
  });
  it('sépare taux manuel et référence BCC, exige justification et applique la politique', async () => {
    await refresh();
    await quote({ ...manualInput(), justification: '' }).expect(400);
    const r = await quote(manualInput()).expect(201);
    expect(r.body.mode).toBe('MANUAL');
    expect(r.body.referenceRate).toBeNull();
    expect(r.body.snapshot.preparedById).toBe(f.userId);
    await request(app.getHttpServer())
      .put('/api/v1/exchange-rates/policy')
      .set(source.headers)
      .send({
        expectedVersion: 1,
        allowManual: false,
        quoteKind: 'MEAN',
        maxAgeHours: 96,
        quoteTtlMinutes: 15,
        confirmed: true,
      })
      .expect(200);
    await quote(manualInput()).expect(409);
  });
  it('fige la preuve à la remise et conserve l’opération malgré une nouvelle publication', async () => {
    await refresh();
    await funds();
    const q = (await quote(bccInput()).expect(201)).body;
    const order = (await createOrder(q)).body;
    const hand = (
      await request(app.getHttpServer())
        .post(`/api/v1/transfers/${order.id}/handover`)
        .set(source.headers)
        .send({ expectedVersion: 1, handedOver: true, rateValidated: true })
        .expect(201)
    ).body;
    expect(hand.rateEvidence.publicationId).toBe(q.publicationId);
    candidate = makeCandidate();
    await resetCooldown();
    await refresh();
    const done = (
      await request(app.getHttpServer())
        .post(`/api/v1/transfers/${order.id}/receive`)
        .set(receiver.headers)
        .send({ expectedVersion: 2, received: true })
        .expect(201)
    ).body;
    const rate = await db.exchangeRate.findFirstOrThrow({
      where: { companyId: f.companyId, transferOrderId: order.id },
    });
    expect(rate.rateEvidence).toEqual(hand.rateEvidence);
    expect(done.targetAmount).toBe('5000.00');
    const before = await db.financialOperation.findUniqueOrThrow({
      where: { id: done.operationId },
    });
    candidate = makeCandidate();
    await resetCooldown();
    await refresh();
    expect(
      await db.financialOperation.findUniqueOrThrow({ where: { id: done.operationId } }),
    ).toEqual(before);
    await expect(
      db.exchangeRate.update({ where: { id: rate.id }, data: { rate: '1' } }),
    ).rejects.toThrow();
    await expect(
      db.rateQuote.update({ where: { id: q.id }, data: { source: 'Falsification' } }),
    ).rejects.toThrow();
  });
  it('refuse une proposition devenue obsolète avant remise et ne réserve pas de fonds', async () => {
    await refresh();
    await funds();
    const q = (await quote(bccInput()).expect(201)).body,
      order = (await createOrder(q)).body;
    candidate = makeCandidate();
    await resetCooldown();
    await refresh();
    await request(app.getHttpServer())
      .post(`/api/v1/transfers/${order.id}/handover`)
      .set(source.headers)
      .send({ expectedVersion: 1, handedOver: true, rateValidated: true })
      .expect(409);
    expect((await db.transferOrder.findUniqueOrThrow({ where: { id: order.id } })).state).toBe(
      'DRAFT',
    );
  });
  it('bloque un taux trop ancien et une proposition après changement de politique', async () => {
    await quote({ ...manualInput(), manualEffectiveAt: '2020-01-01T00:00:00Z' }).expect(409);
    await funds();
    const q = (await quote(manualInput()).expect(201)).body;
    await request(app.getHttpServer())
      .put('/api/v1/exchange-rates/policy')
      .set(source.headers)
      .send({
        expectedVersion: 1,
        allowManual: true,
        quoteKind: 'SELL',
        maxAgeHours: 1,
        quoteTtlMinutes: 1,
        confirmed: true,
      })
      .expect(200);
    await createOrder(q, 409);
  });
  it('interdit la modification d’une publication et l’ajout tardif d’une cotation', async () => {
    const p = await refresh();
    await expect(
      db.bccPublication.update({
        where: { id: p.publicationId! },
        data: { sourceReference: 'Faux' },
      }),
    ).rejects.toThrow();
    await expect(
      db.bccQuotation.create({
        data: {
          publicationId: p.publicationId!,
          currency: 'JPY',
          unit: '1',
          unitEvidence: 'Ajout tardif',
          rawMean: '20',
          mean: '20',
        },
      }),
    ).rejects.toThrow();
  });
});
