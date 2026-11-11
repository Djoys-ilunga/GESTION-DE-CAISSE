import { moneyText } from '../data/money';
import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  companySettingsInputSchema,
  companySettingsSchema,
  agencySettingsInputSchema,
  categoryInputSchema,
  referenceRateInputSchema,
  managementSettingsSchema,
  referenceDataSchema,
  auditQuerySchema,
  auditPageSchema,
  supervisionSchema,
} from '@caissepro/shared';
import { Prisma } from '../generated/prisma/client';
import { AuthService, type Principal } from '../auth/auth.service';
import { CentralAccess, DataError, type DataContext, type Tx } from '../data/central-access';
import type { AuthTx } from '../auth/auth-store';
import { CashService } from '../cash/cash.service';
const context = (p: Principal): DataContext => ({
  companyId: p.companyId,
  userId: p.userId,
  sessionId: p.sessionId,
});
const rateView = (r: {
  id: string;
  fromCurrency: string;
  toCurrency: string;
  rate: Prisma.Decimal;
  source: string;
  validFrom: Date;
  publishedAt: Date;
}) => ({
  id: r.id,
  fromCurrency: r.fromCurrency,
  toCurrency: r.toCurrency,
  rate: r.rate.toFixed(12),
  source: r.source,
  validFrom: r.validFrom.toISOString(),
  publishedAt: r.publishedAt.toISOString(),
});
@Injectable()
export class ManagementService {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(CentralAccess) private readonly access: CentralAccess,
    @Inject(CashService) private readonly cash: CashService,
  ) {}
  private configure<T>(
    p: Principal,
    action: (tx: AuthTx) => Promise<T>,
    permission = 'cash:configure',
  ) {
    return this.auth.store.run(async (tx) => {
      await this.auth.require(tx, p, permission);
      await tx.$executeRaw`SELECT set_config('caissepro.company_id',${p.companyId},true),set_config('caissepro.actor_id',${p.userId},true),set_config('caissepro.session_id',${p.sessionId},true)`;
      return action(tx);
    });
  }
  private audit(tx: Tx, p: Principal, action: string, targetType: string, targetId: string) {
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
  private async references(tx: Tx, companyId: string, active: boolean) {
    const categories = await tx.financialCategory.findMany({
      where: { companyId, ...(active ? { active: true } : {}) },
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
      take: 501,
    });
    if (categories.length > 500) throw new DataError('REPORT_TOO_LARGE');
    const rates = await tx.referenceExchangeRate.findMany({
      where: { companyId, ...(active ? { validFrom: { lte: new Date() } } : {}) },
      orderBy: [{ validFrom: 'desc' }, { publishedAt: 'desc' }],
      take: 50,
    });
    return {
      categories: categories.map((c) => ({
        id: c.id,
        code: c.code,
        name: c.name,
        kind: c.kind,
        active: c.active,
        version: c.version,
      })),
      rates: rates.map(rateView),
      generatedAt: new Date().toISOString(),
    };
  }
  settings(p: Principal) {
    return this.configure(p, async (tx) => {
      const c = await tx.company.findUniqueOrThrow({ where: { id: p.companyId } });
      const company = companySettingsSchema.parse({
        id: c.id,
        code: c.code,
        name: c.name,
        address: c.address,
        phone: c.phone,
        email: c.email,
        taxId: c.taxId,
        version: c.settingsVersion,
        sessionMinutes: c.sessionMinutes,
        idleMinutes: c.idleMinutes,
        offlineMinutes: c.offlineMinutes,
      });
      const agencies = await tx.agency.findMany({
        where: { companyId: p.companyId },
        select: { id: true, code: true, name: true, active: true, version: true },
        orderBy: { code: 'asc' },
        take: 201,
      });
      if (agencies.length > 200) throw new DataError('REPORT_TOO_LARGE');
      return managementSettingsSchema.parse({
        company,
        agencies,
        ...(await this.references(tx, p.companyId, false)),
      });
    });
  }
  referenceData(p: Principal) {
    return this.configure(
      p,
      async (tx) => referenceDataSchema.parse(await this.references(tx, p.companyId, true)),
      'directory:read',
    );
  }
  updateCompany(p: Principal, value: unknown) {
    const { expectedVersion, confirmed, ...input } = companySettingsInputSchema.parse(value);
    void confirmed;
    return this.configure(p, async (tx) => {
      const c = await tx.company.findUniqueOrThrow({ where: { id: p.companyId } });
      const changed =
        c.sessionMinutes !== input.sessionMinutes ||
        c.idleMinutes !== input.idleMinutes ||
        c.offlineMinutes !== input.offlineMinutes;
      const r = await tx.company.updateMany({
        where: { id: p.companyId, settingsVersion: expectedVersion },
        data: { ...input, settingsVersion: { increment: 1 } },
      });
      if (r.count !== 1) throw new DataError('SETTINGS_CONFLICT');
      await this.audit(
        tx,
        p,
        changed ? 'SESSION_POLICY_CONFIGURED' : 'COMPANY_CONFIGURED',
        'COMPANY',
        p.companyId,
      );
      if (changed)
        await tx.authSession.updateMany({
          where: { companyId: p.companyId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      return { ok: true, sessionsRevoked: changed };
    });
  }
  updateAgency(p: Principal, id: string, value: unknown) {
    const { expectedVersion, confirmed, ...input } = agencySettingsInputSchema.parse(value);
    void confirmed;
    return this.configure(p, async (tx) => {
      if (
        !input.active &&
        (await tx.cashRegister.count({
          where: { companyId: p.companyId, agencyId: id, active: true },
        }))
      )
        throw new DataError('AGENCY_HAS_ACTIVE_CASH');
      const r = await tx.agency.updateMany({
        where: { id, companyId: p.companyId, version: expectedVersion },
        data: { ...input, version: { increment: 1 } },
      });
      if (r.count !== 1) throw new DataError('SETTINGS_CONFLICT');
      await this.audit(tx, p, 'AGENCY_CONFIGURED', 'AGENCY', id);
      return { ok: true };
    });
  }
  category(p: Principal, value: unknown) {
    const { expectedVersion, confirmed, ...input } = categoryInputSchema.parse(value);
    void confirmed;
    return this.configure(p, async (tx) => {
      const prior = await tx.financialCategory.findFirst({
        where: { id: input.id, companyId: p.companyId },
      });
      if (expectedVersion === null) {
        if (prior) {
          if (
            prior.code !== input.code ||
            prior.name !== input.name ||
            prior.kind !== input.kind ||
            prior.active !== input.active
          )
            throw new DataError('SETTINGS_CONFLICT');
          return { ok: true };
        }
        await tx.financialCategory.create({ data: { ...input, companyId: p.companyId } });
      } else {
        if (!prior || prior.code !== input.code || prior.kind !== input.kind)
          throw new DataError('SETTINGS_CONFLICT');
        const r = await tx.financialCategory.updateMany({
          where: { id: input.id, companyId: p.companyId, version: expectedVersion },
          data: { name: input.name, active: input.active, version: { increment: 1 } },
        });
        if (r.count !== 1) throw new DataError('SETTINGS_CONFLICT');
      }
      await this.audit(tx, p, 'CATEGORY_CONFIGURED', 'CATEGORY', input.id);
      return { ok: true };
    });
  }
  publishRate(p: Principal, value: unknown) {
    const { confirmed, ...input } = referenceRateInputSchema.parse(value);
    void confirmed;
    return this.configure(p, async (tx) => {
      const prior = await tx.referenceExchangeRate.findFirst({
        where: { id: input.id, companyId: p.companyId },
      });
      if (prior) {
        if (
          prior.fromCurrency !== input.fromCurrency ||
          prior.toCurrency !== input.toCurrency ||
          !prior.rate.equals(input.rate) ||
          prior.source !== input.source ||
          prior.validFrom.getTime() !== Date.parse(input.validFrom)
        )
          throw new DataError('SETTINGS_CONFLICT');
        return { ok: true };
      }
      await tx.referenceExchangeRate.create({
        data: {
          ...input,
          validFrom: new Date(input.validFrom),
          companyId: p.companyId,
          publishedById: p.userId,
        },
      });
      await this.audit(tx, p, 'REFERENCE_RATE_PUBLISHED', 'RATE', input.id);
      return { ok: true };
    });
  }
  async supervision(p: Principal) {
    const cash = await this.cash.list(context(p), null),
      ids = cash.items.map((c) => c.id);
    const financial = await this.access.run(context(p), async (tx) => {
      await tx.$executeRaw`SELECT caissepro_assert_company_permission(${p.companyId}::uuid,${p.userId}::uuid,'ledger:read')`;
      for (const id of ids) await this.access.requireCashRead(tx, context(p), id, 'ledger:read');
      const expenseWhere = {
        companyId: p.companyId,
        state: 'PENDING' as const,
        account: { cashRegisterId: { in: ids } },
      };
      const transferWhere = {
        companyId: p.companyId,
        state: 'HANDED_OVER',
        OR: [{ sourceCashRegisterId: { in: ids } }, { destinationCashRegisterId: { in: ids } }],
      };
      const [expenses, expenseTotal, transfers, transferTotal] = await Promise.all([
        tx.expenseRequest.findMany({
          where: expenseWhere,
          select: { id: true, currency: true, amount: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),
        tx.expenseRequest.count({ where: expenseWhere }),
        tx.transferOrder.findMany({
          where: transferWhere,
          select: { id: true, handedOverAt: true },
          orderBy: { handedOverAt: 'desc' },
          take: 20,
        }),
        tx.transferOrder.count({ where: transferWhere }),
      ]);
      const cashSql = ids.length
        ? Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))
        : Prisma.sql`NULL::uuid`;
      const closures = await tx.$queryRaw<
        { id: string; closedAt: Date; total: number }[]
      >`SELECT id,"closedAt",(count(*) OVER())::integer AS total FROM "CashClosureReport" WHERE "companyId"=${p.companyId}::uuid AND "cashRegisterId" IN (${cashSql}) AND "closedAt">clock_timestamp()-interval '30 days' AND EXISTS(SELECT FROM jsonb_array_elements(snapshot->'counts') v WHERE (v->>'difference')::numeric<>0) ORDER BY "closedAt" DESC LIMIT 20`;
      const notifications = [
        ...expenses.map((e) => ({
          id: 'expense-' + e.id,
          title: 'Dépense en attente',
          message: `${moneyText(e.amount, e.currency)} ${e.currency} — consulter la demande.`,
          severity: 'info' as const,
          target: 'expenses' as const,
          createdAt: e.createdAt.toISOString(),
        })),
        ...transfers.map((t) => ({
          id: 'transfer-' + t.id,
          title: 'Transfert remis, réception attendue',
          message: 'La réception explicite des fonds reste nécessaire.',
          severity: 'info' as const,
          target: 'transfers' as const,
          createdAt: t.handedOverAt!.toISOString(),
        })),
        ...closures.map((c) => ({
          id: 'closure-' + c.id,
          title: 'Écart constaté à la clôture',
          message: 'Consulter le procès-verbal et son comptage déclaré.',
          severity: 'warning' as const,
          target: 'reports' as const,
          createdAt: c.closedAt.toISOString(),
        })),
      ]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 20);
      return {
        notifications,
        notificationTotal: expenseTotal + transferTotal + (closures[0]?.total ?? 0),
      };
    });
    const users = await this.configure(
      p,
      async (tx) => {
        const fresh = await this.auth.require(tx, p, 'ledger:read');
        if (!fresh.permissions.includes('users:manage')) return null;
        const members = await tx.companyMember.findMany({
          where: { companyId: p.companyId, cashGrants: { some: { cashRegisterId: { in: ids } } } },
          include: { user: true },
          take: 501,
        });
        if (members.length > 500) throw new DataError('REPORT_TOO_LARGE');
        const now = new Date();
        const sessions = await tx.authSession.findMany({
          where: {
            companyId: p.companyId,
            userId: { in: members.map((m) => m.userId) },
            revokedAt: null,
            expiresAt: { gt: now },
            idleExpiresAt: { gt: now },
            lockedAt: null,
          },
          select: { userId: true, userVersion: true, memberVersion: true, lastSeenAt: true },
        });
        return members.map((m) => {
          const live = sessions.filter(
            (s) =>
              s.userId === m.userId &&
              s.userVersion === m.user.securityVersion &&
              s.memberVersion === m.authorizationVersion,
          );
          return {
            id: m.userId,
            name: m.user.displayName,
            active: m.active && m.user.active,
            validSessions: m.active && m.user.active ? live.length : 0,
            lastSeenAt:
              live
                .map((s) => s.lastSeenAt.toISOString())
                .sort()
                .at(-1) ?? null,
          };
        });
      },
      'ledger:read',
    );
    return supervisionSchema.parse({
      generatedAt: new Date().toISOString(),
      cash: cash.items.map((c) => ({
        id: c.id,
        name: c.name,
        agencyName: c.agency.name,
        active: c.active,
        openedAt: c.session?.openedAt ?? null,
      })),
      users,
      ...financial,
    });
  }
  auditLog(p: Principal, value: unknown, download = false) {
    const q = auditQuerySchema.parse(value);
    return this.access.run(context(p), async (tx) => {
      await tx.$executeRaw`SELECT caissepro_assert_company_permission(${p.companyId}::uuid,${p.userId}::uuid,'auth:logs:read')`;
      const grants = await tx.cashRegisterGrant.findMany({
        where: {
          companyId: p.companyId,
          member: { userId: p.userId, active: true },
          register: { agency: { active: true } },
        },
      });
      const agencies = await tx.agencyGrant.findMany({
        where: { companyId: p.companyId, member: { userId: p.userId, active: true } },
      });
      const agencyIds = agencies.map((a) => a.agencyId),
        allowed = grants.filter((g) => agencyIds.includes(g.agencyId)).map((g) => g.cashRegisterId);
      if (q.cashRegisterId && !allowed.includes(q.cashRegisterId))
        throw new DataError('ACCESS_DENIED');
      const ids = q.cashRegisterId ? [q.cashRegisterId] : allowed;
      const cashSql = ids.length
        ? Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))
        : Prisma.sql`NULL::uuid`;
      const agencySql = agencyIds.length
        ? Prisma.join(agencyIds.map((id) => Prisma.sql`${id}::uuid`))
        : Prisma.sql`NULL::uuid`;
      const filters = Prisma.sql`e."companyId"=${p.companyId}::uuid AND (${q.from ?? null}::timestamptz IS NULL OR e."createdAt">=${q.from ?? null}::timestamptz) AND (${q.to ?? null}::timestamptz IS NULL OR e."createdAt"<=${q.to ?? null}::timestamptz) AND (${q.action ?? null}::text IS NULL OR e.action=${q.action ?? null}) AND (${q.actorId ?? null}::uuid IS NULL OR e."actorId"=${q.actorId ?? null}::uuid) AND (
        (e."targetType"='OPERATION' AND EXISTS(SELECT FROM "LedgerEntry" l JOIN "TreasuryAccount" a ON a.id=l."accountId" AND a."companyId"=l."companyId" WHERE l."companyId"=e."companyId" AND l."operationId"=e."targetId" AND a."cashRegisterId" IN (${cashSql}))) OR
        (e."targetType"='EXPENSE' AND EXISTS(SELECT FROM "ExpenseRequest" x JOIN "TreasuryAccount" a ON a.id=x."accountId" AND a."companyId"=x."companyId" WHERE x."companyId"=e."companyId" AND x.id=e."targetId" AND a."cashRegisterId" IN (${cashSql}))) OR
        (e."targetType"='TRANSFER' AND EXISTS(SELECT FROM "TransferOrder" t WHERE t."companyId"=e."companyId" AND t.id=e."targetId" AND (t."sourceCashRegisterId" IN (${cashSql}) OR t."destinationCashRegisterId" IN (${cashSql})))) OR
        (e."targetType"='CLOSURE' AND EXISTS(SELECT FROM "CashClosureReport" c WHERE c."companyId"=e."companyId" AND c.id=e."targetId" AND c."cashRegisterId" IN (${cashSql}))) OR
        (e."targetType"='CASH' AND e."targetId" IN (${cashSql})) OR
        (e."targetType"='DRAFT' AND EXISTS(SELECT FROM "ImportedDraft" d WHERE d."companyId"=e."companyId" AND d.id=e."targetId" AND d."authorId"=${p.userId}::uuid AND d."cashRegisterId" IN (${cashSql}))) OR
        (${!q.cashRegisterId} AND e."targetType"='AGENCY' AND e."targetId" IN (${agencySql})) OR
        (${!q.cashRegisterId} AND e."targetType" IN('COMPANY','CATEGORY','RATE'))
      )`;
      const [count] = await tx.$queryRaw<
        { total: number }[]
      >`SELECT count(*)::integer AS total FROM "AuditEvent" e WHERE ${filters}`;
      if (download && count!.total > 10000) throw new DataError('REPORT_TOO_LARGE');
      const rows = await tx.$queryRaw<
        {
          id: string;
          action: string;
          targetType: string;
          targetId: string;
          actorName: string;
          createdAt: Date;
        }[]
      >`SELECT e.id,e.action,e."targetType",e."targetId",u."displayName" AS "actorName",e."createdAt" FROM "AuditEvent" e JOIN "User" u ON u.id=e."actorId" WHERE ${filters} ORDER BY e."createdAt" DESC,e.id DESC LIMIT ${download ? 10000 : 50} OFFSET ${download ? 0 : (q.page - 1) * 50}`;
      return auditPageSchema.parse({
        generatedAt: new Date().toISOString(),
        page: q.page,
        pageSize: 50,
        total: count!.total,
        items: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
      });
    });
  }
}
