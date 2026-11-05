import { Injectable, Inject } from '@nestjs/common';
import { CentralAccess, type DataContext } from './central-access';
@Injectable()
export class CatalogService {
  constructor(@Inject(CentralAccess) private readonly access: CentralAccess) {}
  agency(ctx: DataContext, agencyId: string) {
    return this.access.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, agencyId, 'directory:read');
      const grants = await tx.cashRegisterGrant.findMany({
        where: { companyId: ctx.companyId, member: { userId: ctx.userId, active: true } },
        select: { cashRegisterId: true },
      });
      const ids = grants.map((g) => g.cashRegisterId);
      return tx.agency.findFirst({
        where: { companyId: ctx.companyId, id: agencyId },
        select: {
          id: true,
          code: true,
          name: true,
          registers: {
            where: { id: { in: ids } },
            select: { id: true, code: true, name: true, active: true },
          },
          accounts: {
            where: { OR: [{ cashRegisterId: null }, { cashRegisterId: { in: ids } }] },
            select: { id: true, code: true, currency: true, kind: true, active: true },
          },
        },
      });
    });
  }
}
