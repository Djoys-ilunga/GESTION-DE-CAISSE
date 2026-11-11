import { Body, Controller, Get, Inject, Put, Req } from '@nestjs/common';
import { Permission, type AuthRequest } from '../auth/auth.guard';
import { MoneyService } from './money.service';
const ctx = (r: AuthRequest) => ({
  companyId: r.principal.companyId,
  userId: r.principal.userId,
  sessionId: r.principal.sessionId,
});
@Controller('money')
export class MoneyController {
  constructor(@Inject(MoneyService) private readonly money: MoneyService) {}
  @Get('context') context(@Req() r: AuthRequest) {
    return this.money.context(ctx(r));
  }
  @Put('preferences') preferences(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.money.preferences(ctx(r), b);
  }
  @Put('currencies') @Permission('cash:configure') currencies(
    @Req() r: AuthRequest,
    @Body() b: unknown,
  ) {
    return this.money.configureCurrency(r.principal, b);
  }
  @Put('reporting') @Permission('cash:configure') reporting(
    @Req() r: AuthRequest,
    @Body() b: unknown,
  ) {
    return this.money.reporting(r.principal, b);
  }
}
