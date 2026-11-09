import 'reflect-metadata';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app';
import { PrismaService } from '../../src/prisma.service';
import { PasswordService } from '../../src/auth/password.service';
import { CentralAccess } from '../../src/data/central-access';
import { LedgerService } from '../../src/data/ledger.service';
import { fixture } from './fixture';
describe('Administration et supervision sur PostgreSQL réel', () => {
  let app: INestApplication, db: PrismaService, hash: string;
  const password = 'Supervision-test!CaissePro-2026';
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
  async function setup() {
    const f = await fixture(db);
    await db.userCredential.createMany({
      data: [f.userId, f.approverId, f.viewerId].map((userId) => ({ userId, passwordHash: hash })),
    });
    const company = await db.company.findUniqueOrThrow({ where: { id: f.companyId } });
    const login = async (userId = f.userId) => {
      const deviceId = randomUUID();
      const r = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ companyCode: company.code, email: userId + '@example.test', password, deviceId })
        .expect(201);
      return {
        headers: { Authorization: 'Bearer ' + r.body.accessToken, 'X-CaissePro-Device': deviceId },
        profile: r.body.profile,
      };
    };
    const auth = await login();
    return { f, company, login, ...auth };
  }
  type S = Awaited<ReturnType<typeof setup>>;
  const get = (s: S, path = 'settings') =>
    request(app.getHttpServer())
      .get('/api/v1/management/' + path)
      .set(s.headers);
  const put = (s: S, path: string, b: unknown) =>
    request(app.getHttpServer())
      .put('/api/v1/management/' + path)
      .set(s.headers)
      .send(b as object);
  const post = (s: S, path: string, b: unknown) =>
    request(app.getHttpServer())
      .post('/api/v1/management/' + path)
      .set(s.headers)
      .send(b as object);
  const companyInput = (s: S) => ({
    expectedVersion: 1,
    name: s.company.name,
    address: 'Avenue de test 12',
    phone: '+243000000000',
    email: 'contact@example.test',
    taxId: 'TEST-ID',
    sessionMinutes: 480,
    idleMinutes: 15,
    offlineMinutes: 15,
    confirmed: true,
  });
  it('isole les paramètres d’entreprise, refuse les identités affirmées et les lecteurs non autorisés', async () => {
    const s = await setup(),
      other = await setup();
    const r = await get(s).expect(200);
    expect(r.body.company.id).toBe(s.f.companyId);
    expect(r.body.company.id).not.toBe(other.f.companyId);
    await put(s, 'company', { ...companyInput(s), companyId: other.f.companyId }).expect(400);
    const viewer = await s.login(s.f.viewerId);
    await get({ ...s, headers: viewer.headers }).expect(403);
    await request(app.getHttpServer()).get('/api/v1/management/settings').expect(401);
  });
  it('protège les modifications concurrentes et conserve les écritures et l’audit immuable', async () => {
    const s = await setup();
    const r = await Promise.all([
      put(s, 'company', companyInput(s)),
      put(s, 'company', { ...companyInput(s), name: 'Autre libellé' }),
    ]);
    expect(r.map((v) => v.status).sort()).toEqual([200, 409]);
    expect(await db.ledgerEntry.count({ where: { companyId: s.f.companyId } })).toBe(0);
    expect(
      await db.auditEvent.count({
        where: { companyId: s.f.companyId, action: 'COMPANY_CONFIGURED' },
      }),
    ).toBe(1);
    await expect(
      db.auditEvent.deleteMany({ where: { companyId: s.f.companyId } }),
    ).rejects.toThrow();
  });
  it('borne les sessions, révoque les anciennes et applique les nouvelles durées au serveur', async () => {
    const s = await setup();
    await put(s, 'company', { ...companyInput(s), sessionMinutes: 481 }).expect(400);
    await put(s, 'company', { ...companyInput(s), idleMinutes: 3, offlineMinutes: 4 }).expect(400);
    const changed = await put(s, 'company', {
      ...companyInput(s),
      sessionMinutes: 60,
      idleMinutes: 3,
      offlineMinutes: 0,
    }).expect(200);
    expect(changed.body.sessionsRevoked).toBe(true);
    await get(s).expect(401);
    const next = await s.login();
    expect(next.profile.offlineUntil).toBeNull();
    const session = await db.authSession.findUniqueOrThrow({
      where: { id: next.profile.sessionId },
    });
    expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBe(3600000);
    expect(session.idleExpiresAt.getTime() - session.createdAt.getTime()).toBe(180000);
    await request(app.getHttpServer()).post('/api/v1/auth/activity').set(next.headers).expect(201);
    const active = await db.authSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(active.idleExpiresAt.getTime() - active.lastSeenAt.getTime()).toBe(180000);
  });
  it('refuse la désactivation d’une agence ayant des caisses actives et une version périmée', async () => {
    const s = await setup();
    await put(s, 'agencies/' + s.f.agencyId, {
      expectedVersion: 1,
      name: 'Agence test',
      active: false,
      confirmed: true,
    }).expect(409);
    await put(s, 'agencies/' + s.f.agencyId, {
      expectedVersion: 1,
      name: 'Agence renommée',
      active: true,
      confirmed: true,
    }).expect(200);
    await put(s, 'agencies/' + s.f.agencyId, {
      expectedVersion: 1,
      name: 'Écrasement',
      active: true,
      confirmed: true,
    }).expect(409);
    const foreign = await setup();
    await put(s, 'agencies/' + foreign.f.agencyId, {
      expectedVersion: 1,
      name: 'Interdit',
      active: true,
      confirmed: true,
    }).expect(409);
  });
  it('déduplique les catégories et retire les catégories désactivées des suggestions sans altérer l’historique', async () => {
    const s = await setup(),
      id = randomUUID();
    const b = {
      id,
      expectedVersion: null,
      code: 'LOYER',
      name: 'Loyer',
      kind: 'EXPENSE',
      active: true,
      confirmed: true,
    };
    await post(s, 'categories', b).expect(201);
    await post(s, 'categories', b).expect(201);
    expect(await db.financialCategory.count({ where: { companyId: s.f.companyId } })).toBe(1);
    expect((await get(s, 'references').expect(200)).body.categories[0].name).toBe('Loyer');
    await post(s, 'categories', { ...b, expectedVersion: 1, active: false }).expect(201);
    expect((await get(s, 'references').expect(200)).body.categories).toHaveLength(0);
    await post(s, 'categories', { ...b, expectedVersion: 2, kind: 'RECEIPT' }).expect(409);
  });
  it('publie des taux exacts immuables, déduplique et exclut les taux futurs des suggestions', async () => {
    const s = await setup();
    const b = {
      id: randomUUID(),
      fromCurrency: 'USD',
      toCurrency: 'CDF',
      rate: '2800.123456789123',
      source: 'Banque de test',
      validFrom: new Date().toISOString(),
      confirmed: true,
    };
    await post(s, 'rates', b).expect(201);
    await post(s, 'rates', b).expect(201);
    await post(s, 'rates', { ...b, rate: '2801.0' }).expect(409);
    const r = await get(s, 'references').expect(200);
    expect(r.body.rates[0].rate).toBe(b.rate);
    await post(s, 'rates', {
      ...b,
      id: randomUUID(),
      validFrom: new Date(Date.now() + 86400000).toISOString(),
    }).expect(201);
    expect((await get(s, 'references').expect(200)).body.rates).toHaveLength(1);
    await expect(
      db.referenceExchangeRate.update({ where: { id: b.id }, data: { rate: '1.0' } }),
    ).rejects.toThrow();
  });
  it('limite statuts, notifications et audit aux caisses autorisées', async () => {
    const s = await setup(),
      ledger = app.get(LedgerService);
    const otherCounter = await db.treasuryAccount.create({
      data: {
        id: randomUUID(),
        companyId: s.f.companyId,
        agencyId: s.f.otherAgencyId,
        code: 'AUTRE-CONTREPARTIE',
        currency: 'USD',
        kind: 'CLEARING',
      },
    });
    for (const [accountId, cashSessionId, agencyId, counterAccountId, amount] of [
      [s.f.usd, s.f.sessionId, s.f.agencyId, s.f.clearingUsd, '10.00'],
      [s.f.otherUsd, s.f.otherSessionId, s.f.otherAgencyId, otherCounter.id, '20.00'],
    ] as const) {
      await ledger.receipt(s.f.ctx, {
        agencyId,
        accountId,
        counterAccountId,
        cashSessionId,
        amount,
        currency: 'USD',
        idempotencyKey: randomUUID(),
      });
    }
    const member = await db.companyMember.findUniqueOrThrow({
      where: { companyId_userId: { companyId: s.f.companyId, userId: s.f.userId } },
    });
    await db.cashRegisterGrant.deleteMany({
      where: { companyId: s.f.companyId, memberId: member.id, cashRegisterId: s.f.otherRegisterId },
    });
    const limited = await get(s, 'supervision').expect(200);
    expect(limited.body.cash.map((c: { id: string }) => c.id)).toEqual([s.f.registerId]);
    const visible = await get(s, 'audit').expect(200);
    expect(visible.body.items).toHaveLength(1);
    expect(visible.body.items[0].action).toBe('OPERATION_POSTED');
    await get(s, 'audit?cashRegisterId=' + s.f.otherRegisterId).expect(403);
    const roleId = randomUUID();
    await db.role.create({ data: { id: roleId, companyId: s.f.companyId, code: 'LECTEUR_TEST' } });
    await db.rolePermission.create({
      data: { companyId: s.f.companyId, roleId, permissionCode: 'ledger:read' },
    });
    await db.memberRole.deleteMany({ where: { companyId: s.f.companyId, memberId: member.id } });
    await db.memberRole.create({ data: { companyId: s.f.companyId, memberId: member.id, roleId } });
    expect((await get(s, 'supervision').expect(200)).body.users).toBeNull();
    await get(s, 'audit').expect(403);
  });
  it('soumet une catégorie de dépense sans permettre sa modification après création', async () => {
    const s = await setup();
    const expense = await app.get(LedgerService).requestExpense(s.f.ctx, {
      agencyId: s.f.agencyId,
      accountId: s.f.usd,
      currency: 'USD',
      amount: '1.00',
      description: 'Test du libellé historique',
    });
    await expect(
      app.get(CentralAccess).run(s.f.ctx, (tx) =>
        tx.expenseRequest.update({
          where: { id: expense.expenseRequestId },
          data: { category: 'Modification interdite', version: { increment: 1 } },
        }),
      ),
    ).rejects.toThrow();
  });
  it('exporte le journal autorisé en PDF et Excel sans transformer les libellés en formules', async () => {
    const s = await setup();
    const name = '=HYPERLINK("https://example.test","Entreprise")';
    await put(s, 'company', { ...companyInput(s), name }).expect(200);
    const pdf = await get(s, 'audit/pdf').expect(200);
    expect(Buffer.from(pdf.body.dataBase64, 'base64').subarray(0, 5).toString()).toBe('%PDF-');
    const xlsx = await get(s, 'audit/xlsx').expect(200),
      book = new ExcelJS.Workbook();
    await book.xlsx.load(Buffer.from(xlsx.body.dataBase64, 'base64') as never);
    expect(book.getWorksheet('Identite')!.getCell('B2').value).toBe(name);
    expect(book.getWorksheet('Identite')!.getCell('B2').type).toBe(ExcelJS.ValueType.String);
    expect(book.getWorksheet('Audit')!.rowCount).toBe(2);
    const viewer = await s.login(s.f.viewerId);
    await get({ ...s, headers: viewer.headers }, 'audit/pdf').expect(403);
    const foreign = await setup();
    await get(s, 'audit/xlsx?cashRegisterId=' + foreign.f.registerId).expect(403);
  });
});
