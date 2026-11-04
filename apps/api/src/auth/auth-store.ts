import { Inject, Injectable, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { Prisma } from '../generated/prisma/client';
export type AuthTx = Prisma.TransactionClient;
@Injectable()
export class AuthStore {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}
  async run<T>(action: (tx: AuthTx) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++)
      try {
        return await this.db.$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe('SET LOCAL ROLE caissepro_auth_runtime');
            return action(tx);
          },
          { isolationLevel: 'Serializable', timeout: 15000, maxWait: 10000 },
        );
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (attempt < 4 && ['P2034', 'P2002'].includes(code ?? '')) {
          await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
          continue;
        }
        if (code?.startsWith('P'))
          throw new ConflictException(
            'Modification impossible. Réessayez ou vérifiez les données.',
          );
        throw error;
      }
  }
}
