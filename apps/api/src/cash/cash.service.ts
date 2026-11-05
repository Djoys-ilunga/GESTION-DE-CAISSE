import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  createAgencySchema,
  createCashSchema,
  updateCashSchema,
  confirmReceiptSchema,
  receiptQuerySchema,
  type ConfirmedReceipt,
} from '@caissepro/shared';
import { Prisma, type CashReceipt } from '../generated/prisma/client';
import { AuthService, type Principal } from '../auth/auth.service';
import type { AuthTx } from '../auth/auth-store';
import { CentralAccess, DataError, type DataContext, type Tx } from '../data/central-access';
import { LedgerService, fingerprint } from '../data/ledger.service';

const receiptOmit = { evidenceBytes: true } as const;
type ReceiptRow = Omit<CashReceipt, 'evidenceBytes'>;
export function receiptView(row: ReceiptRow): ConfirmedReceipt {
  return {
    id: row.id,
    number: row.number,
    operationId: row.operationId,
    clientDraftId: row.clientDraftId,
    sourceDraftId: row.sourceDraftId,
    version: row.sourceVersion,
    cashRegisterId: row.cashRegisterId,
    agencyId: row.agencyId,
    currency: row.currency,
    amount: row.amount.toFixed(2),
    provenance: row.provenance,
    category: row.category,
    description: row.description,
    reference: row.reference,
    companyName: row.companyName,
    companyCode: row.companyCode,
    agencyName: row.agencyName,
    agencyCode: row.agencyCode,
    cashName: row.cashName,
    cashCode: row.cashCode,
    cashierName: row.cashierName,
    postedAt: row.postedAt.toISOString(),
    evidence:
      row.evidenceName && row.evidenceMime && row.evidenceSha && row.evidenceByteLength
        ? {
            fileName: row.evidenceName,
            mimeType: row.evidenceMime,
            sha256: row.evidenceSha,
            byteLength: row.evidenceByteLength,
          }
        : null,
  };
}
@Injectable()
export class CashService {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(CentralAccess) private readonly access: CentralAccess,
    @Inject(LedgerService) private readonly ledger: LedgerService,
  ) {}
  private configure<T>(p: Principal, action: (tx: AuthTx) => Promise<T>) {
    return this.auth.store.run(async (tx) => {
      await this.auth.require(tx, p, 'cash:configure');
      await tx.$executeRaw`SELECT set_config('caissepro.company_id',${p.companyId},true),set_config('caissepro.actor_id',${p.userId},true),set_config('caissepro.session_id',${p.sessionId},true)`;
      return action(tx);
    });
  }
  private audit(
    tx: Tx,
    p: { companyId: string; userId: string },
    action: string,
    targetType: string,
    targetId: string,
  ) {
    return tx.auditEvent.create({
      data: {
        id: randomUUID(),
        companyId: p.companyId,
        actorId: p.userId,
        action,
        targetType,
        targetId,
      },
    });
  }
  configuration(p: Principal) {
    return this.configure(p, async (tx) => {
      const [agencies, registers, members] = await Promise.all([
        tx.agency.findMany({
          where: { companyId: p.companyId, active: true },
          select: { id: true, code: true, name: true },
          orderBy: { code: 'asc' },
          take: 200,
        }),
        tx.cashRegister.findMany({
          where: { companyId: p.companyId },
          select: { id: true, agencyId: true, code: true, name: true, active: true, version: true },
          orderBy: { code: 'asc' },
          take: 500,
        }),
        tx.companyMember.findMany({
          where: { companyId: p.companyId, active: true, user: { active: true } },
          select: { user: { select: { id: true, displayName: true, email: true } } },
          take: 200,
          orderBy: { user: { displayName: 'asc' } },
        }),
      ]);
      return { agencies, registers, users: members.map((m) => m.user) };
    });
  }
  createAgency(p: Principal, value: unknown) {
    const input = createAgencySchema.parse(value);
    return this.configure(p, async (tx) => {
      const previous = await tx.agency.findFirst({
        where: { companyId: p.companyId, id: input.id },
      });
      if (previous) {
        if (previous.code !== input.code || previous.name !== input.name)
          throw new DataError('AGENCY_CONFLICT');
        return { id: previous.id };
      }
      const row = await tx.agency.create({ data: { ...input, companyId: p.companyId } });
      await this.audit(tx, p, 'AGENCY_CONFIGURED', 'AGENCY', row.id);
      return { id: row.id };
    });
  }
  create(p: Principal, value: unknown) {
    const input = createCashSchema.parse(value);
    return this.configure(p, async (tx) => {
      const configurationHash = fingerprint({
        ...input,
        authorizedUserIds: [...new Set(input.authorizedUserIds)].sort(),
      });
      const previous = await tx.cashRegister.findFirst({
        where: { companyId: p.companyId, id: input.id },
      });
      if (previous) {
        if (previous.configurationHash !== configurationHash)
          throw new DataError('CASH_CONFIGURATION_CONFLICT');
        return { id: previous.id };
      }
      if (
        !(await tx.agency.findFirst({
          where: { companyId: p.companyId, id: input.agencyId, active: true },
        }))
      )
        throw new DataError('AGENCY_NOT_FOUND');
      const ids = [...new Set(input.authorizedUserIds)];
      const members = await tx.companyMember.findMany({
        where: {
          companyId: p.companyId,
          userId: { in: ids },
          active: true,
          user: { active: true },
        },
      });
      if (members.length !== ids.length) throw new DataError('CASH_ACCESS_DENIED');
      const row = await tx.cashRegister.create({
        data: {
          id: input.id,
          companyId: p.companyId,
          agencyId: input.agencyId,
          code: input.code,
          name: input.name,
          configurationHash,
        },
      });
      // Les contreparties sont propres à chaque caisse et à chaque devise.
      await tx.treasuryAccount.createMany({
        data: (['CDF', 'USD'] as const).flatMap((currency) => [
          {
            id: randomUUID(),
            companyId: p.companyId,
            agencyId: input.agencyId,
            cashRegisterId: row.id,
            code: `CAISSE-${row.id}`,
            currency,
            kind: 'TREASURY' as const,
          },
          {
            id: randomUUID(),
            companyId: p.companyId,
            agencyId: input.agencyId,
            code: `RECETTES-${row.id}`,
            currency,
            kind: 'CLEARING' as const,
          },
        ]),
      });
      for (const member of members) {
        await tx.agencyGrant.upsert({
          where: {
            companyId_memberId_agencyId: {
              companyId: p.companyId,
              memberId: member.id,
              agencyId: input.agencyId,
            },
          },
          create: { companyId: p.companyId, memberId: member.id, agencyId: input.agencyId },
          update: {},
        });
        await tx.cashRegisterGrant.create({
          data: {
            companyId: p.companyId,
            memberId: member.id,
            agencyId: input.agencyId,
            cashRegisterId: row.id,
          },
        });
        await tx.companyMember.update({
          where: { id: member.id },
          data: { authorizationVersion: { increment: 1 } },
        });
        await tx.authSession.updateMany({
          where: { companyId: p.companyId, userId: member.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await this.auth.event(tx, 'ACCESS_CHANGED', {
          companyId: p.companyId,
          actorId: p.userId,
          subjectId: member.userId,
          sessionId: p.sessionId,
        });
      }
      await this.audit(tx, p, 'CASH_CONFIGURED', 'CASH', row.id);
      return { id: row.id };
    });
  }
  update(p: Principal, id: string, value: unknown) {
    const input = updateCashSchema.parse(value);
    return this.configure(p, async (tx) => {
      const result = await tx.cashRegister.updateMany({
        where: { companyId: p.companyId, id, version: input.expectedVersion },
        data: { name: input.name, active: input.active, version: { increment: 1 } },
      });
      if (result.count !== 1) throw new DataError('CASH_CONFIGURATION_CONFLICT');
      await this.audit(tx, p, 'CASH_CONFIGURED', 'CASH', id);
      return { id };
    });
  }
  private async allowed(tx: Tx, ctx: DataContext, permission: 'ledger:read' | 'receipt:read') {
    const grants = await tx.cashRegisterGrant.findMany({
      where: {
        companyId: ctx.companyId,
        member: { userId: ctx.userId, active: true },
        register: { agency: { active: true } },
      },
      include: { register: { include: { agency: true } } },
      take: 500,
    });
    const agencies = await tx.agencyGrant.findMany({
      where: { companyId: ctx.companyId, member: { userId: ctx.userId, active: true } },
    });
    const ids = new Set(agencies.map((a) => a.agencyId));
    const registers = grants.filter((g) => ids.has(g.agencyId)).map((g) => g.register);
    for (const register of registers)
      await this.access.requireCashRead(tx, ctx, register.id, permission);
    return registers;
  }
  list(ctx: DataContext, offlineUntil: string | null) {
    return this.access.run(ctx, async (tx) => {
      const registers = await this.allowed(tx, ctx, 'ledger:read');
      const ids = registers.map((r) => r.id);
      const sessions = await tx.cashSession.findMany({
        where: { companyId: ctx.companyId, cashRegisterId: { in: ids }, state: 'OPEN' },
        select: { id: true, cashRegisterId: true, openedAt: true },
      });
      const funds = ids.length
        ? await tx.$queryRaw<
            {
              cashRegisterId: string;
              currency: 'CDF' | 'USD';
              balance: Prisma.Decimal;
              reserved: Prisma.Decimal;
              available: Prisma.Decimal;
            }[]
          >`SELECT a."cashRegisterId",f.currency,f.balance,f.reserved,f.available FROM "AvailableFunds" f JOIN "TreasuryAccount" a ON a.id=f."accountId" AND a."companyId"=f."companyId" WHERE a."companyId"=${ctx.companyId}::uuid AND a."cashRegisterId" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) AND a.kind='TREASURY'`
        : [];
      return {
        items: registers
          .sort((a, b) => a.code.localeCompare(b.code))
          .map((r) => {
            const session = sessions.find((s) => s.cashRegisterId === r.id);
            return {
              id: r.id,
              code: r.code,
              name: r.name,
              active: r.active,
              version: r.version,
              agency: { id: r.agency.id, code: r.agency.code, name: r.agency.name },
              session: session
                ? { id: session.id, openedAt: session.openedAt.toISOString() }
                : null,
              funds: funds
                .filter((f) => f.cashRegisterId === r.id)
                .map((f) => ({
                  currency: f.currency,
                  balance: f.balance.toFixed(2),
                  reserved: f.reserved.toFixed(2),
                  available: f.available.toFixed(2),
                })),
            };
          }),
        synchronizedAt: new Date().toISOString(),
        expiresAt: offlineUntil,
      };
    });
  }
  openSession(ctx: DataContext, id: string) {
    return this.access.run(ctx, async (tx) => {
      await this.access.requireCash(tx, ctx, id, 'session:manage');
      await tx.$executeRaw`SELECT id FROM "CashRegister" WHERE "companyId"=${ctx.companyId}::uuid AND id=${id}::uuid FOR UPDATE`;
      const previous = await tx.cashSession.findFirst({
        where: { companyId: ctx.companyId, cashRegisterId: id, state: 'OPEN' },
      });
      if (previous) return { id: previous.id };
      const register = await tx.cashRegister.findFirstOrThrow({
        where: { companyId: ctx.companyId, id, active: true },
      });
      const session = await tx.cashSession.create({
        data: {
          id: randomUUID(),
          companyId: ctx.companyId,
          agencyId: register.agencyId,
          cashRegisterId: id,
          openedById: ctx.userId,
        },
      });
      return { id: session.id };
    });
  }
  drafts(ctx: DataContext, page = 1) {
    return this.access.run(ctx, async (tx) => {
      const registers = await this.allowed(tx, ctx, 'receipt:read');
      const where = {
        companyId: ctx.companyId,
        authorId: ctx.userId,
        kind: 'RECEIPT' as const,
        cashRegisterId: { in: registers.map((r) => r.id) },
      };
      const [rows, total] = await Promise.all([
        tx.importedDraft.findMany({
          where,
          omit: { evidenceBytes: true },
          include: { receipt: { select: { id: true, number: true } } },
          orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
          take: 25,
          skip: (page - 1) * 25,
        }),
        tx.importedDraft.count({ where }),
      ]);
      return {
        items: rows.map((r) => ({
          id: r.id,
          clientDraftId: r.clientDraftId,
          agencyId: r.agencyId,
          cashRegisterId: r.cashRegisterId!,
          version: r.version,
          currency: r.currency,
          amount: r.amount.toFixed(2),
          description: r.description,
          provenance: r.receiptProvenance,
          category: r.receiptCategory,
          reference: r.receiptReference,
          hasEvidence: r.evidenceSha !== null,
          receivedAt: r.receivedAt.toISOString(),
          receiptId: r.receipt?.id ?? null,
          receiptNumber: r.receipt?.number ?? null,
        })),
        total,
        page,
        pageSize: 25,
      };
    });
  }
  source(ctx: DataContext, id: string) {
    return this.access.run(ctx, async (tx) => {
      const r = await tx.importedDraft.findFirst({
        where: { companyId: ctx.companyId, authorId: ctx.userId, id, kind: 'RECEIPT' },
        include: { receipt: { select: { id: true } } },
      });
      if (!r || !r.cashRegisterId) throw new DataError('DRAFT_NOT_FOUND');
      await this.access.requireCashRead(tx, ctx, r.cashRegisterId, 'receipt:read');
      if (r.receipt) throw new DataError('DRAFT_ALREADY_CONFIRMED');
      return {
        clientDraftId: r.clientDraftId,
        agencyId: r.agencyId,
        cashRegisterId: r.cashRegisterId,
        version: r.version,
        currency: r.currency,
        amount: r.amount.toFixed(2),
        description: r.description,
        ...(r.receiptProvenance && r.receiptCategory
          ? {
              receiptDetails: {
                provenance: r.receiptProvenance,
                category: r.receiptCategory,
                reference: r.receiptReference ?? '',
                supportingDocument:
                  r.evidenceBytes && r.evidenceName && r.evidenceMime
                    ? {
                        fileName: r.evidenceName,
                        mimeType: r.evidenceMime,
                        dataBase64: Buffer.from(r.evidenceBytes).toString('base64'),
                      }
                    : null,
              },
            }
          : {}),
      };
    });
  }
  confirm(ctx: DataContext, id: string, value: unknown) {
    const input = confirmReceiptSchema.parse(value);
    return this.access.run(ctx, async (tx) => {
      const draft = await tx.importedDraft.findFirst({
        where: { companyId: ctx.companyId, authorId: ctx.userId, id, kind: 'RECEIPT' },
      });
      if (!draft || !draft.cashRegisterId) throw new DataError('DRAFT_NOT_FOUND');
      await this.access.requireCashRead(tx, ctx, draft.cashRegisterId, 'receipt:read');
      await tx.$executeRaw`SELECT id FROM "ImportedDraft" WHERE "companyId"=${ctx.companyId}::uuid AND id=${id}::uuid FOR UPDATE`;
      if (draft.version !== input.expectedVersion) throw new DataError('DRAFT_VERSION_CONFLICT');
      const previous = await tx.cashReceipt.findFirst({
        where: { companyId: ctx.companyId, sourceDraftId: id },
        omit: receiptOmit,
      });
      if (previous) return receiptView(previous);
      await this.access.requireCash(tx, ctx, draft.cashRegisterId, 'receipt:post');
      if (!draft.receiptProvenance || !draft.receiptCategory || draft.receiptReference === null)
        throw new DataError('RECEIPT_DETAILS_REQUIRED');
      await tx.$executeRaw`SELECT id FROM "CashRegister" WHERE "companyId"=${ctx.companyId}::uuid AND id=${draft.cashRegisterId}::uuid FOR UPDATE`;
      const register = await tx.cashRegister.findFirstOrThrow({
        where: { companyId: ctx.companyId, id: draft.cashRegisterId },
        include: { agency: { include: { company: true } } },
      });
      const session = await tx.cashSession.findFirst({
        where: { companyId: ctx.companyId, cashRegisterId: register.id, state: 'OPEN' },
      });
      if (!session) throw new DataError('CASH_SESSION_REQUIRED');
      const account = await tx.treasuryAccount.findFirst({
        where: {
          companyId: ctx.companyId,
          cashRegisterId: register.id,
          currency: draft.currency,
          kind: 'TREASURY',
          active: true,
        },
      });
      const counter =
        (await tx.treasuryAccount.findFirst({
          where: {
            companyId: ctx.companyId,
            agencyId: register.agencyId,
            kind: 'CLEARING',
            currency: draft.currency,
            active: true,
            code: `RECETTES-${register.id}`,
          },
        })) ??
        (await tx.treasuryAccount.findFirst({
          where: {
            companyId: ctx.companyId,
            agencyId: register.agencyId,
            kind: 'CLEARING',
            currency: draft.currency,
            active: true,
            code: { in: ['CONTREPARTIE', 'CLEAR'] },
          },
          orderBy: { id: 'asc' },
        }));
      if (!account || !counter) throw new DataError('ACCOUNT_NOT_FOUND');
      const posted = await this.ledger.receiptInTransaction(tx, ctx, {
        agencyId: register.agencyId,
        idempotencyKey: draft.id,
        accountId: account.id,
        counterAccountId: counter.id,
        cashSessionId: session.id,
        currency: draft.currency,
        amount: draft.amount.toFixed(2),
      });
      if (posted.replayed) throw new DataError('RECEIPT_INTEGRITY_CONFLICT');
      const operation = await tx.financialOperation.findUniqueOrThrow({
        where: { id: posted.operationId },
      });
      const year = operation.postedAt.getUTCFullYear();
      const sequence = await tx.receiptCounter.upsert({
        where: { companyId_year: { companyId: ctx.companyId, year } },
        create: { companyId: ctx.companyId, year, lastSequence: 1n },
        update: { lastSequence: { increment: 1n } },
      });
      const creator = await tx.user.findUniqueOrThrow({ where: { id: ctx.userId } });
      const row = await tx.cashReceipt.create({
        data: {
          id: randomUUID(),
          companyId: ctx.companyId,
          agencyId: register.agencyId,
          cashRegisterId: register.id,
          sourceDraftId: draft.id,
          sourceVersion: draft.version,
          clientDraftId: draft.clientDraftId,
          operationId: operation.id,
          createdById: ctx.userId,
          currency: draft.currency,
          amount: draft.amount,
          provenance: draft.receiptProvenance,
          category: draft.receiptCategory,
          reference: draft.receiptReference,
          description: draft.description,
          companyName: register.agency.company.name,
          companyCode: register.agency.company.code,
          agencyName: register.agency.name,
          agencyCode: register.agency.code,
          cashName: register.name,
          cashCode: register.code,
          cashierName: creator.displayName,
          postedAt: operation.postedAt,
          year,
          sequence: sequence.lastSequence,
          number: `REC-${register.agency.company.code}-${year}-${sequence.lastSequence.toString().padStart(6, '0')}`,
          evidenceName: draft.evidenceName,
          evidenceMime: draft.evidenceMime,
          evidenceSha: draft.evidenceSha,
          evidenceBytes: draft.evidenceBytes,
          evidenceByteLength: draft.evidenceBytes?.byteLength ?? null,
        },
        omit: receiptOmit,
      });
      return receiptView(row);
    });
  }
  history(ctx: DataContext, value: unknown) {
    const input = receiptQuerySchema.parse(value);
    return this.access.run(ctx, async (tx) => {
      const registers = await this.allowed(tx, ctx, 'receipt:read'),
        ids = registers.map((r) => r.id);
      if (input.cashRegisterId && !ids.includes(input.cashRegisterId))
        throw new DataError('CASH_ACCESS_DENIED');
      const where: Prisma.CashReceiptWhereInput = {
        companyId: ctx.companyId,
        cashRegisterId: input.cashRegisterId ?? { in: ids },
        currency: input.currency,
        category: input.category || undefined,
        ...(input.search
          ? {
              OR: ['number', 'reference', 'provenance', 'description'].map((field) => ({
                [field]: { contains: input.search, mode: 'insensitive' },
              })),
            }
          : {}),
        ...(input.from || input.to
          ? {
              postedAt: {
                ...(input.from ? { gte: new Date(input.from + 'T00:00:00+01:00') } : {}),
                ...(input.to
                  ? { lt: new Date(new Date(input.to + 'T00:00:00+01:00').getTime() + 86400000) }
                  : {}),
              },
            }
          : {}),
      };
      const [rows, total] = await Promise.all([
        tx.cashReceipt.findMany({
          where,
          omit: receiptOmit,
          orderBy: [{ postedAt: 'desc' }, { id: 'desc' }],
          skip: (input.page - 1) * 25,
          take: 25,
        }),
        tx.cashReceipt.count({ where }),
      ]);
      return {
        items: rows.map(receiptView),
        total,
        page: input.page,
        pageSize: 25,
        synchronizedAt: new Date().toISOString(),
      };
    });
  }
  receipt(ctx: DataContext, id: string) {
    return this.access.run(ctx, async (tx) => {
      const row = await tx.cashReceipt.findFirst({
        where: { companyId: ctx.companyId, id },
        omit: receiptOmit,
      });
      if (!row) throw new DataError('RECEIPT_NOT_FOUND');
      await this.access.requireCashRead(tx, ctx, row.cashRegisterId, 'receipt:read');
      return receiptView(row);
    });
  }
  evidence(ctx: DataContext, id: string) {
    return this.access.run(ctx, async (tx) => {
      const row = await tx.cashReceipt.findFirst({ where: { companyId: ctx.companyId, id } });
      if (!row || !row.evidenceBytes || !row.evidenceName || !row.evidenceMime)
        throw new DataError('EVIDENCE_NOT_FOUND');
      await this.access.requireCashRead(tx, ctx, row.cashRegisterId, 'receipt:read');
      return {
        fileName: row.evidenceName,
        mimeType: row.evidenceMime,
        dataBase64: Buffer.from(row.evidenceBytes).toString('base64'),
      };
    });
  }
}
