import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { randomUUID as id } from 'node:crypto';
import { PrismaService } from '../../src/prisma.service';
import { CentralAccess } from '../../src/data/central-access';
import { LedgerService } from '../../src/data/ledger.service';
import { DraftInboxService } from '../../src/data/draft-inbox.service';
import { fixture } from './fixture';
describe('Intégrité PostgreSQL réelle', () => {
  let db: PrismaService,
    access: CentralAccess,
    ledger: LedgerService,
    inbox: DraftInboxService,
    f: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => {
    if (
      process.env.CAISSEPRO_INTEGRITY_TEST !== '1' ||
      !/^\/caissepro_test_[0-9a-f]+$/.test(new URL(process.env.DATABASE_URL!).pathname)
    )
      throw new Error('Base de test isolée obligatoire.');
    db = new PrismaService();
    await db.$connect();
    access = new CentralAccess(db);
    ledger = new LedgerService(access);
    inbox = new DraftInboxService(access);
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  beforeEach(async () => {
    f = await fixture(db);
  });
  const receipt = (amount: string, currency: 'USD' | 'CDF' = 'USD', key = id()) =>
    ledger.receipt(f.ctx, {
      agencyId: f.agencyId,
      accountId: currency === 'USD' ? f.usd : f.cdf,
      counterAccountId: currency === 'USD' ? f.clearingUsd : f.clearingCdf,
      cashSessionId: f.sessionId,
      currency,
      amount,
      idempotencyKey: key,
    });
  const expense = (amount: string) =>
    ledger.requestExpense(f.ctx, {
      agencyId: f.agencyId,
      accountId: f.usd,
      currency: 'USD',
      amount,
      description: 'Dépense de test',
    });
  const pay = (expenseRequestId: string, counterAccountId = f.clearingUsd, key = id()) =>
    ledger.payExpense(f.ctx, {
      agencyId: f.agencyId,
      expenseRequestId,
      counterAccountId,
      cashSessionId: f.sessionId,
      idempotencyKey: key,
    });
  const transfer = (amount: string, key = id()) =>
    ledger.transfer(f.ctx, {
      agencyId: f.agencyId,
      sourceAccountId: f.usd,
      destinationAccountId: f.otherUsd,
      sourceSessionId: f.sessionId,
      destinationSessionId: f.otherSessionId,
      currency: 'USD',
      amount,
      idempotencyKey: key,
    });
  it('additionne exactement et sépare les devises', async () => {
    await receipt('0.10');
    await receipt('0.20');
    await receipt('100.25', 'CDF');
    expect((await ledger.balance(f.ctx, f.usd)).balance).toBe('0.30');
    expect((await ledger.balance(f.ctx, f.cdf)).balance).toBe('100.25');
  });
  it('préserve les grands décimaux au-delà de Number.MAX_SAFE_INTEGER', async () => {
    await receipt('9007199254740993.01');
    await receipt('0.01');
    expect((await ledger.balance(f.ctx, f.usd)).balance).toBe('9007199254740993.02');
  });
  it('déduplique six confirmations concurrentes et refuse une clé réutilisée différemment', async () => {
    const key = id();
    const rows = await Promise.all(Array.from({ length: 6 }, () => receipt('10.00', 'USD', key)));
    expect(new Set(rows.map((r) => r.operationId)).size).toBe(1);
    expect(await db.financialOperation.count({ where: { companyId: f.companyId } })).toBe(1);
    await expect(receipt('11.00', 'USD', key)).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  });
  it('empêche deux transferts concurrents de dépenser les mêmes fonds', async () => {
    await receipt('100.00');
    const rows = await Promise.allSettled([transfer('80.00'), transfer('80.00')]);
    expect(rows.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await ledger.balance(f.ctx, f.usd)).balance).toBe('20.00');
    expect((await ledger.balance(f.ctx, f.otherUsd)).balance).toBe('80.00');
  });
  it('interdit sa propre approbation dans le service et en SQL', async () => {
    const ex = await expense('10.00');
    await expect(ledger.approveExpense(f.ctx, ex.expenseRequestId)).rejects.toThrow(
      'SELF_APPROVAL',
    );
    await expect(
      access.run(f.ctx, (tx) =>
        tx.expenseApproval.create({
          data: {
            id: id(),
            companyId: f.companyId,
            expenseRequestId: ex.expenseRequestId,
            approverId: f.userId,
            decision: 'APPROVE',
            currency: 'USD',
            amount: '10.00',
          },
        }),
      ),
    ).rejects.toThrow('CAISSEPRO_APPROVAL_INVALID');
  });
  it('réserve atomiquement sans modifier le solde comptable', async () => {
    await receipt('100.00');
    const a = await expense('70.00'),
      b = await expense('70.00');
    const rows = await Promise.allSettled([
      ledger.approveExpense(f.approveCtx, a.expenseRequestId),
      ledger.approveExpense(f.approveCtx, b.expenseRequestId),
    ]);
    expect(rows.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await ledger.balance(f.ctx, f.usd)).toEqual({
      currency: 'USD',
      balance: '100.00',
      reserved: '70.00',
      available: '30.00',
    });
  });
  it('exige une approbation et rend le paiement idempotent', async () => {
    await receipt('100.00');
    const ex = await expense('40.00');
    await expect(pay(ex.expenseRequestId)).rejects.toThrow('EXPENSE_NOT_APPROVED');
    await ledger.approveExpense(f.approveCtx, ex.expenseRequestId);
    const key = id();
    const a = await pay(ex.expenseRequestId, f.clearingUsd, key),
      b = await pay(ex.expenseRequestId, f.clearingUsd, key);
    expect(a.operationId).toBe(b.operationId);
    expect((await ledger.balance(f.ctx, f.usd)).balance).toBe('60.00');
    expect((await ledger.balance(f.ctx, f.usd)).reserved).toBe('0.00');
  });
  it('annule entièrement un paiement incohérent', async () => {
    await receipt('100.00');
    const ex = await expense('40.00');
    await ledger.approveExpense(f.approveCtx, ex.expenseRequestId);
    await expect(pay(ex.expenseRequestId, f.clearingCdf)).rejects.toThrow();
    expect(await ledger.balance(f.ctx, f.usd)).toEqual({
      currency: 'USD',
      balance: '100.00',
      reserved: '40.00',
      available: '60.00',
    });
    expect(
      (await db.expenseRequest.findUniqueOrThrow({ where: { id: ex.expenseRequestId } })).state,
    ).toBe('APPROVED');
  });
  it('interdit les modifications et suppressions comptables même au propriétaire SQL', async () => {
    const op = await receipt('12.34');
    await expect(
      db.ledgerEntry.updateMany({
        where: { operationId: op.operationId },
        data: { amount: '1.00' },
      }),
    ).rejects.toThrow();
    await expect(db.financialOperation.delete({ where: { id: op.operationId } })).rejects.toThrow();
    await expect(
      db.treasuryAccount.update({ where: { id: f.usd }, data: { currency: 'CDF' } }),
    ).rejects.toThrow();
  });
  it('scelle les écritures après la transaction de comptabilisation', async () => {
    const op = await receipt('12.34');
    await expect(
      access.run(f.ctx, (tx) =>
        tx.ledgerEntry.create({
          data: {
            id: id(),
            companyId: f.companyId,
            operationId: op.operationId,
            accountId: f.usd,
            cashSessionId: f.sessionId,
            lineNo: 3,
            currency: 'USD',
            side: 'DEBIT',
            amount: '1.00',
          },
        }),
      ),
    ).rejects.toThrow('CAISSEPRO_SEALED_OPERATION');
  });
  it('rejette au commit une opération incomplète', async () => {
    await expect(
      access.run(f.ctx, async (tx) => {
        await tx.financialOperation.create({
          data: {
            id: id(),
            companyId: f.companyId,
            agencyId: f.agencyId,
            createdById: f.userId,
            kind: 'RECEIPT',
            currency: 'USD',
            idempotencyKey: id(),
            requestHash: 'a'.repeat(64),
          },
        });
      }),
    ).rejects.toThrow('CAISSEPRO_UNBALANCED_OPERATION');
    expect(await db.financialOperation.count({ where: { companyId: f.companyId } })).toBe(0);
  });
  it('corrige par une unique contre-écriture traçable', async () => {
    const op = await receipt('12.34');
    const input = {
      agencyId: f.agencyId,
      originalOperationId: op.operationId,
      reasonCode: 'SAISIE_INCORRECTE',
      sessions: { [f.usd]: f.sessionId },
      idempotencyKey: id(),
    };
    await ledger.reverse(f.ctx, input);
    expect((await ledger.balance(f.ctx, f.usd)).balance).toBe('0.00');
    await expect(ledger.reverse(f.ctx, { ...input, idempotencyKey: id() })).rejects.toThrow();
    expect(await db.financialOperation.count({ where: { companyId: f.companyId } })).toBe(2);
  });
  it('convertit avec un taux exact et un arrondi documenté', async () => {
    await receipt('10.00');
    const rateId = id();
    await db.exchangeRate.create({
      data: {
        id: rateId,
        companyId: f.companyId,
        fromCurrency: 'USD',
        toCurrency: 'CDF',
        rate: '2600.125',
        effectiveAt: new Date(Date.now() - 10000),
        source: 'TEST',
      },
    });
    await ledger.convert(f.ctx, {
      agencyId: f.agencyId,
      sourceAccountId: f.usd,
      destinationAccountId: f.cdf,
      sourceCounterId: f.clearingUsd,
      destinationCounterId: f.clearingCdf,
      sourceSessionId: f.sessionId,
      destinationSessionId: f.sessionId,
      exchangeRateId: rateId,
      amount: '1.25',
      idempotencyKey: id(),
    });
    expect((await ledger.balance(f.ctx, f.usd)).balance).toBe('8.75');
    expect((await ledger.balance(f.ctx, f.cdf)).balance).toBe('3250.16');
  });
  it('évite tout arrondi intermédiaire des grandes conversions', async () => {
    await receipt('9007199254740993.01');
    const rateId = id();
    await db.exchangeRate.create({
      data: {
        id: rateId,
        companyId: f.companyId,
        fromCurrency: 'USD',
        toCurrency: 'CDF',
        rate: '0.500000000255',
        effectiveAt: new Date(Date.now() - 10000),
        source: 'TEST_EXACTITUDE',
      },
    });
    await ledger.convert(f.ctx, {
      agencyId: f.agencyId,
      sourceAccountId: f.usd,
      destinationAccountId: f.cdf,
      sourceCounterId: f.clearingUsd,
      destinationCounterId: f.clearingCdf,
      sourceSessionId: f.sessionId,
      destinationSessionId: f.sessionId,
      exchangeRateId: rateId,
      amount: '9007199254740993.01',
      idempotencyKey: id(),
    });
    expect((await ledger.balance(f.ctx, f.usd)).balance).toBe('0.00');
    expect((await ledger.balance(f.ctx, f.cdf)).balance).toBe('4503599629667332.31');
  });
  it('applique RLS même sans filtre entreprise et refuse un compte étranger', async () => {
    const other = await fixture(db);
    const rows = await access.run(f.ctx, (tx) => tx.treasuryAccount.findMany());
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.companyId === f.companyId)).toBe(true);
    await expect(ledger.balance(f.ctx, other.usd)).rejects.toThrow('ACCOUNT_NOT_FOUND');
  });
  it('refuse un rôle absent et un utilisateur révoqué', async () => {
    await expect(
      ledger.balance({ companyId: f.companyId, userId: f.viewerId }, f.usd),
    ).rejects.toThrow('CAISSEPRO_ACCESS_DENIED');
    await db.user.update({ where: { id: f.userId }, data: { active: false } });
    await expect(receipt('1.00')).rejects.toThrow('CAISSEPRO_ACCESS_DENIED');
  });
  it('refuse les sessions fermées et une seconde ouverture concurrente', async () => {
    await expect(
      access.run(f.ctx, (tx) =>
        tx.cashSession.create({
          data: {
            id: id(),
            companyId: f.companyId,
            agencyId: f.agencyId,
            cashRegisterId: f.registerId,
            openedById: f.userId,
          },
        }),
      ),
    ).rejects.toThrow();
    await access.run(f.ctx, (tx) =>
      tx.cashSession.update({
        where: { id: f.sessionId },
        data: { state: 'CLOSED', closedById: f.userId, closedAt: new Date() },
      }),
    );
    await expect(receipt('1.00')).rejects.toThrow('CAISSEPRO_SESSION_INVALID');
  });
  it('synchronise uniquement des brouillons, déduplique et détecte les versions concurrentes', async () => {
    const draft = {
      id: id(),
      kind: 'receipt',
      currency: 'USD',
      amount: '2.00',
      description: 'Brouillon',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    };
    await inbox.receive(f.ctx, f.agencyId, draft, 4, null, f.registerId);
    await inbox.receive(f.ctx, f.agencyId, draft, 4, null, f.registerId);
    await inbox.receive(f.ctx, f.agencyId, { ...draft, amount: '3.00' }, 8, 4, f.registerId);
    await expect(
      inbox.receive(f.ctx, f.agencyId, { ...draft, amount: '4.00' }, 9, 4, f.registerId),
    ).rejects.toThrow('DRAFT_CONFLICT');
    expect(await db.importedDraft.count({ where: { companyId: f.companyId } })).toBe(1);
    expect(await db.financialOperation.count({ where: { companyId: f.companyId } })).toBe(0);
    expect(await db.expenseRequest.count({ where: { companyId: f.companyId } })).toBe(0);
    expect((await ledger.balance(f.ctx, f.usd)).balance).toBe('0.00');
  });
  it('contrôle l’auteur et la cible des justificatifs', async () => {
    const op = await receipt('1.00');
    const data = {
      id: id(),
      companyId: f.companyId,
      operationId: op.operationId,
      uploadedById: f.userId,
      objectKey: id(),
      sha256: 'b'.repeat(64),
      mimeType: 'application/pdf',
      byteLength: 100,
    };
    await expect(
      access.run(f.ctx, (tx) =>
        tx.attachment.create({ data: { ...data, uploadedById: f.viewerId } }),
      ),
    ).rejects.toThrow('CAISSEPRO_ACCESS_DENIED');
    await access.run(f.ctx, (tx) => tx.attachment.create({ data }));
  });
});
