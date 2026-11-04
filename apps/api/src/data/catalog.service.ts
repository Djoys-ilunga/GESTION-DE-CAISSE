import { Injectable, Inject } from '@nestjs/common';
import { CentralAccess, type DataContext } from './central-access';
@Injectable()
export class CatalogService {
  constructor(@Inject(CentralAccess) private readonly access: CentralAccess) {}
  agency(ctx: DataContext, agencyId: string) {
    return this.access.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, agencyId, 'directory:read');
      return tx.agency.findFirst({
        where: { companyId: ctx.companyId, id: agencyId },
        select: {
          id: true,
          code: true,
          name: true,
          registers: { select: { id: true, code: true, name: true, active: true } },
          accounts: { select: { id: true, code: true, currency: true, kind: true, active: true } },
        },
      });
    });
  }
}
