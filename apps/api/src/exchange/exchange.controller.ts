import { Body, Controller, Get, Inject, Post, Put, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { Permission, type AuthRequest } from '../auth/auth.guard';
import { ExchangeRatesService } from './exchange.service';
const ctx = (r: AuthRequest) => ({
  companyId: r.principal.companyId,
  userId: r.principal.userId,
  sessionId: r.principal.sessionId,
});
@Controller('exchange-rates')
export class ExchangeRatesController {
  constructor(@Inject(ExchangeRatesService) private readonly rates: ExchangeRatesService) {}
  @Get() @Permission('ledger:read') list(@Req() r: AuthRequest) {
    return this.rates.rates(ctx(r));
  }
  @Get('history') @Permission('ledger:read') history(@Req() r: AuthRequest, @Query() raw: unknown) {
    const q = z
      .object({ page: z.coerce.number().int().min(1).max(10000).default(1) })
      .strict()
      .parse(raw);
    return this.rates.history(ctx(r), q.page);
  }
  @Post('refresh') @Permission('cash:configure') refresh(
    @Req() r: AuthRequest,
    @Body() raw: unknown,
  ) {
    z.object({ confirmed: z.literal(true) })
      .strict()
      .parse(raw);
    return this.rates.refresh(ctx(r));
  }
  @Put('policy') @Permission('cash:configure') policy(@Req() r: AuthRequest, @Body() raw: unknown) {
    return this.rates.policy(ctx(r), raw);
  }
  @Post('quote') @Permission('ledger:read') quote(@Req() r: AuthRequest, @Body() raw: unknown) {
    return this.rates.quote(ctx(r), raw);
  }
}
