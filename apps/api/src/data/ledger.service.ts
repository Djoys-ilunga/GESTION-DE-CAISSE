import { moneyText } from './money';
import { currencyPrecision } from '@caissepro/shared';
import type { Currency } from '@caissepro/shared';
import { Injectable, Inject } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { currencySchema, positiveAmountSchema } from '@caissepro/shared';
import { Prisma, type OperationKind } from '../generated/prisma/client';
import { CentralAccess, DataError, type DataContext, type Tx } from './central-access';
// 18 chiffres de montant × 24 chiffres de taux : aucun arrondi intermédiaire.
const ExactDecimal = Prisma.Decimal.clone({
  precision: 60,
  rounding: Prisma.Decimal.ROUND_HALF_UP,
});
const uuid = z.uuid();
const posting = { agencyId: uuid, idempotencyKey: uuid };
const receiptSchema = z
  .object({
    ...posting,
    accountId: uuid,
    counterAccountId: uuid,
    cashSessionId: uuid.nullable(),
    currency: currencySchema,
    amount: positiveAmountSchema,
  })
  .strict();
const transferSchema = z
  .object({
    ...posting,
    sourceAccountId: uuid,
    destinationAccountId: uuid,
    sourceSessionId: uuid.nullable(),
    destinationSessionId: uuid.nullable(),
    currency: currencySchema,
    amount: positiveAmountSchema,
  })
  .strict();
const expenseSchema = z
  .object({
    agencyId: uuid,
    accountId: uuid,
    currency: currencySchema,
    amount: positiveAmountSchema,
    description: z.string().trim().min(1).max(500),
  })
  .strict();
const paymentSchema = z
  .object({
    ...posting,
    expenseRequestId: uuid,
    counterAccountId: uuid,
    cashSessionId: uuid.nullable(),
  })
  .strict();
const fxSchema = z
  .object({
    ...posting,
    sourceAccountId: uuid,
    destinationAccountId: uuid,
    sourceCounterId: uuid,
    destinationCounterId: uuid,
    sourceSessionId: uuid.nullable(),
    destinationSessionId: uuid.nullable(),
    exchangeRateId: uuid,
    amount: positiveAmountSchema,
  })
  .strict();
const reverseSchema = z
  .object({
    ...posting,
    originalOperationId: uuid,
    reasonCode: z.string().regex(/^[A-Z0-9_]{3,80}$/),
    sessions: z.record(uuid, uuid.nullable()),
  })
  .strict();
export function fingerprint(value: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, canonical(x)]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
type Line = {
  accountId: string;
  cashSessionId: string | null;
  currency: Currency;
  side: 'DEBIT' | 'CREDIT';
  amount: string;
};
type Prepared = {
  lines: Line[];
  currency: Currency | null;
  expenseRequestId?: string;
  reversalOfId?: string;
  reasonCode?: string;
  exchangeRateId?: string;
  sourceAmount?: string;
  targetAmount?: string;
  transfer?: {
    sourceAccountId: string;
    destinationAccountId: string;
    currency: Currency;
    amount: string;
  };
};
@Injectable()
export class LedgerService {
  constructor(@Inject(CentralAccess) private readonly access: CentralAccess) {}
  private async audit(
    tx: Tx,
    ctx: DataContext,
    action: string,
    targetType: string,
    targetId: string,
  ) {
    await tx.auditEvent.create({
      data: {
        id: randomUUID(),
        companyId: ctx.companyId,
        actorId: ctx.userId,
        action,
        targetType,
        targetId,
      },
    });
  }
  private async write(
    tx: Tx,
    ctx: DataContext,
    kind: OperationKind,
    input: { agencyId: string; idempotencyKey: string },
    payload: unknown,
    prepare: () => Promise<Prepared>,
  ) {
    const requestHash = fingerprint({
      ctx: { companyId: ctx.companyId, userId: ctx.userId },
      kind,
      payload,
    });
    const previous = await tx.financialOperation.findFirst({
      where: { companyId: ctx.companyId, idempotencyKey: input.idempotencyKey },
    });
    if (previous) {
      if (previous.requestHash !== requestHash) throw new DataError('IDEMPOTENCY_CONFLICT');
      return { operationId: previous.id, replayed: true };
    }
    const prepared = await prepare();
    const { lines, transfer, ...metadata } = prepared;
    const id = randomUUID();
    await tx.financialOperation.create({
      data: {
        id,
        companyId: ctx.companyId,
        agencyId: input.agencyId,
        createdById: ctx.userId,
        kind,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        ...metadata,
      },
    });
    for (const [index, line] of lines.entries())
      await tx.ledgerEntry.create({
        data: {
          id: randomUUID(),
          companyId: ctx.companyId,
          operationId: id,
          lineNo: index + 1,
          ...line,
        },
      });
    if (transfer)
      await tx.transfer.create({
        data: { id: randomUUID(), companyId: ctx.companyId, operationId: id, ...transfer },
      });
    await this.audit(tx, ctx, 'OPERATION_POSTED', 'OPERATION', id);
    return { operationId: id, replayed: false };
  }
  async balance(ctx: DataContext, accountId: string) {
    uuid.parse(accountId);
    return this.access.run(ctx, async (tx) => {
      const account = await tx.treasuryAccount.findFirst({
        where: { companyId: ctx.companyId, id: accountId },
      });
      if (!account) throw new DataError('ACCOUNT_NOT_FOUND');
      await this.access.require(tx, ctx, account.agencyId, 'ledger:read');
      if (account.cashRegisterId)
        await this.access.requireCashRead(tx, ctx, account.cashRegisterId, 'ledger:read');
      const [row] = await tx.$queryRaw<
        {
          currency: Currency;
          balance: Prisma.Decimal;
          reserved: Prisma.Decimal;
          available: Prisma.Decimal;
        }[]
      >`SELECT currency,balance,reserved,available FROM "AvailableFunds" WHERE "companyId"=${ctx.companyId}::uuid AND "accountId"=${accountId}::uuid`;
      if (!row) throw new DataError('ACCOUNT_NOT_FOUND');
      return {
        currency: row.currency,
        balance: moneyText(row.balance, row.currency),
        reserved: moneyText(row.reserved, row.currency),
        available: moneyText(row.available, row.currency),
      };
    });
  }
  async receipt(ctx: DataContext, value: unknown) {
    return this.access.run(ctx, (tx) => this.receiptInTransaction(tx, ctx, value));
  }
  async receiptInTransaction(tx: Tx, ctx: DataContext, value: unknown) {
    const input = receiptSchema.parse(value);
    await this.access.require(tx, ctx, input.agencyId, 'receipt:post');
    return this.write(tx, ctx, 'RECEIPT', input, input, async () => {
      await this.access.lockAccounts(tx, ctx, [input.accountId, input.counterAccountId]);
      return {
        currency: input.currency,
        lines: [
          {
            accountId: input.accountId,
            cashSessionId: input.cashSessionId,
            currency: input.currency,
            amount: input.amount,
            side: 'DEBIT',
          },
          {
            accountId: input.counterAccountId,
            cashSessionId: null,
            currency: input.currency,
            amount: input.amount,
            side: 'CREDIT',
          },
        ],
      };
    });
  }
  async transfer(ctx: DataContext, value: unknown) {
    const input = transferSchema.parse(value);
    return this.access.run(ctx, (tx) => this.transferInTransaction(tx, ctx, input));
  }
  async transferInTransaction(tx: Tx, ctx: DataContext, input: z.infer<typeof transferSchema>) {
    await this.access.require(tx, ctx, input.agencyId, 'transfer:post');
    return this.write(tx, ctx, 'TRANSFER', input, input, async () => {
      await this.access.lockAccounts(tx, ctx, [input.sourceAccountId, input.destinationAccountId]);
      return {
        currency: input.currency,
        transfer: {
          sourceAccountId: input.sourceAccountId,
          destinationAccountId: input.destinationAccountId,
          currency: input.currency,
          amount: input.amount,
        },
        lines: [
          {
            accountId: input.sourceAccountId,
            cashSessionId: input.sourceSessionId,
            currency: input.currency,
            amount: input.amount,
            side: 'CREDIT',
          },
          {
            accountId: input.destinationAccountId,
            cashSessionId: input.destinationSessionId,
            currency: input.currency,
            amount: input.amount,
            side: 'DEBIT',
          },
        ],
      };
    });
  }
  async requestExpense(ctx: DataContext, value: unknown) {
    const input = expenseSchema.parse(value);
    return this.access.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, input.agencyId, 'expense:request');
      const row = await tx.expenseRequest.create({
        data: { id: randomUUID(), companyId: ctx.companyId, requestedById: ctx.userId, ...input },
      });
      await this.audit(tx, ctx, 'EXPENSE_REQUESTED', 'EXPENSE', row.id);
      return { expenseRequestId: row.id };
    });
  }
  async approveExpense(
    ctx: DataContext,
    expenseRequestId: string,
    decision: 'APPROVE' | 'REJECT' = 'APPROVE',
  ) {
    uuid.parse(expenseRequestId);
    z.enum(['APPROVE', 'REJECT']).parse(decision);
    return this.access.run(ctx, (tx) =>
      this.decideExpenseInTransaction(tx, ctx, expenseRequestId, decision, null),
    );
  }
  async decideExpenseInTransaction(
    tx: Tx,
    ctx: DataContext,
    expenseRequestId: string,
    decision: 'APPROVE' | 'REJECT',
    reason: string | null,
  ) {
    const first = await tx.expenseRequest.findFirst({
      where: { companyId: ctx.companyId, id: expenseRequestId },
    });
    if (!first) throw new DataError('EXPENSE_NOT_FOUND');
    await this.access.require(tx, ctx, first.agencyId, 'expense:approve');
    await this.access.lockAccounts(tx, ctx, [first.accountId]);
    await tx.$executeRaw`SELECT id FROM "ExpenseRequest" WHERE "companyId"=${ctx.companyId}::uuid AND id=${expenseRequestId}::uuid FOR UPDATE`;
    const ex = await tx.expenseRequest.findUniqueOrThrow({ where: { id: expenseRequestId } });
    if (ex.requestedById === ctx.userId) throw new DataError('SELF_APPROVAL_FORBIDDEN');
    const previous = await tx.expenseApproval.findFirst({
      where: { companyId: ctx.companyId, expenseRequestId },
    });
    if (previous && previous.approverId === ctx.userId && previous.decision === decision)
      return { expenseRequestId, replayed: true };
    if (ex.state !== 'PENDING') throw new DataError('EXPENSE_STATE_CONFLICT');
    await tx.expenseApproval.create({
      data: {
        id: randomUUID(),
        companyId: ctx.companyId,
        expenseRequestId,
        approverId: ctx.userId,
        decision,
        reason,
        currency: ex.currency,
        amount: ex.amount,
      },
    });
    if (decision === 'APPROVE')
      await tx.fundReservation.create({
        data: {
          id: randomUUID(),
          companyId: ctx.companyId,
          expenseRequestId,
          accountId: ex.accountId,
          currency: ex.currency,
          amount: ex.amount,
        },
      });
    await tx.expenseRequest.update({
      where: { id: ex.id },
      data: {
        state: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
        version: { increment: 1 },
      },
    });
    await this.audit(
      tx,
      ctx,
      decision === 'APPROVE' ? 'EXPENSE_APPROVED' : 'EXPENSE_REJECTED',
      'EXPENSE',
      ex.id,
    );
    return { expenseRequestId, replayed: false };
  }
  async payExpense(ctx: DataContext, value: unknown) {
    const input = paymentSchema.parse(value);
    return this.access.run(ctx, (tx) => this.payExpenseInTransaction(tx, ctx, input));
  }
  async payExpenseInTransaction(tx: Tx, ctx: DataContext, input: z.infer<typeof paymentSchema>) {
    await this.access.require(tx, ctx, input.agencyId, 'expense:pay');
    return this.write(tx, ctx, 'DISBURSEMENT', input, input, async () => {
      const ex = await tx.expenseRequest.findFirst({
        where: { companyId: ctx.companyId, id: input.expenseRequestId },
      });
      if (!ex || ex.state !== 'APPROVED' || ex.agencyId !== input.agencyId)
        throw new DataError('EXPENSE_NOT_APPROVED');
      await this.access.lockAccounts(tx, ctx, [ex.accountId, input.counterAccountId]);
      await tx.fundReservation.update({
        where: {
          companyId_expenseRequestId: { companyId: ctx.companyId, expenseRequestId: ex.id },
        },
        data: { state: 'CONSUMED' },
      });
      await tx.expenseRequest.update({
        where: { id: ex.id },
        data: { state: 'PAID', version: { increment: 1 } },
      });
      return {
        currency: ex.currency,
        expenseRequestId: ex.id,
        lines: [
          {
            accountId: ex.accountId,
            cashSessionId: input.cashSessionId,
            currency: ex.currency,
            amount: moneyText(ex.amount, ex.currency),
            side: 'CREDIT',
          },
          {
            accountId: input.counterAccountId,
            cashSessionId: null,
            currency: ex.currency,
            amount: moneyText(ex.amount, ex.currency),
            side: 'DEBIT',
          },
        ],
      };
    });
  }
  async convert(ctx: DataContext, value: unknown) {
    const input = fxSchema.parse(value);
    return this.access.run(ctx, (tx) => this.convertInTransaction(tx, ctx, input));
  }
  async convertInTransaction(tx: Tx, ctx: DataContext, input: z.infer<typeof fxSchema>) {
    await this.access.require(tx, ctx, input.agencyId, 'fx:post');
    return this.write(tx, ctx, 'FX', input, input, async () => {
      const rate = await tx.exchangeRate.findFirst({
        where: { companyId: ctx.companyId, id: input.exchangeRateId },
      });
      if (!rate) throw new DataError('RATE_NOT_FOUND');
      await this.access.lockAccounts(tx, ctx, [
        input.sourceAccountId,
        input.destinationAccountId,
        input.sourceCounterId,
        input.destinationCounterId,
      ]);
      const target = new ExactDecimal(input.amount)
        .mul(rate.rate.toString())
        .toDecimalPlaces(currencyPrecision(rate.toCurrency), Prisma.Decimal.ROUND_HALF_UP)
        .toFixed(currencyPrecision(rate.toCurrency));
      positiveAmountSchema.parse(target);
      return {
        currency: null,
        exchangeRateId: rate.id,
        sourceAmount: input.amount,
        targetAmount: target,
        lines: [
          {
            accountId: input.sourceAccountId,
            cashSessionId: input.sourceSessionId,
            currency: rate.fromCurrency,
            amount: input.amount,
            side: 'CREDIT',
          },
          {
            accountId: input.sourceCounterId,
            cashSessionId: null,
            currency: rate.fromCurrency,
            amount: input.amount,
            side: 'DEBIT',
          },
          {
            accountId: input.destinationAccountId,
            cashSessionId: input.destinationSessionId,
            currency: rate.toCurrency,
            amount: target,
            side: 'DEBIT',
          },
          {
            accountId: input.destinationCounterId,
            cashSessionId: null,
            currency: rate.toCurrency,
            amount: target,
            side: 'CREDIT',
          },
        ],
      };
    });
  }
  async reverse(ctx: DataContext, value: unknown) {
    const input = reverseSchema.parse(value);
    return this.access.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, input.agencyId, 'ledger:reverse');
      return this.write(tx, ctx, 'REVERSAL', input, input, async () => {
        const original = await tx.financialOperation.findFirst({
          where: { companyId: ctx.companyId, id: input.originalOperationId },
          include: { entries: { include: { account: true } } },
        });
        if (!original || original.agencyId !== input.agencyId || original.kind === 'REVERSAL')
          throw new DataError('REVERSAL_INVALID');
        await this.access.lockAccounts(
          tx,
          ctx,
          original.entries.map((e) => e.accountId),
        );
        return {
          currency: original.currency,
          reversalOfId: original.id,
          reasonCode: input.reasonCode,
          lines: original.entries.map((e) => ({
            accountId: e.accountId,
            cashSessionId: e.account.cashRegisterId ? (input.sessions[e.accountId] ?? null) : null,
            currency: e.currency,
            amount: moneyText(e.amount, e.currency),
            side: e.side === 'DEBIT' ? 'CREDIT' : 'DEBIT',
          })),
        };
      });
    });
  }
}
