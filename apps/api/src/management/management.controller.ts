import { Body, Controller, Get, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { Permission, type AuthRequest } from '../auth/auth.guard';
import { ManagementService } from './management.service';
import { auditQuerySchema } from '@caissepro/shared';
import { exportAudit } from './audit-export';
@Controller('management')
export class ManagementController {
  @Get('audit/pdf') @Permission('auth:logs:read') async auditPdf(
    @Req() r: AuthRequest,
    @Query() q: unknown,
  ) {
    return exportAudit(
      await this.management.auditLog(r.principal, q, true),
      r.principal.profile.company,
      auditQuerySchema.parse(q),
      'pdf',
    );
  }
  @Get('audit/xlsx') @Permission('auth:logs:read') async auditXlsx(
    @Req() r: AuthRequest,
    @Query() q: unknown,
  ) {
    return exportAudit(
      await this.management.auditLog(r.principal, q, true),
      r.principal.profile.company,
      auditQuerySchema.parse(q),
      'xlsx',
    );
  }
  constructor(@Inject(ManagementService) private readonly management: ManagementService) {}
  @Get('settings') @Permission('cash:configure') settings(@Req() r: AuthRequest) {
    return this.management.settings(r.principal);
  }
  @Get('references') @Permission('directory:read') references(@Req() r: AuthRequest) {
    return this.management.referenceData(r.principal);
  }
  @Get('supervision') @Permission('ledger:read') supervision(@Req() r: AuthRequest) {
    return this.management.supervision(r.principal);
  }
  @Get('audit') @Permission('auth:logs:read') audit(@Req() r: AuthRequest, @Query() q: unknown) {
    return this.management.auditLog(r.principal, q);
  }
  @Put('company') @Permission('cash:configure') company(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.management.updateCompany(r.principal, b);
  }
  @Put('agencies/:id') @Permission('cash:configure') agency(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.management.updateAgency(r.principal, z.uuid().parse(id), b);
  }
  @Post('categories') @Permission('cash:configure') category(
    @Req() r: AuthRequest,
    @Body() b: unknown,
  ) {
    return this.management.category(r.principal, b);
  }
  @Post('rates') @Permission('cash:configure') rate(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.management.publishRate(r.principal, b);
  }
}
