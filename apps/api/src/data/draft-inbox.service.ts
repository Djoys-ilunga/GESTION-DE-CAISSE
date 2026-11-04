import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { draftSchema } from '@caissepro/shared';
import { z } from 'zod';
import { CentralAccess, DataError, type DataContext } from './central-access';
import { fingerprint } from './ledger.service';
@Injectable()
export class DraftInboxService {
  constructor(@Inject(CentralAccess) private readonly access: CentralAccess) {}
  async receive(
    ctx: DataContext,
    agencyId: string,
    value: unknown,
    version: number,
    expectedServerVersion: number | null = null,
  ) {
    const draft = draftSchema.parse(value);
    z.number().int().positive().parse(version);
    z.number().int().positive().nullable().parse(expectedServerVersion);
    if (Date.parse(draft.expiresAt) <= Date.now()) throw new DataError('DRAFT_EXPIRED');
    return this.access.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, agencyId, 'draft:receive');
      const previous = await tx.importedDraft.findFirst({
        where: { companyId: ctx.companyId, authorId: ctx.userId, clientDraftId: draft.id },
      });
      const payloadHash = fingerprint(draft);
      if (
        previous?.version === version &&
        previous.payloadHash === payloadHash &&
        previous.agencyId === agencyId
      )
        return {
          draftId: draft.id,
          outcome: 'accepted-as-draft' as const,
          code: 'draft-received' as const,
        };
      const kind = draft.kind === 'receipt' ? ('RECEIPT' as const) : ('EXPENSE_REQUEST' as const);
      if (
        previous &&
        (previous.version !== expectedServerVersion ||
          version <= previous.version ||
          previous.agencyId !== agencyId ||
          previous.kind !== kind)
      )
        throw new DataError('DRAFT_CONFLICT');
      if (!previous && expectedServerVersion !== null) throw new DataError('DRAFT_CONFLICT');
      const data = {
        currency: draft.currency,
        amount: draft.amount,
        description: draft.description,
        version,
        payloadHash,
      };
      const row = previous
        ? await tx.importedDraft.update({ where: { id: previous.id }, data })
        : await tx.importedDraft.create({
            data: {
              id: randomUUID(),
              companyId: ctx.companyId,
              agencyId,
              authorId: ctx.userId,
              clientDraftId: draft.id,
              kind,
              ...data,
            },
          });
      await tx.auditEvent.create({
        data: {
          id: randomUUID(),
          companyId: ctx.companyId,
          actorId: ctx.userId,
          action: 'DRAFT_RECEIVED',
          targetType: 'DRAFT',
          targetId: row.id,
        },
      });
      return {
        draftId: draft.id,
        outcome: 'accepted-as-draft' as const,
        code: 'draft-received' as const,
      };
    });
  }
}
