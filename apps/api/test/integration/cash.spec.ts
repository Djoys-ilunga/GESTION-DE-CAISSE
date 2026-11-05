import 'reflect-metadata';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID, createHash } from 'node:crypto';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app';
import { PrismaService } from '../../src/prisma.service';
import { PasswordService } from '../../src/auth/password.service';
import { installRoles } from '../../src/auth/admin.service';
import { LedgerService } from '../../src/data/ledger.service';
import { CentralAccess, DataError } from '../../src/data/central-access';
import { fixture } from './fixture';

describe('Caisses et encaissements HTTP / PostgreSQL réels', () => {
  let app: INestApplication,
    db: PrismaService,
    f: Awaited<ReturnType<typeof fixture>>,
    companyCode: string,
    hash: string;
  const password = 'Phrase-de-test!CaissePro-2026';
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1kAAAAASUVORK5CYII=';
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
    companyCode = (await db.company.findUniqueOrThrow({ where: { id: f.companyId } })).code;
    await db.$transaction((tx) => installRoles(tx, f.companyId));
    for (const [userId, code] of [
      [f.userId, 'CASHIER'],
      [f.approverId, 'ADMINISTRATOR'],
      [f.viewerId, 'AUDITOR'],
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
      if (userId === f.viewerId)
        await db.cashRegisterGrant.create({
          data: {
            companyId: f.companyId,
            memberId: member.id,
            agencyId: f.agencyId,
            cashRegisterId: f.registerId,
          },
        });
    }
  });
  async function login(userId = f.userId) {
    const deviceId = randomUUID();
    const r = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ companyCode, email: `${userId}@example.test`, password, deviceId })
      .expect(201);
    return { Authorization: `Bearer ${r.body.accessToken}`, 'X-CaissePro-Device': deviceId };
  }
  function payload(amount = '12.34', currency: 'CDF' | 'USD' = 'USD') {
    return {
      draft: {
        id: randomUUID(),
        kind: 'receipt',
        currency,
        amount,
        description: 'Vente de fournitures',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        receiptDetails: {
          provenance: 'Client Alpha',
          category: 'VENTE',
          reference: 'FACT-2026-001',
          supportingDocument: null as null | {
            fileName: string;
            mimeType: string;
            dataBase64: string;
          },
        },
      },
      agencyId: f.agencyId,
      cashRegisterId: f.registerId,
      version: 1,
      expectedServerVersion: null as number | null,
    };
  }
  async function prepare(headers: Awaited<ReturnType<typeof login>>, body = payload()) {
    await request(app.getHttpServer())
      .post('/api/v1/workspace/drafts/sync')
      .set(headers)
      .send(body)
      .expect(201);
    const row = await db.importedDraft.findUniqueOrThrow({
      where: {
        companyId_authorId_clientDraftId: {
          companyId: f.companyId,
          authorId: f.userId,
          clientDraftId: body.draft.id,
        },
      },
    });
    return { row, body };
  }
  function confirm(headers: Awaited<ReturnType<typeof login>>, id: string, version = 1) {
    return request(app.getHttpServer())
      .post(`/api/v1/cash/drafts/${id}/confirm`)
      .set(headers)
      .send({ expectedVersion: version, received: true });
  }
  const operations = () => db.financialOperation.count({ where: { companyId: f.companyId } });
  it('configure une agence et une caisse avec deux devises, affectations et création idempotente', async () => {
    const cashier = await login(),
      admin = await login(f.approverId),
      agencyId = randomUUID(),
      cashId = randomUUID();
    await request(app.getHttpServer())
      .post('/api/v1/cash/agencies')
      .set(admin)
      .send({ id: agencyId, code: 'LUBUMBASHI', name: 'Agence Lubumbashi' })
      .expect(201);
    const body = {
      id: cashId,
      agencyId,
      code: 'CAISSE-2',
      name: 'Caisse commerciale',
      authorizedUserIds: [f.userId],
    };
    for (let i = 0; i < 2; i++)
      await request(app.getHttpServer())
        .post('/api/v1/cash/registers')
        .set(admin)
        .send(body)
        .expect(201);
    expect(await db.treasuryAccount.count({ where: { companyId: f.companyId, agencyId } })).toBe(4);
    expect(await operations()).toBe(0);
    await request(app.getHttpServer()).get('/api/v1/auth/session').set(cashier).expect(401);
    const fresh = await login();
    const list = await request(app.getHttpServer())
      .get('/api/v1/cash/registers')
      .set(fresh)
      .expect(200);
    const cash = list.body.items.find((r: { id: string }) => r.id === cashId);
    expect(cash.funds).toEqual(
      expect.arrayContaining([
        { currency: 'CDF', balance: '0.00', reserved: '0.00', available: '0.00' },
        { currency: 'USD', balance: '0.00', reserved: '0.00', available: '0.00' },
      ]),
    );
    await request(app.getHttpServer())
      .post('/api/v1/cash/registers')
      .set(admin)
      .send({ ...body, name: 'Autre contenu' })
      .expect(409);
  });
  it('refuse la configuration et les affectations étrangères sans autorisation', async () => {
    const cashier = await login(),
      admin = await login(f.approverId),
      other = await fixture(db);
    const body = {
      id: randomUUID(),
      agencyId: f.agencyId,
      code: 'INTERDITE',
      name: 'Caisse test',
      authorizedUserIds: [],
    };
    await request(app.getHttpServer())
      .post('/api/v1/cash/registers')
      .set(cashier)
      .send(body)
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/v1/cash/registers')
      .set(admin)
      .send({ ...body, agencyId: other.agencyId })
      .expect(404);
    await request(app.getHttpServer())
      .post('/api/v1/cash/registers')
      .set(admin)
      .send({ ...body, authorizedUserIds: [other.userId] })
      .expect(403);
  });
  it('synchronise sans comptabiliser et exige une confirmation explicite de réception effective', async () => {
    const headers = await login(),
      { row } = await prepare(headers);
    expect(await operations()).toBe(0);
    expect(await db.cashReceipt.count({ where: { companyId: f.companyId } })).toBe(0);
    for (const body of [{ expectedVersion: 1 }, { expectedVersion: 1, received: false }])
      await request(app.getHttpServer())
        .post(`/api/v1/cash/drafts/${row.id}/confirm`)
        .set(headers)
        .send(body)
        .expect(400);
    await confirm(headers, row.id, 2).expect(409);
    expect(await operations()).toBe(0);
    const r = await confirm(headers, row.id).expect(201);
    expect(r.body.number).toMatch(/^REC-.+-\d{4}-000001$/);
    expect(r.body.amount).toBe('12.34');
    expect(r.body.provenance).toBe('Client Alpha');
    expect(await operations()).toBe(1);
    const ledger = app.get(LedgerService);
    expect((await ledger.balance(f.ctx, f.usd)).balance).toBe('12.34');
    expect((await ledger.balance(f.ctx, f.cdf)).balance).toBe('0.00');
    const lines = await db.ledgerEntry.findMany({ where: { companyId: f.companyId } });
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.amount.toFixed(2))).toEqual(['12.34', '12.34']);
  });
  it('déduplique six confirmations concurrentes et une reprise après reconnexion', async () => {
    const headers = await login(),
      { row } = await prepare(headers);
    const results = await Promise.all(Array.from({ length: 6 }, () => confirm(headers, row.id)));
    expect(results.map((r) => r.status)).toEqual(Array(6).fill(201));
    expect(new Set(results.map((r) => r.body.number)).size).toBe(1);
    const again = await confirm(await login(), row.id).expect(201);
    expect(again.body.id).toBe(results[0]!.body.id);
    expect(await operations()).toBe(1);
    expect(await db.cashReceipt.count({ where: { companyId: f.companyId } })).toBe(1);
    expect(
      (await db.receiptCounter.findFirstOrThrow({ where: { companyId: f.companyId } }))
        .lastSequence,
    ).toBe(1n);
  });
  it('alloue des numéros uniques en concurrence et additionne exactement CDF/USD', async () => {
    const headers = await login();
    const drafts = [];
    for (const [amount, currency] of [
      ['0.10', 'USD'],
      ['0.10', 'USD'],
      ['0.10', 'USD'],
      ['300.00', 'CDF'],
    ] as const)
      drafts.push(await prepare(headers, payload(amount, currency)));
    const results = await Promise.all(drafts.map((d) => confirm(headers, d.row.id)));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.number)).size).toBe(4);
    const ledger = app.get(LedgerService);
    expect((await ledger.balance(f.ctx, f.usd)).balance).toBe('0.30');
    expect((await ledger.balance(f.ctx, f.cdf)).balance).toBe('300.00');
  });
  it('annule toutes les écritures si la transaction échoue après le mouvement préparé', async () => {
    const headers = await login(),
      { row } = await prepare(headers),
      ledger = app.get(LedgerService);
    const original = ledger.receiptInTransaction.bind(ledger);
    const fault = vi.spyOn(ledger, 'receiptInTransaction').mockImplementation(async (...args) => {
      await original(...args);
      throw new DataError('SIMULATED_FAILURE');
    });
    try {
      await confirm(headers, row.id).expect(409);
    } finally {
      fault.mockRestore();
    }
    expect(await operations()).toBe(0);
    expect(await db.ledgerEntry.count({ where: { companyId: f.companyId } })).toBe(0);
    expect(await db.cashReceipt.count({ where: { companyId: f.companyId } })).toBe(0);
    expect(await db.receiptCounter.count({ where: { companyId: f.companyId } })).toBe(0);
    await confirm(headers, row.id).expect(201);
  });
  it('conserve le justificatif sur le serveur et refuse les fichiers falsifiés', async () => {
    const headers = await login(),
      body = payload();
    body.draft.receiptDetails.supportingDocument = {
      fileName: 'preuve.png',
      mimeType: 'image/png',
      dataBase64: png,
    };
    const { row } = await prepare(headers, body);
    const receipt = await confirm(headers, row.id).expect(201);
    expect(receipt.body.evidence.fileName).toBe('preuve.png');
    expect(receipt.body.evidence.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(receipt.body)).not.toContain(png);
    const evidence = await request(app.getHttpServer())
      .get(`/api/v1/cash/receipts/${receipt.body.id}/evidence`)
      .set(headers)
      .expect(200);
    expect(evidence.body.dataBase64).toBe(png);
    const bad = payload();
    bad.draft.receiptDetails.supportingDocument = {
      fileName: 'faux.pdf',
      mimeType: 'application/pdf',
      dataBase64: Buffer.from('script non PDF').toString('base64'),
    };
    await request(app.getHttpServer())
      .post('/api/v1/workspace/drafts/sync')
      .set(headers)
      .send(bad)
      .expect(409);
    expect(await operations()).toBe(1);
  });
  it('fige le reçu et son brouillon source après comptabilisation', async () => {
    const headers = await login(),
      { row, body } = await prepare(headers),
      receipt = await confirm(headers, row.id).expect(201);
    await expect(
      db.cashReceipt.update({ where: { id: receipt.body.id }, data: { amount: '99.00' } }),
    ).rejects.toThrow('CAISSEPRO_IMMUTABLE_RECORD');
    await expect(db.cashReceipt.delete({ where: { id: receipt.body.id } })).rejects.toThrow(
      'CAISSEPRO_IMMUTABLE_RECORD',
    );
    await request(app.getHttpServer())
      .post('/api/v1/workspace/drafts/sync')
      .set(headers)
      .send({
        ...body,
        draft: { ...body.draft, amount: '99.00' },
        version: 2,
        expectedServerVersion: 1,
      })
      .expect(409);
    await expect(
      new CentralAccess(db).run(f.ctx, (tx) =>
        tx.importedDraft.update({ where: { id: row.id }, data: { version: 2, amount: '99.00' } }),
      ),
    ).rejects.toThrow('CAISSEPRO_DRAFT_ALREADY_CONFIRMED');
    expect((await app.get(LedgerService).balance(f.ctx, f.usd)).balance).toBe('12.34');
  });
  it('refuse aussi en SQL un justificatif sans type ou avec un faux en-tête', async () => {
    const bytes = Buffer.from(png, 'base64');
    const data = {
      id: randomUUID(),
      companyId: f.companyId,
      agencyId: f.agencyId,
      cashRegisterId: f.registerId,
      authorId: f.userId,
      clientDraftId: randomUUID(),
      kind: 'RECEIPT' as const,
      currency: 'USD' as const,
      amount: '1.00',
      description: 'Essai de contrainte',
      version: 1,
      payloadHash: '0'.repeat(64),
      receiptProvenance: 'Payeur',
      receiptCategory: 'Ventes',
      receiptReference: '',
      evidenceName: 'preuve.png',
      evidenceBytes: bytes,
      evidenceSha: createHash('sha256').update(bytes).digest('hex'),
    };
    const access = new CentralAccess(db);
    await expect(
      access.run(f.ctx, (tx) => tx.importedDraft.create({ data: { ...data, evidenceMime: null } })),
    ).rejects.toThrow();
    await expect(
      access.run(f.ctx, (tx) =>
        tx.importedDraft.create({ data: { ...data, evidenceMime: 'application/pdf' } }),
      ),
    ).rejects.toThrow();
    expect(await db.importedDraft.count({ where: { companyId: f.companyId } })).toBe(0);
    expect(await operations()).toBe(0);
  });
  it('filtre l’historique et protège les caisses non affectées', async () => {
    const headers = await login();
    await confirm(headers, (await prepare(headers, payload('10.00', 'USD'))).row.id).expect(201);
    await confirm(headers, (await prepare(headers, payload('200.00', 'CDF'))).row.id).expect(201);
    const results = await request(app.getHttpServer())
      .get('/api/v1/cash/receipts')
      .query({ currency: 'USD', category: 'VENTE', search: 'FACT-2026' })
      .set(headers)
      .expect(200);
    expect(results.body.total).toBe(1);
    expect(results.body.items[0].currency).toBe('USD');
    const member = await db.companyMember.findUniqueOrThrow({
      where: { companyId_userId: { companyId: f.companyId, userId: f.userId } },
    });
    await db.cashRegisterGrant.deleteMany({
      where: { memberId: member.id, cashRegisterId: f.registerId },
    });
    await request(app.getHttpServer())
      .get(`/api/v1/cash/receipts/${results.body.items[0].id}`)
      .set(headers)
      .expect(404);
    await request(app.getHttpServer())
      .get('/api/v1/cash/receipts')
      .query({ cashRegisterId: f.registerId })
      .set(headers)
      .expect(403);
    expect(await new CentralAccess(db).run(f.ctx, (tx) => tx.cashReceipt.count())).toBe(0);
  });
  it('isole les brouillons et refuse les confirmations par un auditeur', async () => {
    const headers = await login(),
      auditor = await login(f.viewerId),
      { row } = await prepare(headers);
    await request(app.getHttpServer())
      .get(`/api/v1/cash/drafts/${row.id}`)
      .set(auditor)
      .expect(403);
    await confirm(auditor, row.id).expect(403);
    expect(await operations()).toBe(0);
    const member = await db.companyMember.findUniqueOrThrow({
      where: { companyId_userId: { companyId: f.companyId, userId: f.viewerId } },
    });
    const role = await db.role.findUniqueOrThrow({
      where: { companyId_code: { companyId: f.companyId, code: 'CASHIER' } },
    });
    await db.memberRole.deleteMany({ where: { memberId: member.id } });
    await db.memberRole.create({
      data: { companyId: f.companyId, memberId: member.id, roleId: role.id },
    });
    const other = await login(f.viewerId);
    await confirm(other, row.id).expect(404);
    await request(app.getHttpServer()).get(`/api/v1/cash/drafts/${row.id}`).set(other).expect(404);
  });
  it('bloque la confirmation après révocation des permissions', async () => {
    const headers = await login(),
      admin = await login(f.approverId),
      { row } = await prepare(headers),
      member = await db.companyMember.findUniqueOrThrow({
        where: { companyId_userId: { companyId: f.companyId, userId: f.userId } },
      });
    await request(app.getHttpServer())
      .put(`/api/v1/admin/users/${f.userId}/access`)
      .set(admin)
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
    await confirm(headers, row.id).expect(401);
    expect(await operations()).toBe(0);
  });
  it('gère l’ouverture concurrente d’une session et refuse une caisse sans session ouverte', async () => {
    const headers = await login(),
      { row } = await prepare(headers);
    await new CentralAccess(db).run(f.ctx, (tx) =>
      tx.cashSession.update({
        where: { id: f.sessionId },
        data: { state: 'CLOSED', closedAt: new Date(), closedById: f.userId },
      }),
    );
    await confirm(headers, row.id).expect(409);
    expect(await operations()).toBe(0);
    const sessions = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(app.getHttpServer())
          .post(`/api/v1/cash/registers/${f.registerId}/open`)
          .set(headers),
      ),
    );
    expect(sessions.every((r) => r.status === 201)).toBe(true);
    expect(new Set(sessions.map((r) => r.body.id)).size).toBe(1);
    await confirm(headers, row.id).expect(201);
  });
  it('conserve les historiques après désactivation et contrôle les versions de configuration', async () => {
    const headers = await login(),
      admin = await login(f.approverId),
      { row } = await prepare(headers),
      receipt = await confirm(headers, row.id).expect(201);
    await request(app.getHttpServer())
      .put(`/api/v1/cash/registers/${f.registerId}`)
      .set(admin)
      .send({ name: 'Caisse archivée', active: false, expectedVersion: 1 })
      .expect(200);
    await request(app.getHttpServer())
      .put(`/api/v1/cash/registers/${f.registerId}`)
      .set(admin)
      .send({ name: 'Écriture périmée', active: true, expectedVersion: 1 })
      .expect(409);
    const history = await request(app.getHttpServer())
      .get(`/api/v1/cash/receipts/${receipt.body.id}`)
      .set(headers)
      .expect(200);
    expect(history.body.cashName).toBe('Caisse A');
    const list = await request(app.getHttpServer())
      .get('/api/v1/cash/registers')
      .set(headers)
      .expect(200);
    expect(list.body.items.find((r: { id: string }) => r.id === f.registerId).active).toBe(false);
    await request(app.getHttpServer())
      .post('/api/v1/workspace/drafts/sync')
      .set(headers)
      .send(payload())
      .expect(403);
    expect(await operations()).toBe(1);
  });
  it('résout la concurrence entre modification d’un brouillon et confirmation sans montant incohérent', async () => {
    const headers = await login(),
      { row, body } = await prepare(headers, payload('10.00'));
    const [confirmation, edition] = await Promise.all([
      confirm(headers, row.id),
      request(app.getHttpServer())
        .post('/api/v1/workspace/drafts/sync')
        .set(headers)
        .send({
          ...body,
          draft: { ...body.draft, amount: '20.00' },
          version: 2,
          expectedServerVersion: 1,
        }),
    ]);
    if (confirmation.status === 201) {
      expect(confirmation.body.amount).toBe('10.00');
      expect(edition.status).toBe(409);
    } else {
      expect(confirmation.status).toBe(409);
      expect(edition.status).toBe(201);
      expect(await operations()).toBe(0);
    }
  });
  it('rend l’idempotence comptable indépendante du renouvellement de session authentifiée', async () => {
    const session1 = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ companyCode, email: `${f.userId}@example.test`, password, deviceId: randomUUID() })
      .expect(201);
    const session2 = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ companyCode, email: `${f.userId}@example.test`, password, deviceId: randomUUID() })
      .expect(201);
    const payload = {
        agencyId: f.agencyId,
        idempotencyKey: randomUUID(),
        accountId: f.usd,
        counterAccountId: f.clearingUsd,
        cashSessionId: f.sessionId,
        currency: 'USD',
        amount: '1.00',
      },
      ledger = app.get(LedgerService);
    const one = await ledger.receipt(
        { ...f.ctx, sessionId: session1.body.profile.sessionId },
        payload,
      ),
      two = await ledger.receipt({ ...f.ctx, sessionId: session2.body.profile.sessionId }, payload);
    expect(two.operationId).toBe(one.operationId);
    expect(two.replayed).toBe(true);
  });
});
