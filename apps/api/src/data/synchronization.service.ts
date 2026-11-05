import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Draft } from '@caissepro/shared';
import { CentralAccess, DataError, type DataContext, type Tx } from './central-access';
import { DraftInboxService } from './draft-inbox.service';
import type { Prisma } from '../generated/prisma/client';

export type SyncEnvelope = {
  draft: Draft;
  agencyId: string;
  cashRegisterId: string | null;
  version: number;
  expectedServerVersion: number | null;
  syncProtocol?: 2;
  originalCreatedAt?: string;
  updatedAt?: string;
};
const include = {
  receipt: { select: { id: true } },
  expense: { select: { id: true } },
} satisfies Prisma.ImportedDraftInclude;
type Source = Prisma.ImportedDraftGetPayload<{ include: typeof include }>;
function remote(r: Source) {
  return {
    serverId: r.id,
    clientDraftId: r.clientDraftId,
    agencyId: r.agencyId,
    cashRegisterId: r.cashRegisterId,
    kind: r.kind === 'RECEIPT' ? ('receipt' as const) : ('expense-request' as const),
    version: r.version,
    createdAt: (r.clientCreatedAt ?? r.receivedAt).toISOString(),
    updatedAt: (r.clientUpdatedAt ?? r.receivedAt).toISOString(),
    receivedAt: r.receivedAt.toISOString(),
    sourceState: r.receipt
      ? ('confirmed' as const)
      : r.expense
        ? ('submitted' as const)
        : ('draft' as const),
    receiptId: r.receipt?.id ?? null,
    expenseRequestId: r.expense?.id ?? null,
  };
}
@Injectable()
export class SynchronizationService {
  constructor(
    @Inject(CentralAccess) private readonly access: CentralAccess,
    @Inject(DraftInboxService) private readonly inbox: DraftInboxService,
  ) {}
  private permission(tx: Tx, c: DataContext, p: string) {
    return tx.$executeRaw`SELECT caissepro_assert_company_permission(${c.companyId}::uuid,${c.userId}::uuid,${p})`;
  }
  async receive(c: DataContext, v: SyncEnvelope) {
    const attemptId = randomUUID();
    await this.access.run(c, async (tx) => {
      await this.permission(tx, c, 'draft:write_own');
      await this.access.require(tx, c, v.agencyId, 'draft:receive');
      if (v.cashRegisterId) await this.access.requireCash(tx, c, v.cashRegisterId, 'draft:receive');
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${c.companyId + ':' + c.userId + ':sync'},0))`;
      const count = await tx.syncEvent.count({
        where: {
          companyId: c.companyId,
          authorId: c.userId,
          stage: 'STARTED',
          createdAt: { gt: new Date(Date.now() - 60000) },
        },
      });
      if (count >= 30) throw new DataError('SYNC_RATE_LIMIT');
      await tx.syncEvent.create({
        data: {
          id: randomUUID(),
          companyId: c.companyId,
          authorId: c.userId,
          attemptId,
          clientDraftId: v.draft.id,
          version: v.version,
          stage: 'STARTED',
          code: 'started',
        },
      });
    });
    try {
      await this.inbox.receive(
        c,
        v.agencyId,
        v.draft,
        v.version,
        v.expectedServerVersion,
        v.cashRegisterId,
        v.syncProtocol === 2
          ? {
              createdAt: v.originalCreatedAt ?? v.draft.createdAt,
              updatedAt: v.updatedAt ?? v.draft.createdAt,
            }
          : undefined,
      );
      return await this.access.run(c, async (tx) => {
        await this.permission(tx, c, 'draft:read_own');
        const row = await tx.importedDraft.findFirstOrThrow({
          where: { companyId: c.companyId, authorId: c.userId, clientDraftId: v.draft.id },
          include,
        });
        if (row.version !== v.version) throw new DataError('DRAFT_CONFLICT');
        const metadata = remote(row);
        await tx.syncEvent.create({
          data: {
            id: randomUUID(),
            companyId: c.companyId,
            authorId: c.userId,
            attemptId,
            clientDraftId: v.draft.id,
            version: v.version,
            stage: 'SUCCESS',
            code: 'draft-received',
            serverId: row.id,
          },
        });
        const ack = {
          draftId: v.draft.id,
          outcome: 'accepted-as-draft' as const,
          code: 'draft-received' as const,
        };
        if (v.syncProtocol !== 2) return ack;
        return {
          ...ack,
          serverId: row.id,
          serverVersion: row.version,
          synchronizedAt: new Date().toISOString(),
          sourceState: metadata.sourceState,
          receiptId: metadata.receiptId,
          expenseRequestId: metadata.expenseRequestId,
        };
      });
    } catch (error) {
      const code = error instanceof DataError ? error.code : '';
      const conflict = /CONFLICT|ALREADY/.test(code);
      try {
        await this.access.run(c, async (tx) => {
          await this.permission(tx, c, 'draft:write_own');
          await tx.syncEvent.create({
            data: {
              id: randomUUID(),
              companyId: c.companyId,
              authorId: c.userId,
              attemptId,
              clientDraftId: v.draft.id,
              version: v.version,
              stage: conflict ? 'CONFLICT' : 'ERROR',
              code: conflict
                ? 'conflict'
                : code.includes('ACCESS_DENIED')
                  ? 'permission-denied'
                  : code.includes('EXPIRED')
                    ? 'expired'
                    : 'validation-failed',
            },
          });
        });
      } catch {
        /* La révocation interdit aussi l’écriture d’un journal dans l’ancien contexte. */
      }
      throw error;
    }
  }
  async authorizedScope(tx: Tx, c: DataContext) {
    await this.permission(tx, c, 'draft:read_own');
    const member = await tx.companyMember.findFirst({
      where: { companyId: c.companyId, userId: c.userId, active: true },
      include: { agencies: true, cashGrants: true },
    });
    return {
      companyId: c.companyId,
      authorId: c.userId,
      agencyId: { in: member?.agencies.map((a) => a.agencyId) ?? [] },
      agency: { active: true },
      OR: [
        { cashRegisterId: null },
        { cashRegisterId: { in: member?.cashGrants.map((g) => g.cashRegisterId) ?? [] } },
      ],
    } satisfies Prisma.ImportedDraftWhereInput;
  }
  manifest(c: DataContext, page: number) {
    return this.access.run(c, async (tx) => {
      const where = await this.authorizedScope(tx, c);
      const [rows, total] = await Promise.all([
        tx.importedDraft.findMany({
          where,
          include,
          orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * 50,
          take: 50,
        }),
        tx.importedDraft.count({ where }),
      ]);
      return { items: rows.map(remote), total, page, pageSize: 50 as const };
    });
  }
  source(c: DataContext, id: string) {
    return this.access.run(c, async (tx) => {
      const where = await this.authorizedScope(tx, c);
      const r = await tx.importedDraft.findFirst({
        where: { ...where, clientDraftId: id },
        include,
      });
      if (!r) throw new DataError('DRAFT_NOT_FOUND');
      await this.access.require(tx, c, r.agencyId, 'draft:read_own');
      if (r.cashRegisterId)
        await this.access.requireCashRead(tx, c, r.cashRegisterId, 'ledger:read');
      return {
        ...remote(r),
        currency: r.currency,
        amount: r.amount.toFixed(2),
        description: r.description,
        receiptDetails:
          r.kind === 'RECEIPT' &&
          r.receiptProvenance &&
          r.receiptCategory &&
          r.receiptReference !== null
            ? {
                provenance: r.receiptProvenance,
                category: r.receiptCategory,
                reference: r.receiptReference,
                supportingDocument:
                  r.evidenceBytes && r.evidenceName && r.evidenceMime
                    ? {
                        fileName: r.evidenceName,
                        mimeType: r.evidenceMime,
                        dataBase64: Buffer.from(r.evidenceBytes).toString('base64'),
                      }
                    : null,
              }
            : null,
        expenseDetails: r.expenseDetails,
      };
    });
  }
  events(c: DataContext) {
    return this.access.run(c, async (tx) => {
      await this.permission(tx, c, 'draft:read_own');
      const where = { companyId: c.companyId, authorId: c.userId };
      const [items, last] = await Promise.all([
        tx.syncEvent.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 100,
        }),
        tx.syncEvent.findFirst({
          where: { ...where, stage: 'SUCCESS' },
          orderBy: { createdAt: 'desc' },
        }),
      ]);
      return {
        items: items.map((r) => ({
          id: r.id,
          attemptId: r.attemptId,
          clientDraftId: r.clientDraftId,
          version: r.version,
          stage: r.stage,
          code: r.code,
          serverId: r.serverId,
          createdAt: r.createdAt.toISOString(),
        })),
        lastSuccessfulAt: last?.createdAt.toISOString() ?? null,
      };
    });
  }
}
