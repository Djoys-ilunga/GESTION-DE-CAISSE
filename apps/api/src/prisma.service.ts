import { Injectable, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { registerCurrencyDefinitions } from '@caissepro/shared';
import { PrismaClient } from './generated/prisma/client';
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({
      adapter: new PrismaPg({
        connectionString: process.env.DATABASE_URL,
        max: 5,
        connectionTimeoutMillis: 3000,
        query_timeout: 3000,
        statement_timeout: 3000,
      }),
    });
  }
  async onModuleInit() {
    await this.$connect();
    // L’adaptateur crée son pool paresseusement : seule une requête confirme
    // la disponibilité réelle de PostgreSQL et du schéma attendu.
    await this.ready();
  }
  async ready() {
    return this.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE caissepro_runtime');
      const catalog = await tx.currencyDefinition.findMany({
        select: { code: true, precision: true },
      });
      if (
        !catalog.some((c) => c.code === 'CDF' && c.precision === 2) ||
        !catalog.some((c) => c.code === 'USD' && c.precision === 2)
      )
        throw new Error('CURRENCY_SCHEMA_NOT_READY');
      registerCurrencyDefinitions(catalog);
      return tx.installation.count();
    });
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
