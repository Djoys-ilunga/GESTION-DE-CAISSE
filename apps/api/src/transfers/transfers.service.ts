import { moneyText } from '../data/money';
import { currencyPrecision } from '@caissepro/shared';
import { Injectable, Inject } from '@nestjs/common';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  transferDraftSchema,
  handoverTransferSchema,
  receiveTransferSchema,
  transferViewSchema,
  positiveAmountSchema,
} from '@caissepro/shared';
import { Prisma, type TransferOrder } from '../generated/prisma/client';
import { CentralAccess, DataError, type DataContext, type Tx } from '../data/central-access';
import { LedgerService, fingerprint } from '../data/ledger.service';
const Decimal = Prisma.Decimal.clone({ precision: 60, rounding: Prisma.Decimal.ROUND_HALF_UP });
@Injectable()
export class TransfersService {
  constructor(
    @Inject(CentralAccess) private readonly access: CentralAccess,
    @Inject(LedgerService) private readonly ledger: LedgerService,
  ) {}
  private view(row: TransferOrder) {
    return transferViewSchema.parse({
      id: row.id,
      authorId: row.authorId,
      sourceCashRegisterId: row.sourceCashRegisterId,
      destinationCashRegisterId: row.destinationCashRegisterId,
      sourceCurrency: row.sourceCurrency,
      destinationCurrency: row.destinationCurrency,
      amount: moneyText(row.amount, row.sourceCurrency),
      targetAmount: moneyText(row.targetAmount, row.destinationCurrency),
      rate: row.rate?.toFixed(12) ?? null,
      rateSource: row.rateSource,
      description: row.description,
      state: row.state,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      handedOverAt: row.handedOverAt?.toISOString() ?? null,
      receivedAt: row.receivedAt?.toISOString() ?? null,
      handedOverById: row.handedOverById,
      receivedById: row.receivedById,
      operationId: row.operationId,
      slip: row.slip,
      rateQuoteId: row.rateQuoteId,
      rateOrigin: row.rate ? (row.rateOrigin ?? 'MANUAL') : null,
      rateEvidence: row.rateEvidence,
    });
  }
  private async endpoints(
    tx: Tx,
    ctx: DataContext,
    row: { sourceCashRegisterId: string; destinationCashRegisterId: string },
    permission: string,
  ) {
    for (const id of [
      ...new Set([row.sourceCashRegisterId, row.destinationCashRegisterId]),
    ].sort()) {
      if (permission === 'ledger:read') await this.access.requireCashRead(tx, ctx, id, permission);
      else await this.access.requireCash(tx, ctx, id, permission);
    }
  }
  async create(ctx: DataContext, raw: unknown) {
    const input = transferDraftSchema.parse(raw);
    const payloadHash = fingerprint({
      ...input,
      rate: input.rate ? new Decimal(input.rate).toFixed(12) : null,
      authorId: ctx.userId,
    });
    return this.access.run(ctx, async (tx) => {
      await this.endpoints(tx, ctx, input, 'draft:receive');
      const old = await tx.transferOrder.findFirst({
        where: { companyId: ctx.companyId, id: input.id },
      });
      if (old) {
        if (old.authorId !== ctx.userId || old.payloadHash !== payloadHash)
          throw new DataError('TRANSFER_CONFLICT');
        return this.view(old);
      }
      const find = async (cashRegisterId: string, currency: string) => {
        const a = await tx.treasuryAccount.findFirst({
          where: {
            companyId: ctx.companyId,
            cashRegisterId,
            currency,
            kind: 'TREASURY',
            active: true,
          },
        });
        if (!a) throw new DataError('ACCOUNT_NOT_FOUND');
        return a;
      };
      const source = await find(input.sourceCashRegisterId, input.sourceCurrency),
        destination = await find(input.destinationCashRegisterId, input.destinationCurrency);
      const targetAmount = input.rate
        ? new Decimal(input.amount)
            .mul(input.rate)
            .toDecimalPlaces(currencyPrecision(input.destinationCurrency))
            .toFixed(currencyPrecision(input.destinationCurrency))
        : input.amount;
      positiveAmountSchema.parse(targetAmount);
      const [funds] = await tx.$queryRaw<
        { available: Prisma.Decimal }[]
      >`SELECT available FROM "AvailableFunds" WHERE "companyId"=${ctx.companyId}::uuid AND "accountId"=${source.id}::uuid`;
      if (!funds || funds.available.lt(input.amount)) throw new DataError('INSUFFICIENT_FUNDS');
      const { id, amount, rate, ...data } = input;
      const row = await tx.transferOrder.create({
        data: {
          id,
          companyId: ctx.companyId,
          authorId: ctx.userId,
          ...data,
          amount,
          rate,
          targetAmount,
          sourceAccountId: source.id,
          destinationAccountId: destination.id,
          payloadHash,
        },
      });
      await tx.auditEvent.create({
        data: {
          id: randomUUID(),
          companyId: ctx.companyId,
          actorId: ctx.userId,
          action: 'TRANSFER_DRAFT_RECEIVED',
          targetType: 'TRANSFER',
          targetId: row.id,
        },
      });
      return this.view(row);
    });
  }
  async list(ctx: DataContext, raw: unknown) {
    const query = z
      .object({
        page: z.coerce.number().int().min(1).max(10000).default(1),
        state: z.enum(['DRAFT', 'HANDED_OVER', 'RECEIVED']).optional(),
      })
      .strict()
      .parse(raw);
    return this.access.run(ctx, async (tx) => {
      // Cash RLS filters both endpoint grants; the permission is also revalidated inside this transaction.
      await tx.$executeRaw`SELECT caissepro_assert_company_permission(${ctx.companyId}::uuid,${ctx.userId}::uuid,'ledger:read')`;
      const where = { companyId: ctx.companyId, ...(query.state ? { state: query.state } : {}) };
      const items = await tx.transferOrder.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * 25,
        take: 25,
      });
      for (const row of items) await this.endpoints(tx, ctx, row, 'ledger:read');
      return {
        items: items.map((r) => this.view(r)),
        total: await tx.transferOrder.count({ where }),
        page: query.page,
        pageSize: 25 as const,
      };
    });
  }
  async detail(ctx: DataContext, id: string) {
    return this.access.run(ctx, async (tx) => {
      const row = await this.get(tx, ctx, id);
      await this.endpoints(tx, ctx, row, 'ledger:read');
      return this.view(row);
    });
  }
  private async get(tx: Tx, ctx: DataContext, id: string) {
    const row = await tx.transferOrder.findFirst({ where: { companyId: ctx.companyId, id } });
    if (!row) throw new DataError('TRANSFER_NOT_FOUND');
    return row;
  }
  private async lock(tx: Tx, ctx: DataContext, id: string) {
    const first = await this.get(tx, ctx, id);
    await this.access.lockAccounts(tx, ctx, [first.sourceAccountId, first.destinationAccountId]);
    await tx.$executeRaw`SELECT id FROM "TransferOrder" WHERE "companyId"=${ctx.companyId}::uuid AND id=${id}::uuid FOR UPDATE`;
    return this.get(tx, ctx, id);
  }
  private async allowed(tx: Tx, ctx: DataContext, row: TransferOrder) {
    await this.endpoints(tx, ctx, row, 'transfer:post');
    if (row.sourceCurrency !== row.destinationCurrency)
      await this.endpoints(tx, ctx, row, 'fx:post');
  }
  async handover(ctx: DataContext, id: string, raw: unknown) {
    const input = handoverTransferSchema.parse(raw);
    return this.access.run(ctx, async (tx) => {
      const row = await this.lock(tx, ctx, id);
      await this.allowed(tx, ctx, row);
      if (row.authorId !== ctx.userId) throw new DataError('ACCESS_DENIED');
      if (row.state !== 'DRAFT') {
        if (row.handedOverById === ctx.userId && input.expectedVersion === 1) return this.view(row);
        throw new DataError('TRANSFER_CONFLICT');
      }
      if (row.version !== input.expectedVersion || (row.rate !== null && !input.rateValidated))
        throw new DataError('TRANSFER_CONFLICT');
      const [funds] = await tx.$queryRaw<
        { available: Prisma.Decimal }[]
      >`SELECT available FROM "AvailableFunds" WHERE "companyId"=${ctx.companyId}::uuid AND "accountId"=${row.sourceAccountId}::uuid`;
      if (!funds || funds.available.lt(row.amount)) throw new DataError('INSUFFICIENT_FUNDS');
      await this.sessions(tx, ctx, row);
      await tx.auditEvent.create({
        data: {
          id: randomUUID(),
          companyId: ctx.companyId,
          actorId: ctx.userId,
          action: 'TRANSFER_HANDED_OVER',
          targetType: 'TRANSFER',
          targetId: id,
        },
      });
      return this.view(
        await tx.transferOrder.update({
          where: { id },
          data: {
            state: 'HANDED_OVER',
            version: { increment: 1 },
            handedOverById: ctx.userId,
            handedOverAt: new Date(),
          },
        }),
      );
    });
  }
  private async sessions(tx: Tx, ctx: DataContext, row: TransferOrder) {
    const ids = [...new Set([row.sourceCashRegisterId, row.destinationCashRegisterId])].sort();
    // Entry triggers also lock and validate these sessions when posting.
    const rows = await tx.$queryRaw<
      { id: string; cashRegisterId: string }[]
    >`SELECT id,"cashRegisterId" FROM "CashSession" WHERE "companyId"=${ctx.companyId}::uuid AND "cashRegisterId" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) AND state='OPEN' ORDER BY id FOR UPDATE`;
    if (rows.length !== ids.length) throw new DataError('CASH_SESSION_REQUIRED');
    return {
      sourceSessionId: rows.find((s) => s.cashRegisterId === row.sourceCashRegisterId)!.id,
      destinationSessionId: rows.find((s) => s.cashRegisterId === row.destinationCashRegisterId)!
        .id,
    };
  }
  async receive(ctx: DataContext, id: string, raw: unknown) {
    const input = receiveTransferSchema.parse(raw);
    return this.access.run(ctx, async (tx) => {
      const row = await this.lock(tx, ctx, id);
      await this.allowed(tx, ctx, row);
      if (
        row.state === 'RECEIVED' &&
        row.receivedById === ctx.userId &&
        input.expectedVersion === 2
      )
        return this.view(row);
      if (row.state !== 'HANDED_OVER' || row.version !== input.expectedVersion)
        throw new DataError('TRANSFER_CONFLICT');
      if (row.handedOverById === ctx.userId)
        throw new DataError('TRANSFER_DISTINCT_RECEIVER_REQUIRED');
      const sessions = await this.sessions(tx, ctx, row);
      const account = await tx.treasuryAccount.findUniqueOrThrow({
        where: { id: row.sourceAccountId },
      });
      const common = {
        agencyId: account.agencyId,
        idempotencyKey: id,
        sourceAccountId: row.sourceAccountId,
        destinationAccountId: row.destinationAccountId,
        ...sessions,
        amount: moneyText(row.amount, row.sourceCurrency),
      };
      let operationId: string;
      if (row.rate === null)
        ({ operationId } = await this.ledger.transferInTransaction(tx, ctx, {
          ...common,
          currency: row.sourceCurrency,
        }));
      else {
        const rate = await tx.exchangeRate.create({
          data: {
            id: randomUUID(),
            companyId: ctx.companyId,
            fromCurrency: row.sourceCurrency,
            toCurrency: row.destinationCurrency,
            rate: row.rate,
            effectiveAt: row.handedOverAt!,
            transferOrderId: row.id,
            source: row.rateSource,
          },
        });
        const counter = async (currency: string) => {
          const result = await tx.treasuryAccount.findFirst({
            where: {
              companyId: ctx.companyId,
              agencyId: account.agencyId,
              currency,
              kind: 'CLEARING',
              active: true,
            },
            orderBy: { id: 'asc' },
          });
          if (!result) throw new DataError('ACCOUNT_NOT_FOUND');
          return result.id;
        };
        ({ operationId } = await this.ledger.convertInTransaction(tx, ctx, {
          ...common,
          exchangeRateId: rate.id,
          sourceCounterId: await counter(row.sourceCurrency),
          destinationCounterId: await counter(row.destinationCurrency),
        }));
      }
      await tx.auditEvent.create({
        data: {
          id: randomUUID(),
          companyId: ctx.companyId,
          actorId: ctx.userId,
          action: 'TRANSFER_RECEIVED',
          targetType: 'TRANSFER',
          targetId: id,
        },
      });
      return this.view(
        await tx.transferOrder.update({
          where: { id },
          data: {
            state: 'RECEIVED',
            version: { increment: 1 },
            operationId,
            receivedById: ctx.userId,
            receivedAt: new Date(),
          },
        }),
      );
    });
  }
}
