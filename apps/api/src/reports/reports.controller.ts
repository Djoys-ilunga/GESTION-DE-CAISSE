import { Body, Controller, Get, Inject, Post, Query, Req } from '@nestjs/common';
import { Permission, type AuthRequest } from '../auth/auth.guard';
import { ReportsService } from './reports.service';
import { exportReport } from './report-export';
const context = (r: AuthRequest) => ({
  companyId: r.principal.companyId,
  userId: r.principal.userId,
  sessionId: r.principal.sessionId,
});
@Controller('reports')
export class ReportsController {
  constructor(@Inject(ReportsService) private readonly reports: ReportsService) {}
  @Get() @Permission('ledger:read') snapshot(@Req() r: AuthRequest, @Query() q: unknown) {
    return this.reports.snapshot(context(r), q);
  }
  @Get('pdf') @Permission('ledger:read') async pdf(@Req() r: AuthRequest, @Query() q: unknown) {
    return exportReport(await this.reports.snapshot(context(r), q), 'pdf');
  }
  @Get('xlsx') @Permission('ledger:read') async xlsx(@Req() r: AuthRequest, @Query() q: unknown) {
    return exportReport(await this.reports.snapshot(context(r), q), 'xlsx');
  }
  @Post('close') @Permission('session:manage') close(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.reports.close(context(r), b);
  }
}
