import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { draftSchema, expenseDetailsSchema, MAX_EVIDENCE_BYTES } from '@caissepro/shared';
import { z } from 'zod';
import { CentralAccess, DataError, type DataContext } from './central-access';
import { Prisma } from '../generated/prisma/client';
import { fingerprint } from './ledger.service';
import { decodeEvidence } from './receipt-evidence';
@Injectable()
export class DraftInboxService {
  constructor(@Inject(CentralAccess) private readonly access: CentralAccess) {}
  async receive(
    ctx: DataContext,
    agencyId: string,
    value: unknown,
    version: number,
    expectedServerVersion: number | null = null,
    cashRegisterId: string | null = null,
    metadata?: { createdAt: string; updatedAt: string },
  ) {
    const draft = draftSchema.parse(value);
    if (draft.kind === 'receipt' && !cashRegisterId) throw new DataError('DRAFT_CASH_REQUIRED');
    z.number().int().positive().parse(version);
    z.number().int().positive().nullable().parse(expectedServerVersion);
    if (Date.parse(draft.expiresAt) <= Date.now()) throw new DataError('DRAFT_EXPIRED');
    if (metadata) {
      const created = Date.parse(metadata.createdAt),
        updated = Date.parse(metadata.updatedAt);
      if (
        !Number.isFinite(created) ||
        !Number.isFinite(updated) ||
        updated < created ||
        updated > Date.now() + 1000
      )
        throw new DataError('DRAFT_DATES_INVALID');
    }
    return this.access.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, agencyId, 'draft:receive');
      if (cashRegisterId) await this.access.requireCash(tx, ctx, cashRegisterId, 'draft:receive');
      const previous = await tx.importedDraft.findFirst({
        where: { companyId: ctx.companyId, authorId: ctx.userId, clientDraftId: draft.id },
      });
      const payloadHash = fingerprint({ draft, cashRegisterId, ...(metadata ? { metadata } : {}) });
      if (
        metadata &&
        previous?.clientCreatedAt &&
        previous.clientCreatedAt.toISOString() !== new Date(metadata.createdAt).toISOString()
      )
        throw new DataError('DRAFT_CONFLICT');
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
          previous.cashRegisterId !== cashRegisterId ||
          previous.kind !== kind)
      )
        throw new DataError('DRAFT_CONFLICT');
      if (!previous && expectedServerVersion !== null) throw new DataError('DRAFT_CONFLICT');
      if (
        previous &&
        (await tx.cashReceipt.findFirst({
          where: { companyId: ctx.companyId, sourceDraftId: previous.id },
        }))
      )
        throw new DataError('DRAFT_ALREADY_CONFIRMED');
      if (
        previous &&
        (await tx.expenseRequest.findFirst({
          where: { companyId: ctx.companyId, sourceDraftId: previous.id },
        }))
      )
        throw new DataError('DRAFT_ALREADY_SUBMITTED');
      const expenseDetails =
        draft.kind === 'expense-request' && draft.expenseDetails
          ? expenseDetailsSchema.parse(draft.expenseDetails)
          : undefined;
      if (expenseDetails) {
        const total = expenseDetails.documents.reduce(
          (sum, doc) => sum + (decodeEvidence(doc).evidenceBytes?.length ?? 0),
          0,
        );
        if (total > MAX_EVIDENCE_BYTES) throw new DataError('EVIDENCE_INVALID');
      }
      const details = draft.kind === 'receipt' ? draft.receiptDetails : undefined;
      const data = {
        ...(metadata
          ? {
              clientCreatedAt: new Date(metadata.createdAt),
              clientUpdatedAt: new Date(metadata.updatedAt),
            }
          : {}),
        expenseDetails: expenseDetails ? expenseDetails : Prisma.DbNull,
        currency: draft.currency,
        amount: draft.amount,
        description: draft.description,
        version,
        payloadHash,
        receiptProvenance: details?.provenance ?? null,
        receiptCategory: details?.category ?? null,
        receiptReference: details?.reference ?? null,
        ...decodeEvidence(details?.supportingDocument),
      };
      const row = previous
        ? await tx.importedDraft.update({ where: { id: previous.id }, data })
        : await tx.importedDraft.create({
            data: {
              id: randomUUID(),
              companyId: ctx.companyId,
              agencyId,
              cashRegisterId,
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
