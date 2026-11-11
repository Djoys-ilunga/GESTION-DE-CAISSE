import 'reflect-metadata';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID as id } from 'node:crypto';
import ExcelJS from 'exceljs';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app';
import { PrismaService } from '../../src/prisma.service';
import { PasswordService } from '../../src/auth/password.service';
import { CentralAccess } from '../../src/data/central-access';
import { LedgerService } from '../../src/data/ledger.service';
import { fixture } from './fixture';

describe('Multidevise extensible : API et PostgreSQL réels', () => {
  let db: PrismaService, app: INestApplication, hash: string;
  const password = 'Monnaies-tests!Phrase2026';
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
  async function login(f: F, userId = f.userId) {
    const deviceId = id(),
      company = await db.company.findUniqueOrThrow({ where: { id: f.companyId } });
    const r = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ companyCode: company.code, email: `${userId}@example.test`, password, deviceId })
      .expect(201);
    return {
      headers: { Authorization: 'Bearer ' + r.body.accessToken, 'X-CaissePro-Device': deviceId },
      ctx: { companyId: f.companyId, userId, sessionId: r.body.profile.sessionId as string },
    };
  }
  async function setup() {
    const f = await fixture(db);
    await db.userCredential.createMany({
      data: [f.userId, f.approverId, f.viewerId].map((userId) => ({ userId, passwordHash: hash })),
    });
    return { ...f, ...(await login(f)) };
  }
  const put = (f: { headers: Record<string, string> }, path: string, body: object) =>
    request(app.getHttpServer())
      .put('/api/v1/money/' + path)
      .set(f.headers)
      .send(body);
  async function enable(f: Awaited<ReturnType<typeof setup>>, code: string) {
    await put(f, 'currencies', { code, active: true, expectedVersion: 0, confirmed: true }).expect(
      200,
    );
  }
  async function accounts(f: F, currency: string, cashRegisterId = f.registerId) {
    return {
      account: await db.treasuryAccount.findFirstOrThrow({
        where: { companyId: f.companyId, cashRegisterId, currency, kind: 'TREASURY' },
      }),
      counter: await db.treasuryAccount.findFirstOrThrow({
        where: {
          companyId: f.companyId,
          agencyId: cashRegisterId === f.registerId ? f.agencyId : f.otherAgencyId,
          currency,
          kind: 'CLEARING',
        },
      }),
    };
  }
  async function receipt(
    f: Awaited<ReturnType<typeof setup>>,
    currency: string,
    amount: string,
    key = id(),
  ) {
    const a = await accounts(f, currency);
    return app.get(LedgerService).receipt(f.ctx, {
      agencyId: f.agencyId,
      accountId: a.account.id,
      counterAccountId: a.counter.id,
      cashSessionId: f.sessionId,
      currency,
      amount,
      idempotencyKey: key,
    });
  }
  async function report(f: Awaited<ReturnType<typeof setup>>) {
    return (
      await request(app.getHttpServer())
        .get('/api/v1/reports?period=day')
        .set(f.headers)
        .expect(200)
    ).body;
  }
  it('initialise CDF/USD, publie un catalogue ISO et permet une seule devise active', async () => {
    const f = await setup();
    const r = await request(app.getHttpServer())
      .get('/api/v1/money/context')
      .set(f.headers)
      .expect(200);
    expect(r.body.companyCurrencies.map((c: { code: string }) => c.code)).toEqual(['CDF', 'USD']);
    expect(r.body.currencies.length).toBeGreaterThan(150);
    expect(r.body.currencies.find((c: { code: string }) => c.code === 'JPY').precision).toBe(0);
    expect(r.body.currencies.find((c: { code: string }) => c.code === 'KWD').precision).toBe(3);
    await put(f, 'currencies', {
      code: 'USD',
      active: false,
      expectedVersion: 1,
      confirmed: true,
    }).expect(200);
    await put(f, 'currencies', {
      code: 'CDF',
      active: false,
      expectedVersion: 1,
      confirmed: true,
    }).expect(409);
    const cashId = id();
    await request(app.getHttpServer())
      .post('/api/v1/cash/registers')
      .set(f.headers)
      .send({
        id: cashId,
        agencyId: f.agencyId,
        code: 'ONLYCDF',
        name: 'Caisse une devise',
        authorizedUserIds: [f.userId],
      })
      .expect(201);
    expect(
      (await db.treasuryAccount.findMany({ where: { cashRegisterId: cashId } })).map(
        (a) => a.currency,
      ),
    ).toEqual(['CDF']);
  });
  it('active plusieurs devises sans créer de mouvement ou altérer CDF/USD', async () => {
    const f = await setup();
    await receipt(f, 'USD', '123.45');
    for (const c of ['EUR', 'JPY', 'KWD', 'CLF']) await enable(f, c);
    const r = await report(f);
    expect(r.totals.map((t: { currency: string }) => t.currency)).toEqual([
      'CDF',
      'CLF',
      'EUR',
      'JPY',
      'KWD',
      'USD',
    ]);
    expect(r.totals.find((t: { currency: string }) => t.currency === 'USD').balance).toBe('123.45');
    expect(await db.financialOperation.count({ where: { companyId: f.companyId } })).toBe(1);
  });
  it('calcule exactement à 0, 2, 3 et 4 décimales, avec grands montants', async () => {
    const f = await setup();
    for (const c of ['JPY', 'KWD', 'CLF']) await enable(f, c);
    await receipt(f, 'JPY', '123');
    await receipt(f, 'KWD', '9007199254740993.001');
    await receipt(f, 'KWD', '0.002');
    await receipt(f, 'CLF', '0.0001');
    await receipt(f, 'CLF', '0.0002');
    const r = await report(f);
    for (const [c, v] of [
      ['JPY', '123'],
      ['KWD', '9007199254740993.003'],
      ['CLF', '0.0003'],
    ])
      expect(r.totals.find((t: { currency: string }) => t.currency === c).balance).toBe(v);
    await expect(receipt(f, 'JPY', '0.01')).rejects.toThrow('CURRENCY_PRECISION');
    await expect(receipt(f, 'KWD', '0.0001')).rejects.toThrow('CURRENCY_PRECISION');
  });
  it('enregistre les préférences par utilisateur sans convertir une opération', async () => {
    const f = await setup();
    await enable(f, 'EUR');
    await receipt(f, 'USD', '12.34');
    const body = {
      expectedVersion: 0,
      displayCurrency: 'EUR',
      favoriteCurrency: 'EUR',
      locale: 'en-US',
    };
    const r = await put(f, 'preferences', body).expect(200);
    expect(r.body.preferences).toMatchObject({
      displayCurrency: 'EUR',
      favoriteCurrency: 'EUR',
      locale: 'en-US',
      version: 1,
    });
    const other = await login(f, f.approverId);
    const own = await request(app.getHttpServer())
      .get('/api/v1/money/context')
      .set(other.headers)
      .expect(200);
    expect(own.body.preferences.displayCurrency).toBeNull();
    await put(f, 'preferences', body).expect(409);
    expect(
      (await report(f)).totals.find((t: { currency: string }) => t.currency === 'USD').balance,
    ).toBe('12.34');
    await put(f, 'preferences', { ...body, expectedVersion: 1, userId: f.approverId }).expect(400);
  });
  it('protège configuration, périmètres, préférences RLS et sessions révoquées', async () => {
    const f = await setup(),
      viewer = await login(f, f.viewerId);
    await put(viewer, 'currencies', {
      code: 'EUR',
      active: true,
      expectedVersion: 0,
      confirmed: true,
    }).expect(403);
    await put(f, 'preferences', {
      expectedVersion: 0,
      displayCurrency: 'JPY',
      favoriteCurrency: null,
      locale: 'fr-FR',
    }).expect(409);
    await app.get(CentralAccess).run(f.ctx, async (tx) => {
      expect(await tx.userMoneyPreference.findMany({ where: { userId: f.approverId } })).toEqual(
        [],
      );
    });
    const other = await setup();
    await put(f, 'currencies', {
      code: 'EUR',
      active: true,
      expectedVersion: 0,
      confirmed: true,
      companyId: other.companyId,
    }).expect(400);
    await db.authSession.update({
      where: { id: f.ctx.sessionId },
      data: { revokedAt: new Date() },
    });
    await put(f, 'preferences', {
      expectedVersion: 0,
      displayCurrency: null,
      favoriteCurrency: null,
      locale: 'fr-FR',
    }).expect(401);
  });
  it('convertit KWD vers JPY avec taux explicite, deux acteurs, réserve et HALF_UP à zéro décimale', async () => {
    const f = await setup();
    await enable(f, 'KWD');
    await enable(f, 'JPY');
    await receipt(f, 'KWD', '10.005');
    const receiver = await login(f, f.approverId);
    const r = await request(app.getHttpServer())
      .post('/api/v1/transfers/drafts')
      .set(f.headers)
      .send({
        id: id(),
        sourceCashRegisterId: f.registerId,
        destinationCashRegisterId: f.otherRegisterId,
        sourceCurrency: 'KWD',
        destinationCurrency: 'JPY',
        amount: '1.005',
        rate: '100',
        rateSource: 'Taux manuel test validé',
        description: 'Conversion contrôlée',
      })
      .expect(201);
    expect(r.body.targetAmount).toBe('101');
    const handed = await request(app.getHttpServer())
      .post(`/api/v1/transfers/${r.body.id}/handover`)
      .set(f.headers)
      .send({ expectedVersion: 1, handedOver: true, rateValidated: true })
      .expect(201);
    await put(f, 'currencies', {
      code: 'JPY',
      active: false,
      expectedVersion: 1,
      confirmed: true,
    }).expect(409);
    const done = await request(app.getHttpServer())
      .post(`/api/v1/transfers/${r.body.id}/receive`)
      .set(receiver.headers)
      .send({ expectedVersion: handed.body.version, received: true })
      .expect(201);
    expect(done.body.slip.rounding).toBe('HALF_UP_0');
    const v = await report(f);
    expect(v.totals.find((t: { currency: string }) => t.currency === 'KWD')).toMatchObject({
      balance: '9.000',
      receipts: '10.005',
    });
    expect(v.totals.find((t: { currency: string }) => t.currency === 'JPY')).toMatchObject({
      balance: '101',
      receipts: '0',
    });
  });
  it('refuse une dépense concurrente supérieure aux fonds KWD et déduplique les encaissements', async () => {
    const f = await setup();
    await enable(f, 'KWD');
    const key = id();
    await Promise.all(Array.from({ length: 5 }, () => receipt(f, 'KWD', '10.005', key)));
    const a = await accounts(f, 'KWD'),
      b = await accounts(f, 'KWD', f.otherRegisterId);
    const transfer = () =>
      app.get(LedgerService).transfer(f.ctx, {
        agencyId: f.agencyId,
        sourceAccountId: a.account.id,
        destinationAccountId: b.account.id,
        sourceSessionId: f.sessionId,
        destinationSessionId: f.otherSessionId,
        currency: 'KWD',
        amount: '8.001',
        idempotencyKey: id(),
      });
    const results = await Promise.allSettled([transfer(), transfer()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await app.get(LedgerService).balance(f.ctx, a.account.id)).available).toBe('2.004');
  });
  it('préserve les historiques désactivés et autorise la contre-écriture', async () => {
    const f = await setup();
    await enable(f, 'KWD');
    const operation = await receipt(f, 'KWD', '10.001');
    await put(f, 'currencies', {
      code: 'KWD',
      active: false,
      expectedVersion: 1,
      confirmed: true,
    }).expect(200);
    await expect(receipt(f, 'KWD', '1.000')).rejects.toThrow('CURRENCY_INACTIVE');
    expect(
      (await report(f)).totals.find((t: { currency: string }) => t.currency === 'KWD').balance,
    ).toBe('10.001');
    await app.get(LedgerService).reverse(f.ctx, {
      agencyId: f.agencyId,
      originalOperationId: operation.operationId,
      reasonCode: 'TEST_CORRECTION',
      sessions: { [(await accounts(f, 'KWD')).account.id]: f.sessionId },
      idempotencyKey: id(),
    });
    expect(
      (await report(f)).totals.find((t: { currency: string }) => t.currency === 'KWD').balance,
    ).toBe('0.000');
  });
  it('clôture toutes les devises réelles, refuse un comptage incomplet et fige le PV', async () => {
    const f = await setup();
    await enable(f, 'JPY');
    await enable(f, 'KWD');
    await receipt(f, 'KWD', '12.345');
    const counts = [
        { currency: 'CDF', amount: '0.00' },
        { currency: 'USD', amount: '0.00' },
        { currency: 'JPY', amount: '0' },
        { currency: 'KWD', amount: '12.344' },
      ],
      body = { cashRegisterId: f.registerId, sessionId: f.sessionId, confirmed: true };
    await request(app.getHttpServer())
      .post('/api/v1/reports/close')
      .set(f.headers)
      .send({ ...body, counts: counts.slice(0, 2) })
      .expect(409);
    const r = await request(app.getHttpServer())
      .post('/api/v1/reports/close')
      .set(f.headers)
      .send({ ...body, counts })
      .expect(201);
    expect(r.body.counts.find((c: { currency: string }) => c.currency === 'KWD')).toMatchObject({
      book: '12.345',
      counted: '12.344',
      difference: '-0.001',
    });
    expect(r.body.counts).toHaveLength(4);
  });
  it('exporte les nouvelles devises PDF/Excel en chaînes exactes', async () => {
    const f = await setup();
    await enable(f, 'KWD');
    await receipt(f, 'KWD', '9007199254740993.001');
    for (const format of ['pdf', 'xlsx']) {
      const r = await request(app.getHttpServer())
        .get('/api/v1/reports/' + format + '?period=day')
        .set(f.headers)
        .expect(200);
      const bytes = Buffer.from(r.body.dataBase64, 'base64');
      if (format === 'pdf') expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
      else {
        const book = new ExcelJS.Workbook();
        await book.xlsx.load(bytes as unknown as ExcelJS.Buffer);
        const values = book.worksheets
          .flatMap((w) => w.getSheetValues())
          .flatMap((r) => (Array.isArray(r) ? r : []));
        expect(values).toContain('9007199254740993.001');
        expect(values).toContain('KWD');
      }
    }
  });
  it('synchronise un brouillon JPY sans toucher aux soldes et refuse les décimales invalides', async () => {
    const f = await setup();
    await enable(f, 'JPY');
    const body = {
      agencyId: f.agencyId,
      cashRegisterId: f.registerId,
      version: 1,
      expectedServerVersion: null,
      draft: {
        id: id(),
        kind: 'receipt',
        currency: 'JPY',
        amount: '123',
        description: 'Brouillon sans écriture',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      },
    };
    await request(app.getHttpServer())
      .post('/api/v1/workspace/drafts/sync')
      .set(f.headers)
      .send(body)
      .expect(201);
    expect(await db.ledgerEntry.count({ where: { companyId: f.companyId } })).toBe(0);
    await request(app.getHttpServer())
      .post('/api/v1/workspace/drafts/sync')
      .set(f.headers)
      .send({ ...body, draft: { ...body.draft, id: id(), amount: '1.00' } })
      .expect(400);
  });
  it('ne valorise le reporting qu’avec les taux explicites du bon sens et ne comptabilise rien', async () => {
    const f = await setup();
    await enable(f, 'KWD');
    await receipt(f, 'KWD', '2.005');
    await receipt(f, 'USD', '10.00');
    await put(f, 'reporting', { currency: 'USD', expectedVersion: 1, confirmed: true }).expect(200);
    const refs = [];
    for (const [currency, rate] of [
      ['KWD', '3.000000000000'],
      ['CDF', '0.001000000000'],
    ]) {
      const rateId = id();
      await request(app.getHttpServer())
        .post('/api/v1/management/rates')
        .set(f.headers)
        .send({
          id: rateId,
          fromCurrency: currency,
          toCurrency: 'USD',
          rate,
          source: 'Source manuelle de test',
          validFrom: new Date(Date.now() - 1000).toISOString(),
          confirmed: true,
        })
        .expect(201);
      refs.push({ currency, rateId });
    }
    const body = { query: { period: 'day' }, currency: 'USD', rates: refs, confirmed: true };
    await request(app.getHttpServer())
      .post('/api/v1/reports/valuation')
      .set(f.headers)
      .send({ ...body, rates: [] })
      .expect(409);
    const r = await request(app.getHttpServer())
      .post('/api/v1/reports/valuation')
      .set(f.headers)
      .send(body)
      .expect(201);
    expect(r.body).toMatchObject({ totalBalance: '16.02', currency: 'USD', accounting: false });
    expect(r.body.items.find((i: { currency: string }) => i.currency === 'KWD')).toMatchObject({
      originalBalance: '2.005',
      equivalent: '6.02',
      rateId: refs[0]!.rateId,
    });
    expect(await db.financialOperation.count({ where: { companyId: f.companyId } })).toBe(2);
  });
  it('produit un reçu KWD puis un bon de sortie à trois décimales avec plafonds et approbation distincte', async () => {
    const initial = await setup();
    await db.role.updateMany({
      where: { companyId: initial.companyId, code: 'ADMIN_TEST' },
      data: { code: 'FINANCE_MANAGER' },
    });
    const f = { ...initial, ...(await login(initial)) },
      approver = await login(f, f.approverId);
    await enable(f, 'KWD');
    await request(app.getHttpServer())
      .put('/api/v1/expenses/policies/KWD')
      .set(f.headers)
      .send({
        expectedVersion: null,
        requireEvidence: false,
        limits: ['REQUEST', 'APPROVE', 'PAY'].map((action) => ({
          role: 'FINANCE_MANAGER',
          action,
          maximum: '30.000',
        })),
      })
      .expect(200);
    async function draft(kind: 'receipt' | 'expense-request', amount: string) {
      const draftId = id();
      await request(app.getHttpServer())
        .post('/api/v1/workspace/drafts/sync')
        .set(f.headers)
        .send({
          agencyId: f.agencyId,
          cashRegisterId: f.registerId,
          version: 1,
          expectedServerVersion: null,
          draft: {
            id: draftId,
            kind,
            currency: 'KWD',
            amount,
            description: 'Document monétaire exact',
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 600000).toISOString(),
            ...(kind === 'receipt'
              ? {
                  receiptDetails: {
                    provenance: 'Client test',
                    category: 'Vente',
                    reference: 'TEST',
                    supportingDocument: null,
                  },
                }
              : {
                  expenseDetails: {
                    beneficiary: 'Fournisseur test',
                    reference: 'TEST',
                    documents: [],
                  },
                }),
          },
        })
        .expect(201);
      return db.importedDraft.findFirstOrThrow({
        where: { companyId: f.companyId, clientDraftId: draftId },
      });
    }
    const source = await draft('receipt', '12.345');
    const receiptResponse = await request(app.getHttpServer())
      .post(`/api/v1/cash/drafts/${source.id}/confirm`)
      .set(f.headers)
      .send({ expectedVersion: 1, received: true })
      .expect(201);
    expect(receiptResponse.body).toMatchObject({ currency: 'KWD', amount: '12.345' });
    const spending = await draft('expense-request', '2.001');
    const submitted = await request(app.getHttpServer())
      .post(`/api/v1/expenses/drafts/${spending.id}/submit`)
      .set(f.headers)
      .send({ expectedVersion: 1, submitted: true })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/expenses/requests/${submitted.body.id}/decision`)
      .set(approver.headers)
      .send({ expectedVersion: 1, decision: 'APPROVE', reason: '' })
      .expect(201);
    await put(f, 'currencies', {
      code: 'KWD',
      active: false,
      expectedVersion: 1,
      confirmed: true,
    }).expect(409);
    const paid = await request(app.getHttpServer())
      .post(`/api/v1/expenses/requests/${submitted.body.id}/pay`)
      .set(f.headers)
      .send({ expectedVersion: 2, paid: true })
      .expect(201);
    expect(paid.body).toMatchObject({ currency: 'KWD', amount: '2.001' });
    const summary = await report(f);
    expect(summary.totals.find((t: { currency: string }) => t.currency === 'KWD')).toMatchObject({
      receipts: '12.345',
      disbursements: '2.001',
      balance: '10.344',
    });
  });
  it('conserve au moins une devise active sous deux désactivations concurrentes', async () => {
    const f = await setup();
    const r = await Promise.all(
      ['CDF', 'USD'].map((code) =>
        put(f, 'currencies', { code, active: false, expectedVersion: 1, confirmed: true }),
      ),
    );
    expect(r.filter((v) => v.status === 200)).toHaveLength(1);
    expect(
      await db.companyCurrency.count({ where: { companyId: f.companyId, active: true } }),
    ).toBe(1);
  });
  it('accepte une nouvelle devise officielle du catalogue sans modifier les contrats ni le schéma', async () => {
    const f = await setup();
    await db.currencyDefinition.create({
      data: {
        code: 'XCG',
        numericCode: '532',
        name: 'Florin des Caraïbes',
        symbol: 'Cg',
        precision: 2,
        sourceDate: '2025-03-31',
      },
    });
    await enable(f, 'XCG');
    await receipt(f, 'XCG', '12.34');
    expect(
      (await report(f)).totals.find((t: { currency: string }) => t.currency === 'XCG').balance,
    ).toBe('12.34');
    expect(await db.companyCurrency.count({ where: { companyId: f.companyId, code: 'EUR' } })).toBe(
      0,
    );
  });
  it.each([
    ['KWD', '1.2345', '1.235'],
    ['CLF', '1.23445', '1.2345'],
  ])('convertit JPY vers %s avec la précision de destination', async (currency, rate, expected) => {
    const f = await setup();
    await enable(f, 'JPY');
    await enable(f, currency);
    await receipt(f, 'JPY', '10');
    const receiver = await login(f, f.approverId);
    const r = await request(app.getHttpServer())
      .post('/api/v1/transfers/drafts')
      .set(f.headers)
      .send({
        id: id(),
        sourceCashRegisterId: f.registerId,
        destinationCashRegisterId: f.otherRegisterId,
        sourceCurrency: 'JPY',
        destinationCurrency: currency,
        amount: '1',
        rate,
        rateSource: 'Taux manuel de test',
        description: 'Arrondi de destination',
      })
      .expect(201);
    expect(r.body.targetAmount).toBe(expected);
    const h = await request(app.getHttpServer())
      .post(`/api/v1/transfers/${r.body.id}/handover`)
      .set(f.headers)
      .send({ expectedVersion: 1, handedOver: true, rateValidated: true })
      .expect(201);
    const done = await request(app.getHttpServer())
      .post(`/api/v1/transfers/${r.body.id}/receive`)
      .set(receiver.headers)
      .send({ expectedVersion: h.body.version, received: true })
      .expect(201);
    expect(done.body.targetAmount).toBe(expected);
  });
});
