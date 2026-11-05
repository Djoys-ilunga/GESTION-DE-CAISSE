import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  expenseDetailsSchema,
  expensePolicyInputSchema,
  expensePolicySchema,
  expenseQuerySchema,
  submitExpenseSchema,
  decideExpenseSchema,
  payExpenseSchema,
  MAX_EVIDENCE_BYTES,
  type ExpenseView,
  type PaymentVoucher as VoucherView,
} from '@caissepro/shared';
import type { Prisma, Currency, PaymentVoucher } from '../generated/prisma/client';
import { CentralAccess, DataError, type DataContext, type Tx } from '../data/central-access';
import { LedgerService, fingerprint } from '../data/ledger.service';
import { decodeEvidence } from '../data/receipt-evidence';

const include = {
  account: { include: { register: true, agency: true } },
  requester: true,
  source: { select: { clientDraftId: true } },
  approval: { include: { approver: true } },
  reservation: true,
  evidence: {
    select: { id: true, fileName: true, mimeType: true, sha256: true, byteLength: true },
    orderBy: { ordinal: 'asc' },
  },
  voucher: { select: { id: true, number: true } },
} satisfies Prisma.ExpenseRequestInclude;
type Row = Prisma.ExpenseRequestGetPayload<{ include: typeof include }>;
function view(r: Row): ExpenseView {
  return {
    id: r.id,
    sourceDraftId: r.sourceDraftId,
    clientDraftId: r.source?.clientDraftId ?? null,
    agencyId: r.agencyId,
    cashRegisterId: r.account.cashRegisterId,
    cashName: r.account.register?.name ?? null,
    agencyName: r.account.agency.name,
    requestedById: r.requestedById,
    requesterName: r.requester.displayName,
    currency: r.currency,
    amount: r.amount.toFixed(2),
    description: r.description,
    beneficiary: r.beneficiary,
    reference: r.reference,
    state: r.state,
    version: r.version,
    createdAt: r.createdAt.toISOString(),
    approval: r.approval
      ? {
          approverId: r.approval.approverId,
          approverName: r.approval.approver.displayName,
          decision: r.approval.decision,
          reason: r.approval.reason,
          createdAt: r.approval.createdAt.toISOString(),
        }
      : null,
    reservation: r.reservation?.state ?? null,
    evidence: r.evidence,
    voucher: r.voucher,
  };
}
function voucherView(r: PaymentVoucher): VoucherView {
  return {
    id: r.id,
    expenseRequestId: r.expenseRequestId,
    operationId: r.operationId,
    number: r.number,
    currency: r.currency,
    amount: r.amount.toFixed(2),
    beneficiary: r.beneficiary,
    description: r.description,
    reference: r.reference,
    companyName: r.companyName,
    companyCode: r.companyCode,
    agencyName: r.agencyName,
    cashName: r.cashName,
    requesterName: r.requesterName,
    approverName: r.approverName,
    cashierName: r.cashierName,
    approvedAt: r.approvedAt.toISOString(),
    postedAt: r.postedAt.toISOString(),
  };
}
@Injectable()
export class ExpensesService {
  constructor(
    @Inject(CentralAccess) private readonly access: CentralAccess,
    @Inject(LedgerService) private readonly ledger: LedgerService,
  ) {}
  private audit(tx: Tx, ctx: DataContext, action: string, targetType: string, targetId: string) {
    return tx.auditEvent.create({
      data: {
        id: randomUUID(),
        companyId: ctx.companyId,
        actorId: ctx.userId,
        action,
        targetType,
        targetId,
      },
    });
  }
  private async row(tx: Tx, ctx: DataContext, id: string, permission = 'ledger:read') {
    const r = await tx.expenseRequest.findFirst({
      where: { companyId: ctx.companyId, id },
      include,
    });
    if (!r) throw new DataError('EXPENSE_NOT_FOUND');
    await this.access.require(tx, ctx, r.agencyId, permission);
    if (r.account.cashRegisterId) {
      if (permission === 'ledger:read')
        await this.access.requireCashRead(tx, ctx, r.account.cashRegisterId, 'ledger:read');
      else await this.access.requireCash(tx, ctx, r.account.cashRegisterId, permission);
    }
    return r;
  }
  private async limit(
    tx: Tx,
    ctx: DataContext,
    currency: Currency,
    action: string,
    amount: Prisma.Decimal,
  ) {
    await tx.$executeRaw`SELECT caissepro_assert_expense_limit(${ctx.companyId}::uuid,${ctx.userId}::uuid,${currency}::"Currency",${action},${amount}::numeric)`;
  }
  policies(ctx: DataContext) {
    return this.access.run(ctx, async (tx) => {
      await tx.$executeRaw`SELECT caissepro_assert_company_permission(${ctx.companyId}::uuid,${ctx.userId}::uuid,'cash:configure')`;
      const rows = await tx.expensePolicy.findMany({
        where: { companyId: ctx.companyId },
        orderBy: { currency: 'asc' },
      });
      return {
        items: rows.map((r) =>
          expensePolicySchema.parse({
            currency: r.currency,
            version: r.version,
            requireEvidence: r.requireEvidence,
            limits: r.limits,
            configuredAt: r.configuredAt.toISOString(),
          }),
        ),
      };
    });
  }
  configure(ctx: DataContext, currency: Currency, value: unknown) {
    const input = expensePolicyInputSchema.parse(value);
    return this.access.run(ctx, async (tx) => {
      await tx.$executeRaw`SELECT caissepro_assert_company_permission(${ctx.companyId}::uuid,${ctx.userId}::uuid,'cash:configure')`;
      const limits = [...input.limits].sort((a, b) =>
        `${a.role}:${a.action}`.localeCompare(`${b.role}:${b.action}`),
      );
      const payloadHash = fingerprint({ limits, requireEvidence: input.requireEvidence });
      const previous = await tx.expensePolicy.findUnique({
        where: { companyId_currency: { companyId: ctx.companyId, currency } },
      });
      if (previous?.payloadHash === payloadHash)
        return expensePolicySchema.parse({
          currency: previous.currency,
          version: previous.version,
          requireEvidence: previous.requireEvidence,
          limits: previous.limits,
          configuredAt: previous.configuredAt.toISOString(),
        });
      if ((previous?.version ?? null) !== input.expectedVersion)
        throw new DataError('EXPENSE_POLICY_CONFLICT');
      const data = {
        version: (previous?.version ?? 0) + 1,
        requireEvidence: input.requireEvidence,
        limits,
        payloadHash,
        configuredById: ctx.userId,
        configuredAt: new Date(),
      };
      const r = previous
        ? await tx.expensePolicy.update({
            where: { companyId_currency: { companyId: ctx.companyId, currency } },
            data,
          })
        : await tx.expensePolicy.create({ data: { companyId: ctx.companyId, currency, ...data } });
      await this.audit(tx, ctx, 'EXPENSE_POLICY_CONFIGURED', 'COMPANY', ctx.companyId);
      return expensePolicySchema.parse({
        currency: r.currency,
        version: r.version,
        requireEvidence: r.requireEvidence,
        limits: r.limits,
        configuredAt: r.configuredAt.toISOString(),
      });
    });
  }
  drafts(ctx: DataContext, page: number) {
    return this.access.run(ctx, async (tx) => {
      const where = {
        companyId: ctx.companyId,
        authorId: ctx.userId,
        kind: 'EXPENSE_REQUEST' as const,
      };
      const [rows, total] = await Promise.all([
        tx.importedDraft.findMany({
          where,
          include: { expense: { select: { id: true } } },
          orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * 25,
          take: 25,
        }),
        tx.importedDraft.count({ where }),
      ]);
      return {
        items: rows.map((r) => {
          const details = r.expenseDetails ? expenseDetailsSchema.parse(r.expenseDetails) : null;
          return {
            id: r.id,
            clientDraftId: r.clientDraftId,
            agencyId: r.agencyId,
            cashRegisterId: r.cashRegisterId,
            version: r.version,
            currency: r.currency,
            amount: r.amount.toFixed(2),
            description: r.description,
            beneficiary: details?.beneficiary ?? null,
            reference: details?.reference ?? null,
            documentCount: details?.documents.length ?? 0,
            receivedAt: r.receivedAt.toISOString(),
            expenseRequestId: r.expense?.id ?? null,
          };
        }),
        total,
        page,
        pageSize: 25,
      };
    });
  }
  source(ctx: DataContext, id: string) {
    return this.access.run(ctx, async (tx) => {
      const r = await tx.importedDraft.findFirst({
        where: { companyId: ctx.companyId, authorId: ctx.userId, id, kind: 'EXPENSE_REQUEST' },
        include: { expense: { select: { id: true } } },
      });
      if (!r) throw new DataError('DRAFT_NOT_FOUND');
      await this.access.require(tx, ctx, r.agencyId, 'draft:read_own');
      if (r.cashRegisterId)
        await this.access.requireCashRead(tx, ctx, r.cashRegisterId, 'ledger:read');
      if (r.expense) throw new DataError('DRAFT_ALREADY_SUBMITTED');
      return {
        serverId: r.id,
        originalCreatedAt: (r.clientCreatedAt ?? r.receivedAt).toISOString(),
        updatedAt: (r.clientUpdatedAt ?? r.receivedAt).toISOString(),
        clientDraftId: r.clientDraftId,
        agencyId: r.agencyId,
        cashRegisterId: r.cashRegisterId,
        version: r.version,
        currency: r.currency,
        amount: r.amount.toFixed(2),
        description: r.description,
        expenseDetails: r.expenseDetails ? expenseDetailsSchema.parse(r.expenseDetails) : null,
      };
    });
  }
  submit(ctx: DataContext, id: string, value: unknown) {
    const input = submitExpenseSchema.parse(value);
    return this.access.run(ctx, async (tx) => {
      const draft = await tx.importedDraft.findFirst({
        where: { companyId: ctx.companyId, authorId: ctx.userId, id, kind: 'EXPENSE_REQUEST' },
      });
      if (!draft) throw new DataError('DRAFT_NOT_FOUND');
      await this.access.require(tx, ctx, draft.agencyId, 'expense:request');
      if (!draft.cashRegisterId) throw new DataError('EXPENSE_CASH_REQUIRED');
      await this.access.requireCash(tx, ctx, draft.cashRegisterId, 'expense:request');
      await tx.$executeRaw`SELECT id FROM "ImportedDraft" WHERE "companyId"=${ctx.companyId}::uuid AND id=${id}::uuid FOR UPDATE`;
      if (draft.version !== input.expectedVersion) throw new DataError('DRAFT_VERSION_CONFLICT');
      const previous = await tx.expenseRequest.findFirst({
        where: { companyId: ctx.companyId, sourceDraftId: id },
        include,
      });
      if (previous) return view(previous);
      const details = expenseDetailsSchema.parse(draft.expenseDetails);
      await this.limit(tx, ctx, draft.currency, 'REQUEST', draft.amount);
      const policy = await tx.expensePolicy.findUniqueOrThrow({
        where: { companyId_currency: { companyId: ctx.companyId, currency: draft.currency } },
      });
      if (policy.requireEvidence && !details.documents.length)
        throw new DataError('EXPENSE_EVIDENCE_REQUIRED');
      const docs = details.documents.map(decodeEvidence);
      if (docs.reduce((n, d) => n + (d.evidenceBytes?.length ?? 0), 0) > MAX_EVIDENCE_BYTES)
        throw new DataError('EVIDENCE_INVALID');
      const account = await tx.treasuryAccount.findFirst({
        where: {
          companyId: ctx.companyId,
          agencyId: draft.agencyId,
          cashRegisterId: draft.cashRegisterId,
          currency: draft.currency,
          kind: 'TREASURY',
          active: true,
        },
      });
      if (!account) throw new DataError('ACCOUNT_NOT_FOUND');
      const expense = await tx.expenseRequest.create({
        data: {
          id: randomUUID(),
          companyId: ctx.companyId,
          agencyId: draft.agencyId,
          accountId: account.id,
          requestedById: ctx.userId,
          currency: draft.currency,
          amount: draft.amount,
          description: draft.description,
          beneficiary: details.beneficiary,
          reference: details.reference,
          sourceDraftId: id,
          sourceVersion: draft.version,
        },
      });
      for (const [i, d] of docs.entries())
        await tx.expenseEvidence.create({
          data: {
            id: randomUUID(),
            companyId: ctx.companyId,
            expenseRequestId: expense.id,
            ordinal: i + 1,
            fileName: d.evidenceName!,
            mimeType: d.evidenceMime!,
            sha256: d.evidenceSha!,
            bytes: d.evidenceBytes!,
            byteLength: d.evidenceBytes!.length,
          },
        });
      await this.audit(tx, ctx, 'EXPENSE_REQUESTED', 'EXPENSE', expense.id);
      return view(await this.row(tx, ctx, expense.id));
    });
  }
  list(ctx: DataContext, value: unknown) {
    const q = expenseQuerySchema.parse(value);
    return this.access.run(ctx, async (tx) => {
      const member = await tx.companyMember.findFirst({
        where: { companyId: ctx.companyId, userId: ctx.userId, active: true },
        include: { agencies: true, cashGrants: true },
      });
      const allowed = member?.cashGrants.map((g) => g.cashRegisterId) ?? [];
      if (q.cashRegisterId && !allowed.includes(q.cashRegisterId))
        throw new DataError('CASH_ACCESS_DENIED');
      const where: Prisma.ExpenseRequestWhereInput = {
        companyId: ctx.companyId,
        state: q.state,
        currency: q.currency,
        account: {
          agencyId: { in: member?.agencies.map((a) => a.agencyId) ?? [] },
          cashRegisterId: q.cashRegisterId ?? { in: allowed },
        },
      };
      const [rows, total] = await Promise.all([
        tx.expenseRequest.findMany({
          where,
          include,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (q.page - 1) * 25,
          take: 25,
        }),
        tx.expenseRequest.count({ where }),
      ]);
      for (const r of rows)
        await this.access.requireCashRead(tx, ctx, r.account.cashRegisterId!, 'ledger:read');
      return {
        items: rows.map(view),
        total,
        page: q.page,
        pageSize: 25,
        synchronizedAt: new Date().toISOString(),
      };
    });
  }
  detail(ctx: DataContext, id: string) {
    return this.access.run(ctx, async (tx) => view(await this.row(tx, ctx, id)));
  }
  decide(ctx: DataContext, id: string, value: unknown) {
    const input = decideExpenseSchema.parse(value);
    return this.access.run(ctx, async (tx) => {
      const ex = await this.row(tx, ctx, id, 'expense:approve');
      if (!ex.sourceDraftId) throw new DataError('EXPENSE_LEGACY_READ_ONLY');
      if (ex.requestedById === ctx.userId) throw new DataError('SELF_APPROVAL_FORBIDDEN');
      if (ex.approval) {
        if (
          ex.approval.approverId !== ctx.userId ||
          ex.approval.decision !== input.decision ||
          ex.approval.reason !== input.reason
        )
          throw new DataError('EXPENSE_STATE_CONFLICT');
        return view(ex);
      }
      if (ex.version !== input.expectedVersion || ex.state !== 'PENDING')
        throw new DataError('EXPENSE_VERSION_CONFLICT');
      if (input.decision === 'APPROVE') {
        await this.limit(tx, ctx, ex.currency, 'APPROVE', ex.amount);
        const policy = await tx.expensePolicy.findUniqueOrThrow({
          where: { companyId_currency: { companyId: ctx.companyId, currency: ex.currency } },
        });
        if (policy.requireEvidence && !ex.evidence.length)
          throw new DataError('EXPENSE_EVIDENCE_REQUIRED');
      }
      await this.ledger.decideExpenseInTransaction(tx, ctx, id, input.decision, input.reason);
      return view(await this.row(tx, ctx, id));
    });
  }
  pay(ctx: DataContext, id: string, value: unknown) {
    const input = payExpenseSchema.parse(value);
    return this.access.run(ctx, async (tx) => {
      const ex = await this.row(tx, ctx, id, 'expense:pay');
      if (!ex.sourceDraftId || !ex.account.cashRegisterId)
        throw new DataError('EXPENSE_LEGACY_READ_ONLY');
      if (ex.voucher) {
        const existing = await tx.paymentVoucher.findFirstOrThrow({
          where: { companyId: ctx.companyId, id: ex.voucher.id },
        });
        return voucherView(existing);
      }
      if (
        ex.version !== input.expectedVersion ||
        ex.state !== 'APPROVED' ||
        ex.approval?.decision !== 'APPROVE'
      )
        throw new DataError('EXPENSE_NOT_APPROVED');
      await this.limit(tx, ctx, ex.currency, 'PAY', ex.amount);
      const policy = await tx.expensePolicy.findUniqueOrThrow({
        where: { companyId_currency: { companyId: ctx.companyId, currency: ex.currency } },
      });
      if (policy.requireEvidence && !ex.evidence.length)
        throw new DataError('EXPENSE_EVIDENCE_REQUIRED');
      const cashId = ex.account.cashRegisterId;
      await tx.$executeRaw`SELECT id FROM "CashRegister" WHERE "companyId"=${ctx.companyId}::uuid AND id=${cashId}::uuid FOR UPDATE`;
      const session = await tx.cashSession.findFirst({
        where: { companyId: ctx.companyId, cashRegisterId: cashId, state: 'OPEN' },
      });
      if (!session) throw new DataError('CASH_SESSION_REQUIRED');
      const counter = await tx.treasuryAccount.findFirst({
        where: {
          companyId: ctx.companyId,
          agencyId: ex.agencyId,
          kind: 'CLEARING',
          currency: ex.currency,
          active: true,
          code: { in: [`RECETTES-${cashId}`, 'CONTREPARTIE', 'CLEAR'] },
        },
        orderBy: { id: 'asc' },
      });
      if (!counter) throw new DataError('ACCOUNT_NOT_FOUND');
      const posted = await this.ledger.payExpenseInTransaction(tx, ctx, {
        agencyId: ex.agencyId,
        idempotencyKey: ex.id,
        expenseRequestId: id,
        counterAccountId: counter.id,
        cashSessionId: session.id,
      });
      const op = await tx.financialOperation.findFirstOrThrow({
        where: { companyId: ctx.companyId, id: posted.operationId },
      });
      const company = await tx.company.findUniqueOrThrow({ where: { id: ctx.companyId } }),
        cashier = await tx.user.findUniqueOrThrow({ where: { id: ctx.userId } });
      const year = Number(
        new Intl.DateTimeFormat('en', { timeZone: 'Africa/Kinshasa', year: 'numeric' }).format(
          op.postedAt,
        ),
      );
      const count = await tx.voucherCounter.upsert({
        where: { companyId_year: { companyId: ctx.companyId, year } },
        create: { companyId: ctx.companyId, year, lastSequence: 1 },
        update: { lastSequence: { increment: 1 } },
      });
      const voucher = await tx.paymentVoucher.create({
        data: {
          id: randomUUID(),
          companyId: ctx.companyId,
          expenseRequestId: id,
          operationId: op.id,
          createdById: ctx.userId,
          currency: ex.currency,
          amount: ex.amount,
          beneficiary: ex.beneficiary!,
          description: ex.description,
          reference: ex.reference!,
          companyName: company.name,
          companyCode: company.code,
          agencyName: ex.account.agency.name,
          cashName: ex.account.register!.name,
          requesterName: ex.requester.displayName,
          approverName: ex.approval.approver.displayName,
          cashierName: cashier.displayName,
          approvedAt: ex.approval.createdAt,
          postedAt: op.postedAt,
          year,
          sequence: count.lastSequence,
          number: `BON-${company.code}-${year}-${count.lastSequence.toString().padStart(6, '0')}`,
        },
      });
      await this.audit(tx, ctx, 'EXPENSE_PAYMENT_CONFIRMED', 'EXPENSE', id);
      return voucherView(voucher);
    });
  }
  voucher(ctx: DataContext, id: string) {
    return this.access.run(ctx, async (tx) => {
      const v = await tx.paymentVoucher.findFirst({ where: { companyId: ctx.companyId, id } });
      if (!v) throw new DataError('VOUCHER_NOT_FOUND');
      await this.row(tx, ctx, v.expenseRequestId);
      return voucherView(v);
    });
  }
  evidence(ctx: DataContext, id: string, evidenceId: string) {
    return this.access.run(ctx, async (tx) => {
      await this.row(tx, ctx, id);
      const d = await tx.expenseEvidence.findFirst({
        where: { companyId: ctx.companyId, expenseRequestId: id, id: evidenceId },
      });
      if (!d) throw new DataError('EVIDENCE_NOT_FOUND');
      return {
        fileName: d.fileName,
        mimeType: d.mimeType,
        dataBase64: Buffer.from(d.bytes).toString('base64'),
      };
    });
  }
}
