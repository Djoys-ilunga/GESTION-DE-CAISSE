import { Controller, Inject, Get, Post, Put, Body, Req, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { currencySchema } from '@caissepro/shared';
import { Permission, type AuthRequest } from '../auth/auth.guard';
import { ExpensesService } from './expenses.service';
const context = (r: AuthRequest) => ({
  companyId: r.principal.companyId,
  userId: r.principal.userId,
  sessionId: r.principal.sessionId,
});
@Controller('expenses')
export class ExpensesController {
  constructor(@Inject(ExpensesService) private readonly expenses: ExpensesService) {}
  @Get('policies') @Permission('cash:configure') policies(@Req() r: AuthRequest) {
    return this.expenses.policies(context(r));
  }
  @Put('policies/:currency') @Permission('cash:configure') configure(
    @Req() r: AuthRequest,
    @Param('currency') currency: string,
    @Body() body: unknown,
  ) {
    return this.expenses.configure(context(r), currencySchema.parse(currency), body);
  }
  @Get('drafts') @Permission('draft:read_own') drafts(
    @Req() r: AuthRequest,
    @Query() query: unknown,
  ) {
    const q = z
      .object({ page: z.coerce.number().int().min(1).max(10000).default(1) })
      .strict()
      .parse(query);
    return this.expenses.drafts(context(r), q.page);
  }
  @Get('drafts/:id') @Permission('draft:read_own') source(
    @Req() r: AuthRequest,
    @Param('id') id: string,
  ) {
    return this.expenses.source(context(r), z.uuid().parse(id));
  }
  @Post('drafts/:id/submit') @Permission('expense:request') submit(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.expenses.submit(context(r), z.uuid().parse(id), body);
  }
  @Get('requests') @Permission('ledger:read') list(@Req() r: AuthRequest, @Query() q: unknown) {
    return this.expenses.list(context(r), q);
  }
  @Get('requests/:id') @Permission('ledger:read') detail(
    @Req() r: AuthRequest,
    @Param('id') id: string,
  ) {
    return this.expenses.detail(context(r), z.uuid().parse(id));
  }
  @Post('requests/:id/decision') @Permission('expense:approve') decide(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.expenses.decide(context(r), z.uuid().parse(id), body);
  }
  @Post('requests/:id/pay') @Permission('expense:pay') pay(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.expenses.pay(context(r), z.uuid().parse(id), body);
  }
  @Get('vouchers/:id') @Permission('ledger:read') voucher(
    @Req() r: AuthRequest,
    @Param('id') id: string,
  ) {
    return this.expenses.voucher(context(r), z.uuid().parse(id));
  }
  @Get('requests/:id/evidence/:evidenceId') @Permission('ledger:read') evidence(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Param('evidenceId') evidenceId: string,
  ) {
    return this.expenses.evidence(context(r), z.uuid().parse(id), z.uuid().parse(evidenceId));
  }
}
