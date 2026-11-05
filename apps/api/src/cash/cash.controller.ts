import { Controller, Inject, Get, Post, Put, Body, Req, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permission, type AuthRequest } from '../auth/auth.guard';
import { CashService } from './cash.service';
const context = (req: AuthRequest) => ({
  companyId: req.principal.companyId,
  userId: req.principal.userId,
  sessionId: req.principal.sessionId,
});
@Controller('cash')
export class CashController {
  constructor(@Inject(CashService) private readonly cash: CashService) {}
  @Get('configuration') @Permission('cash:configure') configuration(@Req() req: AuthRequest) {
    return this.cash.configuration(req.principal);
  }
  @Post('agencies') @Permission('cash:configure') agency(
    @Req() req: AuthRequest,
    @Body() body: unknown,
  ) {
    return this.cash.createAgency(req.principal, body);
  }
  @Post('registers') @Permission('cash:configure') create(
    @Req() req: AuthRequest,
    @Body() body: unknown,
  ) {
    return this.cash.create(req.principal, body);
  }
  @Put('registers/:id') @Permission('cash:configure') update(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.cash.update(req.principal, z.uuid().parse(id), body);
  }
  @Get('registers') @Permission('ledger:read') list(@Req() req: AuthRequest) {
    return this.cash.list(context(req), req.principal.profile.offlineUntil);
  }
  @Post('registers/:id/open') @Permission('session:manage') open(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return this.cash.openSession(context(req), z.uuid().parse(id));
  }
  @Get('drafts') @Permission('draft:read_own') drafts(
    @Req() req: AuthRequest,
    @Query() query: unknown,
  ) {
    const q = z
      .object({ page: z.coerce.number().int().min(1).max(10000).default(1) })
      .strict()
      .parse(query);
    return this.cash.drafts(context(req), q.page);
  }
  @Get('drafts/:id') @Permission('draft:read_own') source(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return this.cash.source(context(req), z.uuid().parse(id));
  }
  @Post('drafts/:id/confirm') @Permission('receipt:post') confirm(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.cash.confirm(context(req), z.uuid().parse(id), body);
  }
  @Get('receipts') @Permission('receipt:read') history(
    @Req() req: AuthRequest,
    @Query() query: unknown,
  ) {
    return this.cash.history(context(req), query);
  }
  @Get('receipts/:id') @Permission('receipt:read') receipt(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return this.cash.receipt(context(req), z.uuid().parse(id));
  }
  @Get('receipts/:id/evidence') @Permission('receipt:read') evidence(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return this.cash.evidence(context(req), z.uuid().parse(id));
  }
}
