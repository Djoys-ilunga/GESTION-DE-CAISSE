import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  reportQuerySchema,
  reportSnapshotSchema,
  closeCashSchema,
  closureViewSchema,
  type ReportSnapshot,
  type ReportQuery,
} from '@caissepro/shared';
import { Prisma } from '../generated/prisma/client';
import { CentralAccess, DataError, type DataContext, type Tx } from '../data/central-access';
const D = Prisma.Decimal.clone({ precision: 60 });
const day = (date: Date) => new Date(date.getTime() + 3600000).toISOString().slice(0, 10);
const midnight = (s: string) => new Date(s + 'T00:00:00+01:00');
const advance = (s: string, n: number) =>
  new Date(Date.parse(s + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
export function reportRange(raw: ReportQuery, now = new Date()) {
  const q = reportQuerySchema.parse(raw),
    anchor = q.date ?? day(now);
  let from = anchor,
    to = anchor;
  if (q.period === 'week') {
    const weekday = new Date(anchor).getUTCDay();
    from = advance(anchor, -((weekday + 6) % 7));
    to = advance(from, 6);
  }
  if (q.period === 'month') {
    from = anchor.slice(0, 7) + '-01';
    to = advance(
      new Date(Date.UTC(Number(anchor.slice(0, 4)), Number(anchor.slice(5, 7)), 1))
        .toISOString()
        .slice(0, 10),
      -1,
    );
  }
  if (q.period === 'year') {
    from = anchor.slice(0, 4) + '-01-01';
    to = anchor.slice(0, 4) + '-12-31';
  }
  if (q.period === 'custom') {
    if (!q.from || !q.to) throw new DataError('REPORT_DATES_INVALID');
    from = q.from;
    to = q.to;
  }
  if (from > day(now) || to < from || Date.parse(to) - Date.parse(from) > 365 * 86400000)
    throw new DataError('REPORT_DATES_INVALID');
  return { q, from, to, start: midnight(from), end: midnight(advance(to, 1)) };
}
@Injectable()
export class ReportsService {
  constructor(@Inject(CentralAccess) private readonly access: CentralAccess) {}
  private async scope(tx: Tx, ctx: DataContext) {
    await tx.$executeRaw`SELECT caissepro_assert_company_permission(${ctx.companyId}::uuid,${ctx.userId}::uuid,'ledger:read')`;
    const grants = await tx.cashRegisterGrant.findMany({
      where: { companyId: ctx.companyId, member: { userId: ctx.userId, active: true } },
    });
    const ids = [...new Set(grants.map((g) => g.cashRegisterId))];
    for (const id of ids) await this.access.requireCashRead(tx, ctx, id, 'ledger:read');
    return ids;
  }
  async snapshot(ctx: DataContext, raw: unknown): Promise<ReportSnapshot> {
    const { q, from, to, start, end } = reportRange(reportQuerySchema.parse(raw));
    return this.access.run(ctx, async (tx) => {
      const authorized = await this.scope(tx, ctx);
      if (q.cashRegisterId && !authorized.includes(q.cashRegisterId))
        throw new DataError('ACCESS_DENIED');
      if (
        q.agencyId &&
        !(await tx.agencyGrant.findFirst({
          where: {
            companyId: ctx.companyId,
            agencyId: q.agencyId,
            member: { userId: ctx.userId, active: true },
          },
        }))
      )
        throw new DataError('ACCESS_DENIED');
      const accounts = await tx.treasuryAccount.findMany({
        where: {
          companyId: ctx.companyId,
          kind: 'TREASURY',
          cashRegisterId: { in: q.cashRegisterId ? [q.cashRegisterId] : authorized },
          ...(q.agencyId ? { agencyId: q.agencyId } : {}),
        },
        include: { register: true, agency: true },
      });
      const accountIds = accounts.map((a) => a.id),
        cashIds = [...new Set(accounts.map((a) => a.cashRegisterId!))];
      const company = await tx.company.findUniqueOrThrow({
        where: { id: ctx.companyId },
        select: { name: true, code: true, address: true, phone: true, email: true, taxId: true },
      });
      const where = {
        companyId: ctx.companyId,
        accountId: { in: accountIds },
        operation: { postedAt: { gte: start, lt: end } },
      };
      if ((await tx.ledgerEntry.count({ where })) > 10000) throw new DataError('REPORT_TOO_LARGE');
      const entries = await tx.ledgerEntry.findMany({
        where,
        include: {
          operation: {
            include: {
              creator: true,
              original: { select: { kind: true } },
              cashReceipt: { select: { category: true, number: true } },
              expense: { select: { description: true, category: true } },
              paymentVoucher: { select: { number: true } },
            },
          },
        },
        orderBy: [{ operation: { postedAt: 'asc' } }, { id: 'asc' }],
      });
      const opening = await tx.ledgerEntry.groupBy({
        by: ['accountId', 'side'],
        where: {
          companyId: ctx.companyId,
          accountId: { in: accountIds },
          operation: { postedAt: { lt: start } },
        },
        _sum: { amount: true },
      });
      const today = day(new Date());
      const todayEntries = await tx.ledgerEntry.findMany({
        where: {
          companyId: ctx.companyId,
          accountId: { in: accountIds },
          operation: { postedAt: { gte: midnight(today), lt: midnight(advance(today, 1)) } },
        },
        include: { operation: { include: { original: { select: { kind: true } } } } },
        take: 10001,
      });
      if (todayEntries.length > 10000) throw new DataError('REPORT_TOO_LARGE');
      const cash = [];
      for (const a of accounts) {
        const [funds] = await tx.$queryRaw<
          { balance: Prisma.Decimal; reserved: Prisma.Decimal; available: Prisma.Decimal }[]
        >`SELECT balance,reserved,available FROM "AvailableFunds" WHERE "companyId"=${ctx.companyId}::uuid AND "accountId"=${a.id}::uuid`;
        cash.push({
          id: a.cashRegisterId!,
          name: a.register!.name,
          agencyId: a.agencyId,
          agencyName: a.agency.name,
          currency: a.currency,
          balance: funds!.balance.toFixed(2),
          reserved: funds!.reserved.toFixed(2),
          available: funds!.available.toFixed(2),
        });
      }
      const accountMap = new Map(accounts.map((a) => [a.id, a]));
      const rows = entries
        .map((e) => {
          const a = accountMap.get(e.accountId)!,
            o = e.operation;
          return {
            id: e.id,
            operationId: o.id,
            postedAt: o.postedAt.toISOString(),
            kind: o.kind,
            cashRegisterId: a.cashRegisterId!,
            cashName: a.register!.name,
            agencyId: a.agencyId,
            agencyName: a.agency.name,
            userId: o.createdById,
            userName: o.creator.displayName,
            currency: e.currency,
            side: e.side,
            amount: e.amount.toFixed(2),
            category:
              o.cashReceipt?.category ??
              (o.kind === 'DISBURSEMENT'
                ? (o.expense?.category ?? 'Dépenses non catégorisées')
                : o.kind === 'RECEIPT'
                  ? 'Encaissements non catégorisés'
                  : 'Mouvement interne / correction'),
            reference: o.cashReceipt?.number ?? o.paymentVoucher?.number ?? o.id,
          };
        })
        .filter(
          (r) =>
            (!q.kind || r.kind === q.kind) &&
            (!q.userId || r.userId === q.userId) &&
            (!q.category || r.category === q.category),
        );
      const selected = new Set(rows.map((r) => r.id));
      const signed = (e: { side: string; amount: Prisma.Decimal }) =>
        new D(e.amount.toString()).mul(e.side === 'DEBIT' ? 1 : -1);
      const flow = (es: typeof todayEntries, kind: 'RECEIPT' | 'DISBURSEMENT') =>
        es.reduce((sum, e) => {
          const k = e.operation.kind === 'REVERSAL' ? e.operation.original?.kind : e.operation.kind;
          return k === kind ? sum.plus(signed(e).mul(kind === 'RECEIPT' ? 1 : -1)) : sum;
        }, new D(0));
      const daily = [];
      const totals = [];
      for (const currency of ['CDF', 'USD'] as const) {
        const ids = new Set(accounts.filter((a) => a.currency === currency).map((a) => a.id));
        const first = opening
          .filter((o) => ids.has(o.accountId))
          .reduce(
            (s, o) =>
              s.plus(new D(o._sum.amount?.toString() ?? 0).mul(o.side === 'DEBIT' ? 1 : -1)),
            new D(0),
          );
        let balance = first;
        for (let date = from; date <= to && date <= today; date = advance(date, 1)) {
          balance = balance.plus(
            entries
              .filter((e) => e.currency === currency && day(e.operation.postedAt) === date)
              .reduce((s, e) => s.plus(signed(e)), new D(0)),
          );
          daily.push({ date, currency, balance: balance.toFixed(2) });
        }
        const current = cash.filter((c) => c.currency === currency);
        const sum = (field: 'balance' | 'reserved' | 'available') =>
          current.reduce((s, c) => s.plus(c[field]), new D(0)).toFixed(2);
        const period = entries.filter((e) => e.currency === currency && selected.has(e.id));
        totals.push({
          currency,
          balance: sum('balance'),
          reserved: sum('reserved'),
          available: sum('available'),
          opening: first.toFixed(2),
          closing: balance.toFixed(2),
          receipts: flow(period, 'RECEIPT').toFixed(2),
          disbursements: flow(period, 'DISBURSEMENT').toFixed(2),
          todayReceipts: flow(
            todayEntries.filter((e) => e.currency === currency),
            'RECEIPT',
          ).toFixed(2),
          todayDisbursements: flow(
            todayEntries.filter((e) => e.currency === currency),
            'DISBURSEMENT',
          ).toFixed(2),
        });
      }
      const groups = new Map<
        string,
        {
          dimension: 'category' | 'agency' | 'user';
          name: string;
          currency: 'USD' | 'CDF';
          incoming: Prisma.Decimal;
          outgoing: Prisma.Decimal;
        }
      >();
      for (const r of rows)
        for (const dimension of ['category', 'agency', 'user'] as const) {
          const name =
            dimension === 'category'
              ? r.category
              : dimension === 'agency'
                ? r.agencyName
                : r.userName;
          const identity =
            dimension === 'category' ? name : dimension === 'agency' ? r.agencyId : r.userId;
          const key = dimension + identity + r.currency;
          const g = groups.get(key) ?? {
            dimension,
            name,
            currency: r.currency,
            incoming: new D(0),
            outgoing: new D(0),
          };
          g[r.side === 'DEBIT' ? 'incoming' : 'outgoing'] = g[
            r.side === 'DEBIT' ? 'incoming' : 'outgoing'
          ].plus(r.amount);
          groups.set(key, g);
        }
      const pendingRaw = await tx.expenseRequest.groupBy({
        by: ['currency'],
        where: {
          companyId: ctx.companyId,
          accountId: { in: accountIds },
          state: 'PENDING',
          ...(q.userId ? { requestedById: q.userId } : {}),
        },
        _sum: { amount: true },
        _count: true,
      });
      const decisionWhere = {
        companyId: ctx.companyId,
        accountId: { in: accountIds },
        approval: { createdAt: { gte: start, lt: end } },
        ...(q.userId ? { requestedById: q.userId } : {}),
      };
      if ((await tx.expenseRequest.count({ where: decisionWhere })) > 10000)
        throw new DataError('REPORT_TOO_LARGE');
      const decisions = await tx.expenseRequest.findMany({
        where: decisionWhere,
        include: { requester: true, approval: { include: { approver: true } } },
        orderBy: { createdAt: 'desc' },
      });
      const closureWhere = {
        companyId: ctx.companyId,
        cashRegisterId: { in: cashIds },
        closedAt: { gte: start, lt: end },
      };
      if ((await tx.cashClosureReport.count({ where: closureWhere })) > 1000)
        throw new DataError('REPORT_TOO_LARGE');
      const closures = await tx.cashClosureReport.findMany({
        where: closureWhere,
        orderBy: { closedAt: 'desc' },
      });
      const closed = await tx.cashSession.count({ where: { ...closureWhere, state: 'CLOSED' } });
      const users = [
        ...new Map(
          entries.map((e) => [
            e.operation.createdById,
            { id: e.operation.createdById, name: e.operation.creator.displayName },
          ]),
        ).values(),
      ];
      const result = reportSnapshotSchema.parse({
        generatedAt: new Date().toISOString(),
        company,
        timezone: 'Africa/Kinshasa',
        from,
        to,
        query: { ...q, date: q.date ?? today },
        totals,
        cash,
        daily,
        rows,
        groups: [...groups.values()].map((g) => ({
          ...g,
          incoming: g.incoming.toFixed(2),
          outgoing: g.outgoing.toFixed(2),
        })),
        pending: ['CDF', 'USD'].map((currency) => {
          const p = pendingRaw.find((p) => p.currency === currency);
          return { currency, count: p?._count ?? 0, amount: p?._sum.amount?.toFixed(2) ?? '0.00' };
        }),
        decisions: decisions.map((d) => ({
          id: d.id,
          state: d.approval!.decision,
          requestState: d.state,
          reason: d.approval?.reason ?? null,
          currency: d.currency,
          amount: d.amount.toFixed(2),
          description: d.description,
          requester: d.requester.displayName,
          approver: d.approval?.approver.displayName ?? null,
          decidedAt: d.approval?.createdAt.toISOString() ?? null,
        })),
        closures: closures.map((c) => closureViewSchema.parse(c.snapshot)),
        discrepancies: (['CDF', 'USD'] as const).map((currency) => {
          const values = closures.map(
            (c) => closureViewSchema.parse(c.snapshot).counts.find((v) => v.currency === currency)!,
          );
          return {
            currency,
            measured: values.length,
            count: values.filter((v) => !new D(v.difference).isZero()).length,
            net: values.length
              ? values.reduce((s, v) => s.plus(v.difference), new D(0)).toFixed(2)
              : null,
          };
        }),
        unmeasuredClosures: closed - closures.length,
        users,
      });
      if (Buffer.byteLength(JSON.stringify(result)) > 10_000_000)
        throw new DataError('REPORT_TOO_LARGE');
      return result;
    });
  }
  async close(ctx: DataContext, raw: unknown) {
    const input = closeCashSchema.parse(raw);
    return this.access.run(ctx, async (tx) => {
      await this.access.requireCash(tx, ctx, input.cashRegisterId, 'session:manage');
      const accounts = await tx.treasuryAccount.findMany({
        where: { companyId: ctx.companyId, cashRegisterId: input.cashRegisterId, kind: 'TREASURY' },
      });
      await this.access.lockAccounts(
        tx,
        ctx,
        accounts.map((a) => a.id),
      );
      await tx.$executeRaw`SELECT id FROM "CashSession" WHERE "companyId"=${ctx.companyId}::uuid AND id=${input.sessionId}::uuid FOR UPDATE`;
      const prior = await tx.cashClosureReport.findFirst({
        where: { companyId: ctx.companyId, sessionId: input.sessionId },
      });
      if (prior) {
        const view = closureViewSchema.parse(prior.snapshot);
        if (
          prior.closedById !== ctx.userId ||
          view.cashRegisterId !== input.cashRegisterId ||
          view.counts.find((c) => c.currency === 'USD')!.counted !== input.countedUSD ||
          view.counts.find((c) => c.currency === 'CDF')!.counted !== input.countedCDF
        )
          throw new DataError('CLOSURE_CONFLICT');
        return view;
      }
      const session = await tx.cashSession.findFirst({
        where: {
          companyId: ctx.companyId,
          id: input.sessionId,
          cashRegisterId: input.cashRegisterId,
          state: 'OPEN',
        },
      });
      if (!session) throw new DataError('CASH_SESSION_REQUIRED');
      const closedAt = new Date();
      await tx.cashSession.update({
        where: { id: session.id },
        data: { state: 'CLOSED', closedAt, closedById: ctx.userId },
      });
      const row = await tx.cashClosureReport.create({
        data: {
          id: randomUUID(),
          companyId: ctx.companyId,
          cashRegisterId: input.cashRegisterId,
          sessionId: session.id,
          closedById: ctx.userId,
          closedAt,
          snapshot: { USD: input.countedUSD, CDF: input.countedCDF },
        },
      });
      await tx.auditEvent.create({
        data: {
          id: randomUUID(),
          companyId: ctx.companyId,
          actorId: ctx.userId,
          action: 'CASH_SESSION_CLOSED',
          targetType: 'CLOSURE',
          targetId: row.id,
        },
      });
      return closureViewSchema.parse(row.snapshot);
    });
  }
}
