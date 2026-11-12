import 'reflect-metadata';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { ROLE_PERMISSIONS, type SessionProfile } from '@caissepro/shared';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app';
import { PrismaService } from '../../src/prisma.service';
import { PasswordService } from '../../src/auth/password.service';
import { installRoles } from '../../src/auth/admin.service';
import { LedgerService } from '../../src/data/ledger.service';
import { fixture } from './fixture';

describe('Étape 13-A : rôles standard, API et PostgreSQL réels', () => {
  let app: INestApplication, db: PrismaService, hash: string;
  let f: Awaited<ReturnType<typeof fixture>>;
  const password = 'Phrase-synthetique-tests!2026';
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
  beforeEach(async () => {
    f = await fixture(db);
    await db.$transaction((tx) => installRoles(tx, f.companyId));
    // Replace the fixture's all-powerful test role with the actual shipped roles.
    for (const [userId, code] of [
      [f.userId, 'ADMINISTRATOR'],
      [f.approverId, 'FINANCE_MANAGER'],
      [f.viewerId, 'CASHIER'],
    ] as const) {
      const member = await db.companyMember.findUniqueOrThrow({
        where: { companyId_userId: { companyId: f.companyId, userId } },
      });
      const role = await db.role.findUniqueOrThrow({
        where: { companyId_code: { companyId: f.companyId, code } },
      });
      await db.memberRole.deleteMany({ where: { memberId: member.id } });
      await db.memberRole.create({
        data: { companyId: f.companyId, memberId: member.id, roleId: role.id },
      });
      await db.userCredential.create({ data: { userId, passwordHash: hash } });
    }
  });
  async function login(userId = f.userId) {
    const deviceId = randomUUID();
    const company = await db.company.findUniqueOrThrow({ where: { id: f.companyId } });
    const r = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ companyCode: company.code, email: `${userId}@example.test`, password, deviceId })
      .expect(201);
    return {
      headers: { Authorization: `Bearer ${r.body.accessToken}`, 'X-CaissePro-Device': deviceId },
      profile: r.body.profile as SessionProfile,
      ctx: { companyId: f.companyId, userId, sessionId: r.body.profile.sessionId as string },
    };
  }
  type Session = Awaited<ReturnType<typeof login>>;
  const post = (s: Session, path: string, body: object = {}) =>
    request(app.getHttpServer())
      .post('/api/v1/' + path)
      .set(s.headers)
      .send(body);
  async function assign(
    s: Session,
    userId: string,
    roles: string[],
    cashIds = [f.registerId],
    agencyIds = [f.agencyId],
  ) {
    return request(app.getHttpServer())
      .put(`/api/v1/admin/users/${userId}/access`)
      .set(s.headers)
      .send({
        expectedVersion: 1,
        access: { active: true, roles, agencyIds, cashRegisterIds: cashIds },
      });
  }
  async function combined() {
    const old = await login();
    expect(
      (
        await assign(
          old,
          f.userId,
          ['ADMINISTRATOR', 'FINANCE_MANAGER'],
          [f.registerId, f.otherRegisterId],
          [f.agencyId, f.otherAgencyId],
        )
      ).status,
    ).toBe(200);
    return login();
  }
  async function receipt(s: Session, kind = 'receipt', amount = '25.00') {
    const id = randomUUID();
    await post(s, 'workspace/drafts/sync', {
      draft: {
        id,
        kind,
        currency: 'USD',
        amount,
        description: 'Opération synthétique de test',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        ...(kind === 'receipt'
          ? {
              receiptDetails: {
                provenance: 'Client de test',
                category: 'VENTE',
                reference: 'TEST-13A',
                supportingDocument: null,
              },
            }
          : {
              expenseDetails: {
                category: 'Fournitures',
                beneficiary: 'Fournisseur test',
                reference: 'TEST-13A',
                documents: [],
              },
            }),
      },
      agencyId: f.agencyId,
      cashRegisterId: f.registerId,
      version: 1,
      expectedServerVersion: null,
    }).expect(201);
    return db.importedDraft.findUniqueOrThrow({
      where: {
        companyId_authorId_clientDraftId: {
          companyId: f.companyId,
          authorId: s.ctx.userId,
          clientDraftId: id,
        },
      },
    });
  }
  it('ne donne aucun droit financier implicite à l’administrateur et bloque les appels directs', async () => {
    const s = await login();
    expect(new Set(s.profile.permissions)).toEqual(new Set(ROLE_PERMISSIONS.ADMINISTRATOR));
    for (const path of [
      `cash/registers/${f.registerId}/open`,
      `cash/drafts/${randomUUID()}/confirm`,
      'workspace/drafts/sync',
      `expenses/drafts/${randomUUID()}/submit`,
      `expenses/requests/${randomUUID()}/decision`,
      `expenses/requests/${randomUUID()}/pay`,
      'transfers/drafts',
      'reports/close',
    ])
      await post(s, path).expect(403);
    expect(await db.financialOperation.count({ where: { companyId: f.companyId } })).toBe(0);
  });
  it('cumule les rôles uniquement après attribution explicite et révoque la session précédente', async () => {
    const old = await login();
    const r = await assign(old, f.userId, ['ADMINISTRATOR', 'FINANCE_MANAGER']);
    expect(r.status).toBe(200);
    await request(app.getHttpServer()).get('/api/v1/cash/registers').set(old.headers).expect(401);
    const s = await login();
    expect(new Set(s.profile.roles)).toEqual(new Set(['ADMINISTRATOR', 'FINANCE_MANAGER']));
    expect(new Set(s.profile.permissions)).toEqual(
      new Set([...ROLE_PERMISSIONS.ADMINISTRATOR, ...ROLE_PERMISSIONS.FINANCE_MANAGER]),
    );
    expect(s.profile.cashRegisters.map((c) => c.id)).toEqual([f.registerId]);
    const role = await db.role.findUniqueOrThrow({
      where: { companyId_code: { companyId: f.companyId, code: 'ADMINISTRATOR' } },
      include: { permissions: true },
    });
    expect(new Set(role.permissions.map((p) => p.permissionCode))).toEqual(
      new Set(ROLE_PERMISSIONS.ADMINISTRATOR),
    );
  });
  it('refuse les périmètres incohérents ou étrangers sans changer les affectations', async () => {
    const admin = await login();
    expect(
      (await assign(admin, f.viewerId, ['CASHIER'], [f.otherRegisterId], [f.agencyId])).status,
    ).toBe(403);
    const other = await fixture(db);
    expect(
      (await assign(admin, f.viewerId, ['CASHIER'], [other.registerId], [other.agencyId])).status,
    ).toBe(403);
    expect(
      await db.cashRegisterGrant.count({
        where: { companyId: f.companyId, member: { userId: f.viewerId } },
      }),
    ).toBe(0);
  });
  it('refuse au caissier non affecté l’ouverture, la clôture et le journal d’une autre caisse', async () => {
    const s = await login(f.viewerId);
    expect(s.profile.permissions).toContain('session:manage');
    expect(s.profile.cashRegisters).toEqual([]);
    await post(s, `cash/registers/${f.registerId}/open`).expect(403);
    await post(s, 'reports/close', {
      cashRegisterId: f.registerId,
      sessionId: f.sessionId,
      confirmed: true,
      counts: [
        { currency: 'USD', amount: '0.00' },
        { currency: 'CDF', amount: '0.00' },
      ],
    }).expect(403);
    await request(app.getHttpServer())
      .get(`/api/v1/reports?cashRegisterId=${f.registerId}`)
      .set(s.headers)
      .expect(403);
    const cash = await request(app.getHttpServer())
      .get('/api/v1/cash/registers')
      .set(s.headers)
      .expect(200);
    expect(cash.body.items).toEqual([]);
  });
  it('permet au caissier affecté de clôturer, ouvrir, confirmer une entrée et consulter le journal', async () => {
    const admin = await login();
    expect((await assign(admin, f.viewerId, ['CASHIER'])).status).toBe(200);
    const s = await login(f.viewerId);
    await post(s, 'reports/close', {
      cashRegisterId: f.registerId,
      sessionId: f.sessionId,
      confirmed: true,
      counts: [
        { currency: 'USD', amount: '0.00' },
        { currency: 'CDF', amount: '0.00' },
      ],
    }).expect(201);
    await post(s, `cash/registers/${f.registerId}/open`).expect(201);
    const draft = await receipt(s);
    const confirmed = await post(s, `cash/drafts/${draft.id}/confirm`, {
      expectedVersion: 1,
      received: true,
    }).expect(201);
    expect(confirmed.body.amount).toBe('25.00');
    await post(s, `cash/drafts/${draft.id}/confirm`, { expectedVersion: 1, received: true }).expect(
      201,
    );
    const journal = await request(app.getHttpServer())
      .get(`/api/v1/reports?cashRegisterId=${f.registerId}`)
      .set(s.headers)
      .expect(200);
    expect(journal.body.rows).toHaveLength(1);
    expect(journal.body.rows[0].currency).toBe('USD');
    await post(s, `expenses/requests/${randomUUID()}/decision`).expect(403);
    await post(s, `transfers/${randomUUID()}/handover`, {
      expectedVersion: 1,
      handedOver: true,
      rateValidated: true,
    }).expect(403);
    await post(s, `transfers/${randomUUID()}/receive`, {
      expectedVersion: 2,
      received: true,
    }).expect(403);
    await request(app.getHttpServer())
      .get(`/api/v1/reports?cashRegisterId=${f.otherRegisterId}`)
      .set(s.headers)
      .expect(403);
  });
  it('interdit l’auto-approbation même à Administrateur + Finance, puis autorise décision et paiement séparés', async () => {
    const s = await combined(),
      receiver = await login(f.approverId);
    await request(app.getHttpServer())
      .put('/api/v1/expenses/policies/USD')
      .set(s.headers)
      .send({
        expectedVersion: null,
        requireEvidence: false,
        limits: ['REQUEST', 'APPROVE', 'PAY'].map((action) => ({
          role: 'FINANCE_MANAGER',
          action,
          maximum: '5000.00',
        })),
      })
      .expect(200);
    await app.get(LedgerService).receipt(receiver.ctx, {
      agencyId: f.agencyId,
      idempotencyKey: randomUUID(),
      accountId: f.usd,
      counterAccountId: f.clearingUsd,
      cashSessionId: f.sessionId,
      currency: 'USD',
      amount: '100.00',
    });
    const draft = await receipt(s, 'expense-request', '20.00');
    const submitted = await post(s, `expenses/drafts/${draft.id}/submit`, {
      expectedVersion: 1,
      submitted: true,
    }).expect(201);
    const id = submitted.body.id;
    const own = await post(s, `expenses/requests/${id}/decision`, {
      expectedVersion: 1,
      decision: 'APPROVE',
      reason: '',
    }).expect(409);
    expect(JSON.stringify(own.body)).toContain('SELF_APPROVAL_FORBIDDEN');
    await post(s, `expenses/requests/${id}/pay`, { expectedVersion: 1, paid: true }).expect(409);
    await post(receiver, `expenses/requests/${id}/decision`, {
      expectedVersion: 1,
      decision: 'APPROVE',
      reason: '',
    }).expect(201);
    await post(s, `expenses/requests/${id}/pay`, { expectedVersion: 2, paid: true }).expect(201);
    expect((await app.get(LedgerService).balance(receiver.ctx, f.usd)).balance).toBe('80.00');
  });
  it.each([false, true])(
    'transfert/conversion=%s avec rôles réels, taux explicite et réception par un autre utilisateur',
    async (fx) => {
      const s = await combined(),
        receiver = await login(f.approverId);
      await app.get(LedgerService).receipt(receiver.ctx, {
        agencyId: f.agencyId,
        idempotencyKey: randomUUID(),
        accountId: f.usd,
        counterAccountId: f.clearingUsd,
        cashSessionId: f.sessionId,
        currency: 'USD',
        amount: '100.00',
      });
      const q = fx
        ? (
            await post(s, 'exchange-rates/quote', {
              fromCurrency: 'USD',
              toCurrency: 'CDF',
              amount: '2.00',
              mode: 'MANUAL',
              manualRate: '2500',
              manualSource: 'Guichet synthétique',
              justification: 'Cotation de test explicite',
              manualEffectiveAt: new Date().toISOString(),
            }).expect(201)
          ).body
        : null;
      const id = randomUUID();
      await post(s, 'transfers/drafts', {
        id,
        sourceCashRegisterId: f.registerId,
        destinationCashRegisterId: fx ? f.registerId : f.otherRegisterId,
        sourceCurrency: 'USD',
        destinationCurrency: fx ? 'CDF' : 'USD',
        amount: '2.00',
        rate: q?.appliedRate ?? null,
        rateSource: q?.source ?? '',
        ...(q ? { rateQuoteId: q.id } : {}),
        description: 'Opération synthétique avec rôles réels',
      }).expect(201);
      await post(s, `transfers/${id}/handover`, {
        expectedVersion: 1,
        handedOver: true,
        rateValidated: true,
      }).expect(201);
      await post(s, `transfers/${id}/receive`, { expectedVersion: 2, received: true }).expect(409);
      const done = await post(receiver, `transfers/${id}/receive`, {
        expectedVersion: 2,
        received: true,
      }).expect(201);
      expect(done.body.state).toBe('RECEIVED');
      expect(done.body.targetAmount).toBe(fx ? '5000.00' : '2.00');
      expect((await app.get(LedgerService).balance(receiver.ctx, f.usd)).balance).toBe('98.00');
      if (fx) {
        expect(done.body.rateEvidence.kind).toBe('MANUAL');
        const bcc = await post(s, 'exchange-rates/quote', {
          fromCurrency: 'USD',
          toCurrency: 'CDF',
          amount: '2.00',
          mode: 'BCC',
        }).expect(409);
        expect(JSON.stringify(bcc.body)).toContain('BCC_AUTHORIZATION_REQUIRED');
      }
    },
  );
});
