import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { Permission, type AuthRequest } from '../auth/auth.guard';
import { TransfersService } from './transfers.service';
const context = (r: AuthRequest) => ({
  companyId: r.principal.companyId,
  userId: r.principal.userId,
  sessionId: r.principal.sessionId,
});
@Controller('transfers')
export class TransfersController {
  constructor(@Inject(TransfersService) private readonly transfers: TransfersService) {}
  @Post('drafts') @Permission('draft:write_own') create(
    @Req() r: AuthRequest,
    @Body() body: unknown,
  ) {
    return this.transfers.create(context(r), body);
  }
  @Get() @Permission('ledger:read') list(@Req() r: AuthRequest, @Query() query: unknown) {
    return this.transfers.list(context(r), query);
  }
  @Get(':id') @Permission('ledger:read') detail(@Req() r: AuthRequest, @Param('id') id: string) {
    return this.transfers.detail(context(r), z.uuid().parse(id));
  }
  @Post(':id/handover') @Permission('transfer:post') handover(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.transfers.handover(context(r), z.uuid().parse(id), body);
  }
  @Post(':id/receive') @Permission('transfer:post') receive(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.transfers.receive(context(r), z.uuid().parse(id), body);
  }
}
