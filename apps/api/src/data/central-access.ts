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
            return action(tx);
          },
          { isolationLevel: 'Serializable', maxWait: 10000, timeout: 15000 },
        );
      } catch (error) {
        if (error instanceof DataError) throw error;
        const message = error instanceof Error ? error.message : '';
        const code = (error as { code?: string })?.code;
        if (
          attempt < 5 &&
          (['P2034', 'P2002'].includes(code ?? '') ||
            /40001|40P01|serialization|deadlock/i.test(message))
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
          continue;
        }
        throw new DataError(message.match(/CAISSEPRO_[A-Z_]+/)?.[0] ?? 'DATA_INTEGRITY_ERROR');
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
}
