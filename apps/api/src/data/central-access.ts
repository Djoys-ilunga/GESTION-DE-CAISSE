import { randomInt } from 'node:crypto';
import { loadCurrencyMetadata } from './money';
import { Injectable, Inject } from '@nestjs/common';
import { z } from 'zod';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma.service';
export type DataContext = { companyId: string; userId: string; sessionId?: string };
export type Tx = Prisma.TransactionClient;
export class DataError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const contextSchema = z
  .object({ companyId: z.uuid(), userId: z.uuid(), sessionId: z.uuid().optional() })
  .strict();
@Injectable()
export class CentralAccess {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}
  async run<T>(context: DataContext, action: (tx: Tx) => Promise<T>): Promise<T> {
    const ctx = contextSchema.parse(context);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.db.$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe('SET LOCAL ROLE caissepro_runtime');
            await tx.$executeRaw`SELECT set_config('caissepro.company_id', ${ctx.companyId}, true), set_config('caissepro.actor_id', ${ctx.userId}, true)`;
            await tx.$executeRaw`SELECT set_config('caissepro.session_id', ${ctx.sessionId ?? ''}, true)`;
            await tx.$executeRaw`SELECT caissepro_assert_session(${ctx.companyId}::uuid,${ctx.userId}::uuid)`;
            await loadCurrencyMetadata(tx);
            return action(tx);
          },
          { isolationLevel: 'Serializable', maxWait: 10000, timeout: 15000 },
        );
      } catch (error) {
        if (error instanceof DataError) throw error;
        const message = error instanceof Error ? error.message : '';
        const code = (error as { code?: string })?.code;
        const cause = (
          error as {
            meta?: {
              driverAdapterError?: {
                cause?: { originalMessage?: unknown; originalCode?: unknown };
              };
            };
          }
        )?.meta?.driverAdapterError?.cause;
        const sqlState = typeof cause?.originalCode === 'string' ? cause.originalCode : '';
        // Prefer the server's SQLSTATE/message over Prisma's source-code excerpt.
        // A snippet mentioning Serializable must not replay a business refusal.
        const retryMessage =
          typeof cause?.originalMessage === 'string' ? cause.originalMessage : message;
        if (
          attempt < 8 &&
          (['P2034', 'P2002'].includes(code ?? '') ||
            ['40001', '40P01'].includes(sqlState) ||
            (!sqlState && /40001|40P01|serializ|deadlock|write conflict/i.test(retryMessage)))
        ) {
          // Six simultaneous syncs each commit STARTED/draft/SUCCESS transactions.
          // A bounded exponential delay with jitter avoids retrying them in lockstep.
          const delay = Math.min(25 * 2 ** attempt, 250) + randomInt(0, 26);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        // Prisma peut inclure des extraits de code avant le message PostgreSQL.
        const original = (
          error as { meta?: { driverAdapterError?: { cause?: { originalMessage?: unknown } } } }
        )?.meta?.driverAdapterError?.cause?.originalMessage;
        const databaseMessage = typeof original === 'string' ? original : '';
        const markers = [...`${message}\n${databaseMessage}`.matchAll(/CAISSEPRO_[A-Z_]+/g)];
        throw new DataError(markers.at(-1)?.[0] ?? 'DATA_INTEGRITY_ERROR');
      }
    }
  }
  async require(tx: Tx, ctx: DataContext, agencyId: string, permission: string) {
    z.uuid().parse(agencyId);
    await tx.$executeRaw`SELECT caissepro_assert_permission(${ctx.companyId}::uuid, ${ctx.userId}::uuid, ${agencyId}::uuid, ${permission})`;
  }
  async lockAccounts(tx: Tx, ctx: DataContext, ids: string[]) {
    const unique = [...new Set(ids)].sort();
    unique.forEach((id) => z.uuid().parse(id));
    const rows = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "TreasuryAccount" WHERE "companyId"=${ctx.companyId}::uuid AND id IN (${Prisma.join(unique.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`;
    if (rows.length !== unique.length) throw new DataError('ACCOUNT_NOT_FOUND');
  }
  async requireCash(tx: Tx, ctx: DataContext, cashRegisterId: string, permission: string) {
    z.uuid().parse(cashRegisterId);
    await tx.$executeRaw`SELECT caissepro_assert_cash_permission(${ctx.companyId}::uuid,${ctx.userId}::uuid,${cashRegisterId}::uuid,${permission})`;
  }
  async requireCashRead(
    tx: Tx,
    ctx: DataContext,
    cashRegisterId: string,
    permission: 'ledger:read' | 'receipt:read',
  ) {
    z.uuid().parse(cashRegisterId);
    await tx.$executeRaw`SELECT caissepro_assert_cash_read(${ctx.companyId}::uuid,${ctx.userId}::uuid,${cashRegisterId}::uuid,${permission})`;
  }
}
