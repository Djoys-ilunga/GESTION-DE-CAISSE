import { Controller, Get, Header, Inject, ServiceUnavailableException } from '@nestjs/common';
import { API_PROTOCOL_VERSION, type ApiHealth } from '@caissepro/shared';
import { Public } from './auth/auth.guard';
import { READINESS_DATABASE, type ReadinessDatabase } from './database.port';
@Controller('health')
export class HealthController {
  constructor(@Inject(READINESS_DATABASE) private readonly db: ReadinessDatabase) {}
  @Get('ready')
  @Public()
  @Header('Cache-Control', 'no-store')
  async ready(): Promise<ApiHealth> {
    try {
      await this.db.ready();
    } catch {
      throw new ServiceUnavailableException('Service temporairement indisponible.');
    }
    return {
      service: 'caissepro-api',
      protocolVersion: API_PROTOCOL_VERSION,
      deploymentId: process.env.API_DEPLOYMENT_ID!,
      status: 'ready',
    };
  }
}
