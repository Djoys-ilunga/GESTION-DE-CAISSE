import 'reflect-metadata';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { reportSnapshotSchema } from '@caissepro/shared';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app';
import { PrismaService } from '../../src/prisma.service';
import { PasswordService } from '../../src/auth/password.service';
import { CentralAccess } from '../../src/data/central-access';
import { LedgerService } from '../../src/data/ledger.service';
import { reportRange } from '../../src/reports/reports.service';
import { fixture } from './fixture';
describe('Rapports et clôtures sur PostgreSQL réel', () => {
  let app: INestApplication, db: PrismaService, hash: string;
  const password = 'Rapports-test!2026Secure';
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
  async function setup(amount = '100.00') {
    const f = await fixture(db);
    await db.userCredential.createMany({
      data: [f.userId, f.approverId, f.viewerId].map((userId) => ({ userId, passwordHash: hash })),
    });
    const deviceId = randomUUID(),
      company = await db.company.findUniqueOrThrow({ where: { id: f.companyId } });
    const auth = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ companyCode: company.code, email: `${f.userId}@example.test`, password, deviceId })
      .expect(201);
    const headers = {
      Authorization: 'Bearer ' + auth.body.accessToken,
      'X-CaissePro-Device': deviceId,
    };
    const ctx = { ...f.ctx, sessionId: auth.body.profile.sessionId as string },
      ledger = app.get(LedgerService);
    for (const currency of ['USD', 'CDF'] as const)
      await ledger.receipt(ctx, {
        agencyId: f.agencyId,
        idempotencyKey: randomUUID(),
        accountId: currency === 'USD' ? f.usd : f.cdf,
        counterAccountId: currency === 'USD' ? f.clearingUsd : f.clearingCdf,
        cashSessionId: f.sessionId,
        currency,
        amount: currency === 'USD' ? amount : '280000.00',
      });
    return { f, headers, ctx, ledger };
  }
  type S = Awaited<ReturnType<typeof setup>>;
  const get = (s: S, path = '') =>
    request(app.getHttpServer())
      .get('/api/v1/reports' + path)
      .set(s.headers);
  const close = (s: S, USD = '99.50', CDF = '280000.00') =>
    request(app.getHttpServer()).post('/api/v1/reports/close').set(s.headers).send({
      cashRegisterId: s.f.registerId,
      sessionId: s.f.sessionId,
      confirmed: true,
      countedUSD: USD,
      countedCDF: CDF,
    });
  it('calcule les soldes exacts, sépare les devises et ne projette pas les jours futurs', async () => {
    const s = await setup('9999999999999999.99');
    const r = await get(s).expect(200);
    const report = reportSnapshotSchema.parse(r.body);
    expect(report.totals.find((t) => t.currency === 'USD')?.balance).toBe('9999999999999999.99');
    expect(report.totals.find((t) => t.currency === 'CDF')?.balance).toBe('280000.00');
    expect(report.rows).toHaveLength(2);
    expect(
      report.daily.every(
        (d) => d.date <= new Date(Date.now() + 3600000).toISOString().slice(0, 10),
      ),
    ).toBe(true);
    expect(report.pending.map((p) => p.count)).toEqual([0, 0]);
  });
  it('exclut transferts et FX des encaissements et conserve un vrai solde de trésorerie', async () => {
    const s = await setup();
    await s.ledger.transfer(s.ctx, {
      agencyId: s.f.agencyId,
      idempotencyKey: randomUUID(),
      sourceAccountId: s.f.usd,
      destinationAccountId: s.f.otherUsd,
      sourceSessionId: s.f.sessionId,
      destinationSessionId: s.f.otherSessionId,
      currency: 'USD',
      amount: '20.00',
    });
    const r = await get(s).expect(200);
    expect(r.body.totals.find((t: { currency: string }) => t.currency === 'USD')).toMatchObject({
      balance: '100.00',
      receipts: '100.00',
      disbursements: '0.00',
    });
    expect(r.body.rows.filter((r: { kind: string }) => r.kind === 'TRANSFER')).toHaveLength(2);
  });
  it('reflète les contre-écritures dans les indicateurs nets et les soldes', async () => {
    const s = await setup();
    const receipt = await db.financialOperation.findFirstOrThrow({
      where: { companyId: s.f.companyId, currency: 'USD' },
    });
    await s.ledger.reverse(s.ctx, {
      agencyId: s.f.agencyId,
      idempotencyKey: randomUUID(),
      originalOperationId: receipt.id,
      reasonCode: 'TEST_REVERSAL',
      sessions: { [s.f.usd]: s.f.sessionId },
    });
    const r = await get(s).expect(200);
    expect(r.body.totals.find((t: { currency: string }) => t.currency === 'USD')).toMatchObject({
      balance: '0.00',
      receipts: '0.00',
      todayReceipts: '0.00',
    });
  });
  it('applique les filtres de caisse, agence, utilisateur et type sur les vrais mouvements', async () => {
    const s = await setup();
    const r = await get(
      s,
      `?cashRegisterId=${s.f.registerId}&agencyId=${s.f.agencyId}&kind=RECEIPT&userId=${s.f.userId}`,
    ).expect(200);
    expect(r.body.rows).toHaveLength(2);
    expect(r.body.cash).toHaveLength(2);
    expect(r.body.groups.some((g: { dimension: string }) => g.dimension === 'agency')).toBe(true);
    expect((await get(s, '?userId=' + s.f.approverId).expect(200)).body.rows).toHaveLength(0);
  });
  it('isole les entreprises et empêche les filtres de caisses non affectées, y compris les exports', async () => {
    const s = await setup(),
      other = await fixture(db);
    await get(s, '?cashRegisterId=' + other.registerId).expect(403);
    await get(s, '/pdf?cashRegisterId=' + other.registerId).expect(403);
    const member = await db.companyMember.findFirstOrThrow({
      where: { companyId: s.f.companyId, userId: s.f.userId },
    });
    await db.cashRegisterGrant.deleteMany({
      where: { companyId: s.f.companyId, memberId: member.id, cashRegisterId: s.f.registerId },
    });
    const r = await get(s).expect(200);
    expect(r.body.rows).toHaveLength(0);
    expect(r.body.cash.every((c: { id: string }) => c.id === s.f.otherRegisterId)).toBe(true);
  });
  it('présente les demandes en attente et les décisions approuvées/rejetées sans les confondre avec les paiements', async () => {
    const s = await setup();
    const requests: { expenseRequestId: string }[] = [];
    for (const amount of ['10.00', '20.00', '30.00'])
      requests.push(
        await s.ledger.requestExpense(s.ctx, {
          agencyId: s.f.agencyId,
          accountId: s.f.usd,
          currency: 'USD',
          amount,
          description: 'Demande de test',
        }),
      );
    await s.ledger.approveExpense(s.f.approveCtx, requests[0]!.expenseRequestId);
    await app
      .get(CentralAccess)
      .run(s.f.approveCtx, (tx) =>
        s.ledger.decideExpenseInTransaction(
          tx,
          s.f.approveCtx,
          requests[1]!.expenseRequestId,
          'REJECT',
          'Justificatif incomplet',
        ),
      );
    const r = await get(s).expect(200);
    expect(r.body.pending.find((p: { currency: string }) => p.currency === 'USD')).toMatchObject({
      count: 1,
      amount: '30.00',
    });
    expect(r.body.decisions.map((d: { state: string }) => d.state).sort()).toEqual([
      'APPROVE',
      'REJECT',
    ]);
    expect(r.body.decisions.find((d: { state: string }) => d.state === 'REJECT')).toMatchObject({
      requestState: 'REJECTED',
      reason: 'Justificatif incomplet',
    });
    expect(r.body.decisions.find((d: { state: string }) => d.state === 'APPROVE')).toMatchObject({
      requestState: 'APPROVED',
      reason: null,
    });
    const exported = await get(s, '/xlsx').expect(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(exported.body.dataBase64, 'base64') as never);
    const decisions = workbook.getWorksheet('Decisions')!;
    expect(decisions.columnCount).toBe(10);
    const row = [2, 3].find((n) => decisions.getCell(n, 2).value === 'REJECT')!;
    expect(decisions.getCell(row, 9).value).toBe('REJECTED');
    expect(decisions.getCell(row, 10).value).toBe('Justificatif incomplet');
    expect(r.body.totals.find((t: { currency: string }) => t.currency === 'USD')).toMatchObject({
      disbursements: '0.00',
      reserved: '10.00',
    });
  });
  it('refuse une session révoquée et une requête sans authentification', async () => {
    const s = await setup();
    await request(app.getHttpServer()).get('/api/v1/reports').expect(401);
    await db.authSession.update({
      where: { id: s.ctx.sessionId },
      data: { revokedAt: new Date() },
    });
    await get(s).expect(401);
  });
  it('clôture avec comptage, fige le PV et constate l’écart sans corriger le solde', async () => {
    const s = await setup();
    const r = await close(s).expect(201);
    expect(r.body.counts.find((v: { currency: string }) => v.currency === 'USD')).toEqual({
      currency: 'USD',
      book: '100.00',
      counted: '99.50',
      difference: '-0.50',
    });
    expect((await s.ledger.balance(s.ctx, s.f.usd)).balance).toBe('100.00');
    expect((await db.cashSession.findUniqueOrThrow({ where: { id: s.f.sessionId } })).state).toBe(
      'CLOSED',
    );
    const report = await get(s).expect(200);
    expect(report.body.closures).toHaveLength(1);
    expect(
      report.body.discrepancies.find((d: { currency: string }) => d.currency === 'USD'),
    ).toMatchObject({ measured: 1, count: 1, net: '-0.50' });
    expect(report.body.unmeasuredClosures).toBe(0);
    await expect(
      app
        .get(CentralAccess)
        .run(
          s.ctx,
          (tx) =>
            tx.$executeRaw`UPDATE "CashClosureReport" SET snapshot='{}'::jsonb WHERE id=${r.body.id}::uuid`,
        ),
    ).rejects.toThrow();
  });
  it('déduplique des clôtures concurrentes et refuse un comptage contradictoire', async () => {
    const s = await setup();
    const responses = await Promise.all([close(s), close(s), close(s)]);
    expect(responses.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(new Set(responses.map((r) => r.body.id)).size).toBe(1);
    await close(s, '98.00').expect(409);
  });
  it('refuse une clôture avec fonds réservés et annule la fermeture', async () => {
    const s = await setup();
    const e = await s.ledger.requestExpense(s.ctx, {
      agencyId: s.f.agencyId,
      accountId: s.f.usd,
      currency: 'USD',
      amount: '10.00',
      description: 'Réservation',
    });
    await s.ledger.approveExpense(s.f.approveCtx, e.expenseRequestId);
    await close(s).expect(409);
    expect((await db.cashSession.findUniqueOrThrow({ where: { id: s.f.sessionId } })).state).toBe(
      'OPEN',
    );
    expect(await db.cashClosureReport.count({ where: { companyId: s.f.companyId } })).toBe(0);
  });
  it('signale une clôture historique sans inventer un écart nul', async () => {
    const s = await setup();
    await app.get(CentralAccess).run(s.ctx, (tx) =>
      tx.cashSession.update({
        where: { id: s.f.sessionId },
        data: { state: 'CLOSED', closedById: s.f.userId, closedAt: new Date() },
      }),
    );
    const r = await get(s).expect(200);
    expect(r.body.unmeasuredClosures).toBe(1);
    expect(r.body.discrepancies.every((d: { net: string | null }) => d.net === null)).toBe(true);
    expect(r.body.closures).toHaveLength(0);
  });
  it('produit un PDF réel et un classeur Excel structuré sans perte de précision ni formule injectée', async () => {
    const s = await setup('9999999999999999.99');
    await db.company.update({
      where: { id: s.f.companyId },
      data: { name: '=HYPERLINK("https://example.test","éè")' },
    });
    const pdf = await get(s, '/pdf').expect(200);
    expect(Buffer.from(pdf.body.dataBase64, 'base64').subarray(0, 5).toString()).toBe('%PDF-');
    const xlsx = await get(s, '/xlsx').expect(200);
    const w = new ExcelJS.Workbook();
    await w.xlsx.load(Buffer.from(xlsx.body.dataBase64, 'base64') as never);
    expect(w.getWorksheet('Identite')?.getCell('B2').value).toBe(
      '=HYPERLINK("https://example.test","éè")',
    );
    expect(w.getWorksheet('Synthese')?.getCell('B3').value).toBe('9999999999999999.99');
    expect(w.getWorksheet('Identite')?.getCell('B2').type).toBe(ExcelJS.ValueType.String);
    expect(w.getWorksheet('Journal')?.rowCount).toBe(3);
  });
  it('refuse les périodes impossibles, trop longues et les paramètres inconnus', async () => {
    const s = await setup();
    await get(s, '?period=custom&from=2020-01-01&to=2026-01-01').expect(409);
    await get(s, '?date=2026-02-30').expect(400);
    await get(s, '?companyId=' + s.f.companyId).expect(400);
  });
});
describe('Calendrier de rapports', () => {
  it('utilise Kinshasa, la semaine ISO et les années bissextiles', () => {
    expect(reportRange({ period: 'day' }, new Date('2026-11-08T23:30:00Z')).from).toBe(
      '2026-11-09',
    );
    expect(reportRange({ period: 'week', date: '2026-11-09' }).to).toBe('2026-11-15');
    expect(reportRange({ period: 'month', date: '2024-02-29' }).to).toBe('2024-02-29');
    expect(reportRange({ period: 'year', date: '2024-02-29' }).from).toBe('2024-01-01');
  });
});
