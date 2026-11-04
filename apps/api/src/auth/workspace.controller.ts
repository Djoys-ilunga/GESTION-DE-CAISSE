import { Controller, Get, Post, Body, Req, Param, Inject, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { draftSchema } from '@caissepro/shared';
import { Permission, type AuthRequest } from './auth.guard';
import { CentralAccess, type DataContext } from '../data/central-access';
import { LedgerService } from '../data/ledger.service';
import { DraftInboxService } from '../data/draft-inbox.service';
const ctx = (r: AuthRequest): DataContext => ({
  companyId: r.principal.companyId,
  userId: r.principal.userId,
  sessionId: r.principal.sessionId,
});
@Controller('workspace')
export class WorkspaceController {
  constructor(
    @Inject(CentralAccess) private readonly access: CentralAccess,
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(DraftInboxService) private readonly inbox: DraftInboxService,
  ) {}
  @Permission('ledger:read') @Get('balances') async balances(@Req() req: AuthRequest) {
    const context = ctx(req);
    const accounts = await this.access.run(context, async (tx) => {
      for (const r of req.principal.profile.cashRegisters)
        await this.access.requireCash(tx, context, r.id, 'ledger:read');
      return tx.treasuryAccount.findMany({
        where: {
          companyId: context.companyId,
          active: true,
          cashRegisterId: { in: req.principal.profile.cashRegisters.map((r) => r.id) },
          kind: 'TREASURY',
        },
        select: { id: true, cashRegisterId: true, currency: true },
      });
    });
    const balances = [];
    for (const account of accounts)
      balances.push({
        accountId: account.id,
        cashRegisterId: account.cashRegisterId,
        ...(await this.ledger.balance(context, account.id)),
      });
    return {
      synchronizedAt: new Date().toISOString(),
      expiresAt: req.principal.profile.offlineUntil,
      balances,
    };
  }
  @Permission('draft:read_own') @Get('drafts') drafts(@Req() req: AuthRequest) {
    const context = ctx(req);
    return this.access.run(context, (tx) =>
      tx.importedDraft.findMany({
        where: { companyId: context.companyId, authorId: context.userId },
        select: {
          clientDraftId: true,
          agencyId: true,
          cashRegisterId: true,
          kind: true,
          currency: true,
          amount: true,
          description: true,
          version: true,
          receivedAt: true,
        },
        take: 100,
        orderBy: { receivedAt: 'desc' },
      }),
    );
  }
  @Permission('draft:read_own') @Get('drafts/:draftId') async draft(
    @Req() req: AuthRequest,
    @Param('draftId') id: string,
  ) {
    const context = ctx(req);
    z.uuid().parse(id);
    const row = await this.access.run(context, (tx) =>
      tx.importedDraft.findFirst({
        where: { companyId: context.companyId, authorId: context.userId, clientDraftId: id },
        select: {
          clientDraftId: true,
          version: true,
          kind: true,
          currency: true,
          amount: true,
          description: true,
        },
      }),
    );
    if (!row) throw new NotFoundException('Brouillon introuvable.');
    return row;
  }
  @Permission('draft:write_own') @Post('drafts/sync') sync(
    @Req() req: AuthRequest,
    @Body() body: unknown,
  ) {
    const value = z
      .object({
        draft: draftSchema,
        agencyId: z.uuid(),
        cashRegisterId: z.uuid().nullable(),
        version: z.number().int().positive(),
        expectedServerVersion: z.number().int().positive().nullable(),
      })
      .strict()
      .parse(body);
    return this.inbox.receive(
      ctx(req),
      value.agencyId,
      value.draft,
      value.version,
      value.expectedServerVersion,
      value.cashRegisterId,
    );
  }
}
