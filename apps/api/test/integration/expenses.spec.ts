import 'reflect-metadata';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { expenseViewSchema, paymentVoucherSchema } from '@caissepro/shared';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app';
import { PrismaService } from '../../src/prisma.service';
import { PasswordService } from '../../src/auth/password.service';
import { CentralAccess } from '../../src/data/central-access';
import { LedgerService } from '../../src/data/ledger.service';
import { fixture } from './fixture';

describe('Circuit de dépenses avec API et PostgreSQL réels', () => {
  let app: INestApplication, db: PrismaService, hash: string;
  const password = 'Phrase-de-test!Depenses-2026';
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
  type F = Awaited<ReturnType<typeof fixture>>;
  async function login(f: F, userId = f.userId) {
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
  const limits = ['REQUEST', 'APPROVE', 'PAY'].map((action) => ({
    role: 'FINANCE_MANAGER',
    action,
    maximum: '5000.00',
  }));
  const doc = {
    fileName: 'facture.pdf',
    mimeType: 'application/pdf',
    dataBase64: Buffer.from('%PDF-1.4\nJustificatif synthétique').toString('base64'),
  };
  async function prepare({ funds = '100.00', configured = true, singleCash = true } = {}) {
    const f = await fixture(db, { singleCash });
    // La fixture accorde explicitement les permissions ; le code de rôle sert aux plafonds.
    await db.role.updateMany({
      where: { companyId: f.companyId, code: 'ADMIN_TEST' },
      data: { code: 'FINANCE_MANAGER' },
    });
    await db.userCredential.createMany({
      data: [f.userId, f.approverId, f.viewerId].map((userId) => ({ userId, passwordHash: hash })),
    });
    const user = await login(f),
      approver = await login(f, f.approverId),
      viewer = await login(f, f.viewerId);
    const ctx = { ...f.ctx, sessionId: user.sessionId };
    if (configured)
      for (const currency of ['USD', 'CDF'])
        await request(app.getHttpServer())
          .put(`/api/v1/expenses/policies/${currency}`)
          .set(user.headers)
          .send({ expectedVersion: null, requireEvidence: true, limits })
          .expect((r) => {
            if (r.status !== 200)
              throw new Error('Configuration refusée : ' + JSON.stringify(r.body));
          })
          .expect(200);
    if (funds !== '0.00')
      for (const currency of ['USD', 'CDF'] as const)
        await app.get(LedgerService).receipt(ctx, {
          agencyId: f.agencyId,
          idempotencyKey: randomUUID(),
          accountId: currency === 'USD' ? f.usd : f.cdf,
          counterAccountId: currency === 'USD' ? f.clearingUsd : f.clearingCdf,
          cashSessionId: f.sessionId,
          currency,
          amount: funds,
        });
    return { f, user, approver, viewer, ctx };
  }
  type Setup = Awaited<ReturnType<typeof prepare>>;
  async function sync(
    s: Setup,
    {
      amount = '20.00',
      currency = 'USD',
      documents = [doc],
      cashRegisterId = s.f.registerId,
    }: {
      amount?: string;
      currency?: string;
      documents?: (typeof doc)[];
      cashRegisterId?: string | null;
    } = {},
  ) {
    const id = randomUUID();
    const draft = {
      id,
      kind: 'expense-request',
      currency,
      amount,
      description: 'Achat de fournitures',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      expenseDetails: { beneficiary: 'Fournisseur de test', reference: 'FACT-001', documents },
    };
    const body = {
      draft,
      agencyId: s.f.agencyId,
      cashRegisterId,
      version: 1,
      expectedServerVersion: null,
    };
    await request(app.getHttpServer())
      .post('/api/v1/workspace/drafts/sync')
      .set(s.user.headers)
      .send(body)
      .expect(201);
    const source = await db.importedDraft.findUniqueOrThrow({
      where: {
        companyId_authorId_clientDraftId: {
          companyId: s.f.companyId,
          authorId: s.f.userId,
          clientDraftId: id,
        },
      },
    });
    return { source, body };
  }
  function submit(s: Setup, id: string, expectedVersion = 1) {
    return request(app.getHttpServer())
      .post(`/api/v1/expenses/drafts/${id}/submit`)
      .set(s.user.headers)
      .send({ expectedVersion, submitted: true });
  }
  function decide(s: Setup, id: string, decision = 'APPROVE', reason = '', expectedVersion = 1) {
    return request(app.getHttpServer())
      .post(`/api/v1/expenses/requests/${id}/decision`)
      .set(s.approver.headers)
      .send({ expectedVersion, decision, reason });
  }
  function pay(s: Setup, id: string, expectedVersion = 2) {
    return request(app.getHttpServer())
      .post(`/api/v1/expenses/requests/${id}/pay`)
      .set(s.user.headers)
      .send({ expectedVersion, paid: true });
  }
  async function pending(s: Setup, amount = '20.00', currency = 'USD') {
    const { source } = await sync(s, { amount, currency });
    return expenseViewSchema.parse((await submit(s, source.id).expect(201)).body);
  }
  it('synchronise sans soumettre, puis soumet une seule fois malgré six requêtes concurrentes', async () => {
    const s = await prepare(),
      { source } = await sync(s);
    expect(await db.expenseRequest.count({ where: { companyId: s.f.companyId } })).toBe(0);
    expect(await db.fundReservation.count({ where: { companyId: s.f.companyId } })).toBe(0);
    expect((await app.get(LedgerService).balance(s.ctx, s.f.usd)).balance).toBe('100.00');
    const results = await Promise.all(Array.from({ length: 6 }, () => submit(s, source.id)));
    expect(results.map((r) => r.status)).toEqual(Array(6).fill(201));
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    const ex = expenseViewSchema.parse(results[0]!.body);
    expect(ex.state).toBe('PENDING');
    expect(ex.voucher).toBeNull();
    expect(ex.evidence).toHaveLength(1);
    expect(
      await db.financialOperation.count({
        where: { companyId: s.f.companyId, kind: 'DISBURSEMENT' },
      }),
    ).toBe(0);
    await request(app.getHttpServer())
      .get(`/api/v1/expenses/requests/${ex.id}/evidence/${ex.evidence[0]!.id}`)
      .set(s.user.headers)
      .expect(200)
      .then((r) => expect(r.body).toEqual(doc));
  });
  it('exige un autre approbateur, réserve sans paiement, puis produit un bon immuable et idempotent', async () => {
    const s = await prepare(),
      ex = await pending(s);
    await request(app.getHttpServer())
      .post(`/api/v1/expenses/requests/${ex.id}/decision`)
      .set(s.user.headers)
      .send({ expectedVersion: 1, decision: 'APPROVE', reason: '' })
      .expect(409);
    await pay(s, ex.id, 1).expect(409);
    await request(app.getHttpServer())
      .post(`/api/v1/expenses/requests/${ex.id}/decision`)
      .set(s.viewer.headers)
      .send({ expectedVersion: 1, decision: 'APPROVE', reason: '' })
      .expect(403);
    const approved = expenseViewSchema.parse(
      (
        await decide(s, ex.id)
          .expect((r) => {
            if (r.status !== 201)
              throw new Error('Approbation refusée : ' + JSON.stringify(r.body));
          })
          .expect(201)
      ).body,
    );
    expect(approved.state).toBe('APPROVED');
    expect(approved.reservation).toBe('ACTIVE');
    expect(await app.get(LedgerService).balance(s.ctx, s.f.usd)).toMatchObject({
      balance: '100.00',
      reserved: '20.00',
      available: '80.00',
    });
    expect(
      await db.financialOperation.count({
        where: { companyId: s.f.companyId, kind: 'DISBURSEMENT' },
      }),
    ).toBe(0);
    await request(app.getHttpServer())
      .post(`/api/v1/expenses/requests/${ex.id}/pay`)
      .set(s.user.headers)
      .send({ expectedVersion: 2, paid: false })
      .expect(400);
    const voucher = paymentVoucherSchema.parse((await pay(s, ex.id).expect(201)).body);
    expect(voucher.number).toMatch(/^BON-/);
    expect(voucher.beneficiary).toBe('Fournisseur de test');
    expect((await pay(s, ex.id).expect(201)).body).toEqual(voucher);
    const newLogin = await login(s.f);
    s.user = newLogin;
    expect((await pay(s, ex.id).expect(201)).body).toEqual(voucher);
    expect(await db.ledgerEntry.count({ where: { operationId: voucher.operationId } })).toBe(2);
    expect(await db.paymentVoucher.count({ where: { companyId: s.f.companyId } })).toBe(1);
    expect(await app.get(LedgerService).balance(s.ctx, s.f.usd)).toMatchObject({
      balance: '80.00',
      reserved: '0.00',
      available: '80.00',
    });
    expect((await app.get(LedgerService).balance(s.ctx, s.f.cdf)).balance).toBe('100.00');
    await expect(
      new CentralAccess(db).run(
        { ...s.ctx, sessionId: newLogin.sessionId },
        (tx) => tx.$executeRaw`UPDATE "PaymentVoucher" SET amount=1 WHERE id=${voucher.id}::uuid`,
      ),
    ).rejects.toThrow();
    await expect(
      new CentralAccess(db).run({ ...s.ctx, sessionId: newLogin.sessionId }, (tx) =>
        tx.expenseRequest.update({
          where: { id: ex.id },
          data: { beneficiary: 'Autre bénéficiaire' },
        }),
      ),
    ).rejects.toThrow();
  });
  it('impose un rejet motivé et interdit ensuite le paiement', async () => {
    const s = await prepare(),
      ex = await pending(s);
    await decide(s, ex.id, 'REJECT', '').expect(400);
    const rejected = await decide(s, ex.id, 'REJECT', 'Justificatif incomplet').expect(201);
    expect(rejected.body.state).toBe('REJECTED');
    expect(rejected.body.approval.reason).toBe('Justificatif incomplet');
    expect((await decide(s, ex.id, 'REJECT', 'Justificatif incomplet').expect(201)).body.id).toBe(
      ex.id,
    );
    await decide(s, ex.id, 'APPROVE').expect(409);
    await pay(s, ex.id).expect(409);
    expect(await db.fundReservation.count({ where: { companyId: s.f.companyId } })).toBe(0);
    expect((await app.get(LedgerService).balance(s.ctx, s.f.usd)).balance).toBe('100.00');
  });
  it('refuse les versions périmées et toute réécriture d’un brouillon soumis', async () => {
    const s = await prepare(),
      { source, body } = await sync(s);
    await submit(s, source.id, 2).expect(409);
    const ex = (await submit(s, source.id).expect(201)).body;
    await decide(s, ex.id, 'APPROVE', '', 9).expect(409);
    await request(app.getHttpServer())
      .post('/api/v1/workspace/drafts/sync')
      .set(s.user.headers)
      .send({
        ...body,
        version: 2,
        expectedServerVersion: 1,
        draft: { ...body.draft, amount: '21.00' },
      })
      .expect(409);
    await expect(
      new CentralAccess(db).run(s.ctx, (tx) =>
        tx.importedDraft.update({
          where: { id: source.id },
          data: { amount: '21.00', version: 2 },
        }),
      ),
    ).rejects.toThrow();
    expect(
      (await db.expenseRequest.findUniqueOrThrow({ where: { id: ex.id } })).amount.toFixed(2),
    ).toBe('20.00');
  });
  it('refuse une soumission sans politique ou sans justificatif exigé', async () => {
    const s = await prepare({ configured: false }),
      { source } = await sync(s);
    await submit(s, source.id).expect(409);
    await request(app.getHttpServer())
      .put('/api/v1/expenses/policies/USD')
      .set(s.user.headers)
      .send({ expectedVersion: null, requireEvidence: true, limits })
      .expect((r) => {
        if (r.status !== 200) throw new Error('Configuration refusée : ' + JSON.stringify(r.body));
      })
      .expect(200);
    const noDoc = await sync(s, { documents: [] });
    await submit(s, noDoc.source.id).expect(409);
    const noCash = await sync(s, { cashRegisterId: null });
    await submit(s, noCash.source.id).expect(409);
    expect(await db.expenseRequest.count({ where: { companyId: s.f.companyId } })).toBe(0);
  });
  it('revalide les plafonds courants à la soumission, à l’approbation et au paiement', async () => {
    const s = await prepare(),
      { source } = await sync(s);
    const configure = async (action: string, maximum: string, version: number) =>
      request(app.getHttpServer())
        .put('/api/v1/expenses/policies/USD')
        .set(s.user.headers)
        .send({
          expectedVersion: version,
          requireEvidence: true,
          limits: limits.map((l) => (l.action === action ? { ...l, maximum } : l)),
        })
        .expect(200);
    await configure('REQUEST', '10.00', 1);
    await submit(s, source.id).expect(409);
    await configure('APPROVE', '10.00', 2);
    const ex = (await submit(s, source.id).expect(201)).body;
    await decide(s, ex.id).expect(409);
    await configure('PAY', '10.00', 3);
    await decide(s, ex.id).expect(201);
    await pay(s, ex.id).expect(409);
    expect(await db.paymentVoucher.count({ where: { companyId: s.f.companyId } })).toBe(0);
    expect((await app.get(LedgerService).balance(s.ctx, s.f.usd)).balance).toBe('100.00');
    await configure('PAY', '5000.00', 4);
    await pay(s, ex.id).expect(201);
    await request(app.getHttpServer())
      .put('/api/v1/expenses/policies/USD')
      .set(s.user.headers)
      .send({ expectedVersion: 1, requireEvidence: false, limits })
      .expect(409);
    await request(app.getHttpServer())
      .put('/api/v1/expenses/policies/USD')
      .set(s.viewer.headers)
      .send({ expectedVersion: 5, requireEvidence: false, limits })
      .expect(403);
  });
  it('refuse les fonds insuffisants sans laisser une approbation ou une réservation partielle', async () => {
    const s = await prepare({ funds: '10.00' }),
      ex = await pending(s, '20.00');
    await decide(s, ex.id).expect(409);
    expect(await db.expenseApproval.count({ where: { expenseRequestId: ex.id } })).toBe(0);
    expect(await db.fundReservation.count({ where: { expenseRequestId: ex.id } })).toBe(0);
    expect((await db.expenseRequest.findUniqueOrThrow({ where: { id: ex.id } })).state).toBe(
      'PENDING',
    );
    expect((await app.get(LedgerService).balance(s.ctx, s.f.usd)).balance).toBe('10.00');
  });
  it('protège les réservations concurrentes puis six paiements simultanés du même ordre', async () => {
    const s = await prepare(),
      a = await pending(s, '70.00'),
      b = await pending(s, '70.00');
    const results = await Promise.all([decide(s, a.id), decide(s, b.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const approved = results.find((r) => r.status === 201)!.body;
    const payments = await Promise.all(Array.from({ length: 6 }, () => pay(s, approved.id)));
    expect(payments.map((r) => r.status)).toEqual(Array(6).fill(201));
    expect(new Set(payments.map((r) => r.body.id)).size).toBe(1);
    expect(
      await db.financialOperation.count({
        where: { companyId: s.f.companyId, kind: 'DISBURSEMENT' },
      }),
    ).toBe(1);
    expect((await app.get(LedgerService).balance(s.ctx, s.f.usd)).balance).toBe('30.00');
  });
  it('paie deux ordres concurrents, numérote les bons une seule fois et sépare CDF/USD', async () => {
    const s = await prepare({ singleCash: false }),
      a = await pending(s, '60.00', 'USD'),
      b = await pending(s, '40.00', 'USD'),
      cdf = await pending(s, '25.00', 'CDF');
    await decide(s, a.id).expect(201);
    await decide(s, b.id).expect(201);
    await decide(s, cdf.id).expect(201);
    const results = await Promise.all([pay(s, a.id), pay(s, b.id), pay(s, cdf.id)]);
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(new Set(results.map((r) => r.body.number)).size).toBe(3);
    expect((await app.get(LedgerService).balance(s.ctx, s.f.usd)).balance).toBe('0.00');
    expect((await app.get(LedgerService).balance(s.ctx, s.f.cdf)).balance).toBe('75.00');
  });
  it('isole auteurs, entreprises et périmètres et refuse une session révoquée', async () => {
    const s = await prepare(),
      { source } = await sync(s);
    await request(app.getHttpServer())
      .get(`/api/v1/expenses/drafts/${source.id}`)
      .set(s.approver.headers)
      .expect(404);
    await request(app.getHttpServer())
      .post(`/api/v1/expenses/drafts/${source.id}/submit`)
      .set(s.approver.headers)
      .send({ expectedVersion: 1, submitted: true })
      .expect(404);
    const ex = (await submit(s, source.id).expect(201)).body;
    const foreign = await prepare();
    await request(app.getHttpServer())
      .get(`/api/v1/expenses/requests/${ex.id}`)
      .set(foreign.user.headers)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/api/v1/expenses/requests?cashRegisterId=${randomUUID()}`)
      .set(s.user.headers)
      .expect(403);
    const member = await db.companyMember.findUniqueOrThrow({
      where: { companyId_userId: { companyId: s.f.companyId, userId: s.f.approverId } },
    });
    await db.companyMember.update({ where: { id: member.id }, data: { active: false } });
    await decide(s, ex.id).expect(401);
    expect((await db.expenseRequest.findUniqueOrThrow({ where: { id: ex.id } })).state).toBe(
      'PENDING',
    );
  });
  it('annule tout le paiement si la création du bon échoue', async () => {
    const s = await prepare(),
      ex = await pending(s);
    await decide(s, ex.id).expect(201);
    await db.$executeRawUnsafe(
      `CREATE FUNCTION test_fail_voucher() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST_VOUCHER_FAILURE'; END $$`,
    );
    await db.$executeRawUnsafe(
      `CREATE TRIGGER test_fail_voucher BEFORE INSERT ON "PaymentVoucher" FOR EACH ROW EXECUTE FUNCTION test_fail_voucher()`,
    );
    try {
      await pay(s, ex.id).expect(409);
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER test_fail_voucher ON "PaymentVoucher"');
      await db.$executeRawUnsafe('DROP FUNCTION test_fail_voucher()');
    }
    expect((await db.expenseRequest.findUniqueOrThrow({ where: { id: ex.id } })).state).toBe(
      'APPROVED',
    );
    expect(
      await db.financialOperation.count({
        where: { companyId: s.f.companyId, kind: 'DISBURSEMENT' },
      }),
    ).toBe(0);
    expect(await app.get(LedgerService).balance(s.ctx, s.f.usd)).toMatchObject({
      balance: '100.00',
      reserved: '20.00',
    });
    await pay(s, ex.id).expect(201);
  });
  it('refuse le paiement après fermeture de caisse sans consommer la réservation', async () => {
    const s = await prepare(),
      ex = await pending(s);
    await decide(s, ex.id).expect(201);
    await new CentralAccess(db).run(s.ctx, (tx) =>
      tx.cashSession.update({
        where: { id: s.f.sessionId },
        data: { state: 'CLOSED', closedAt: new Date(), closedById: s.f.userId },
      }),
    );
    await pay(s, ex.id).expect(409);
    expect(
      await db.financialOperation.count({
        where: { companyId: s.f.companyId, kind: 'DISBURSEMENT' },
      }),
    ).toBe(0);
    expect(await app.get(LedgerService).balance(s.ctx, s.f.usd)).toMatchObject({
      balance: '100.00',
      reserved: '20.00',
    });
  });
  it('refuse les faux justificatifs et le dépassement de la taille totale avant soumission', async () => {
    const s = await prepare();
    const body = (documents: (typeof doc)[]) => ({
      draft: {
        id: randomUUID(),
        kind: 'expense-request',
        currency: 'USD',
        amount: '1.00',
        description: 'Contrôle des fichiers',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        expenseDetails: { beneficiary: 'Fournisseur', reference: '', documents },
      },
      agencyId: s.f.agencyId,
      cashRegisterId: s.f.registerId,
      version: 1,
      expectedServerVersion: null,
    });
    await request(app.getHttpServer())
      .post('/api/v1/workspace/drafts/sync')
      .set(s.user.headers)
      .send(body([{ ...doc, dataBase64: Buffer.from('<html>faux PDF</html>').toString('base64') }]))
      .expect(409);
    const bytes = Buffer.alloc(600000);
    bytes.write('%PDF-1.4');
    const large = { ...doc, dataBase64: bytes.toString('base64') };
    await request(app.getHttpServer())
      .post('/api/v1/workspace/drafts/sync')
      .set(s.user.headers)
      .send(body([large, large]))
      .expect(409);
    expect(await db.importedDraft.count({ where: { companyId: s.f.companyId } })).toBe(0);
    expect((await app.get(LedgerService).balance(s.ctx, s.f.usd)).balance).toBe('100.00');
  });
});
