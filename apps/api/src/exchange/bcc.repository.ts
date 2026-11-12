import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { Tx } from '../data/central-access';
@Injectable()
export class BccRepository {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}
  async run<T>(action: (tx: Tx) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++)
      try {
        return await this.db.$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe('SET LOCAL ROLE caissepro_bcc_worker');
            return action(tx);
          },
          { isolationLevel: 'Serializable', timeout: 15000, maxWait: 10000 },
        );
      } catch (e) {
        if (
          attempt < 4 &&
          (['P2034', 'P2002'].includes((e as { code?: string }).code ?? '') ||
            /40001|40P01|serializ|deadlock/i.test(String(e)))
        )
          continue;
        throw e;
      }
  }
}
