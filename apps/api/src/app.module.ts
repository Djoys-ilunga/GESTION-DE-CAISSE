import { Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { HealthController } from './health.controller';
import { READINESS_DATABASE } from './database.port';
import { DataModule } from './data/data.module';
@Module({
  imports: [DataModule],
  controllers: [HealthController],
  providers: [{ provide: READINESS_DATABASE, useExisting: PrismaService }],
})
export class AppModule {}
