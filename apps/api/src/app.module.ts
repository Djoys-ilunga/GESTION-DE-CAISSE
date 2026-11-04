import { Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { HealthController } from './health.controller';
import { READINESS_DATABASE } from './database.port';
import { DataModule } from './data/data.module';
import { AuthModule } from './auth/auth.module';
@Module({
  imports: [DataModule, AuthModule],
  controllers: [HealthController],
  providers: [{ provide: READINESS_DATABASE, useExisting: PrismaService }],
})
export class AppModule {}
