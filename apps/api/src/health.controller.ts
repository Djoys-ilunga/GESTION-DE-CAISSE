import { Controller,Get,Header,Inject,ServiceUnavailableException } from '@nestjs/common';
import type { ApiHealth } from '@caissepro/shared';
import { READINESS_DATABASE,type ReadinessDatabase } from './database.port';
@Controller('health')
export class HealthController {
 constructor(@Inject(READINESS_DATABASE)private readonly db:ReadinessDatabase){}
 @Get('ready') @Header('Cache-Control','no-store')
 async ready():Promise<ApiHealth>{
  try{await this.db.installation.count();}catch{throw new ServiceUnavailableException('Service temporairement indisponible.');}
  return {service:'caissepro-api',protocolVersion:1,deploymentId:process.env.API_DEPLOYMENT_ID!,status:'ready'};
 }
}
