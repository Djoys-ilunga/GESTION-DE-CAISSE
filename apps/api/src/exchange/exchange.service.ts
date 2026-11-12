import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  bccRatesSchema,
  bccHistorySchema,
  exchangeQuoteInputSchema,
  exchangeQuoteSchema,
  exchangePolicyInputSchema,
  currencyPrecision,
  validCurrencyAmount,
  type BccPublication,
} from '@caissepro/shared';
import { Prisma, type BccPublication as Publication } from '../generated/prisma/client';
import { CentralAccess, DataError, type DataContext, type Tx } from '../data/central-access';
import { moneyText } from '../data/money';
import { BccRefreshCoordinator } from './bcc.refresh';
import { BccExchangeRateProvider } from './bcc.provider';
const D = Prisma.Decimal.clone({ precision: 80, rounding: Prisma.Decimal.ROUND_HALF_UP });
export const publicationView = (p: Publication): BccPublication => ({
  id: p.id,
  sourceUrl: p.sourceUrl,
  sourceReference: p.sourceReference,
  publicationDate: p.publicationDate,
  publishedAt: p.publishedAt?.toISOString() ?? null,
  retrievedAt: p.retrievedAt.toISOString(),
  contentSha256: p.contentSha256,
  connectorVersion: p.connectorVersion,
});
const quotationView = (q: {
  currency: string;
  unit: string;
  unitEvidence: string;
  rawBuy: Prisma.Decimal | null;
  rawMean: Prisma.Decimal | null;
  rawSell: Prisma.Decimal | null;
  buy: Prisma.Decimal | null;
  mean: Prisma.Decimal | null;
  sell: Prisma.Decimal | null;
}) => ({
  currency: q.currency,
  unit: q.unit,
  unitEvidence: q.unitEvidence,
  rawBuy: q.rawBuy?.toFixed(12) ?? null,
  rawMean: q.rawMean?.toFixed(12) ?? null,
  rawSell: q.rawSell?.toFixed(12) ?? null,
  buy: q.buy?.toFixed(18) ?? null,
  mean: q.mean?.toFixed(18) ?? null,
  sell: q.sell?.toFixed(18) ?? null,
});
const policyView = (p: {
  allowManual: boolean;
  quoteKind: string;
  maxAgeHours: number;
  quoteTtlMinutes: number;
  version: number;
}) => ({
  allowManual: p.allowManual,
  quoteKind: p.quoteKind,
  maxAgeHours: p.maxAgeHours,
  quoteTtlMinutes: p.quoteTtlMinutes,
  version: p.version,
});
@Injectable()
export class ExchangeRatesService {
  constructor(
    @Inject(CentralAccess) private readonly access: CentralAccess,
    @Inject(BccRefreshCoordinator) private readonly refreshCoordinator: BccRefreshCoordinator,
    @Inject(BccExchangeRateProvider) private readonly provider: BccExchangeRateProvider,
  ) {}
  private permission(tx: Tx, c: DataContext, p = 'ledger:read') {
    return tx.$executeRaw`SELECT caissepro_assert_company_permission(${c.companyId}::uuid,${c.userId}::uuid,${p})`;
  }
  async rates(c: DataContext) {
    return this.access.run(c, async (tx) => {
      await this.permission(tx, c);
      const [approval, state, policy, publication, catalog, active] = await Promise.all([
        tx.bccSourceApproval.findUniqueOrThrow({ where: { id: 'bcc' } }),
        tx.bccRefreshState.findUniqueOrThrow({ where: { id: 'bcc' } }),
        tx.exchangeRatePolicy.findUniqueOrThrow({ where: { companyId: c.companyId } }),
        tx.bccPublication.findFirst({
          orderBy: [
            { publicationDate: 'desc' },
            { publishedAt: { sort: 'desc', nulls: 'last' } },
            { retrievedAt: 'desc' },
            { id: 'desc' },
          ],
          include: { quotes: { orderBy: { currency: 'asc' } } },
        }),
        tx.currencyDefinition.findMany({ orderBy: { code: 'asc' } }),
        tx.companyCurrency.findMany({
          where: { companyId: c.companyId, active: true },
          select: { code: true },
        }),
      ]);
      const descriptor = this.refreshCoordinator.connector.descriptor,
        approved =
          descriptor.verified &&
          approval.approved &&
          approval.sourceUrl === descriptor.sourceUrl &&
          approval.contractVersion === descriptor.contractVersion;
      const freshUntil = publication
        ? new Date(
            Date.parse(publication.publicationDate + 'T00:00:00+01:00') +
              policy.maxAgeHours * 3600000,
          )
        : null;
      return bccRatesSchema.parse({
        generatedAt: new Date().toISOString(),
        source: {
          state: approved ? state.state : 'UNVERIFIED',
          code: approved ? state.code : (descriptor.blockedReason ?? 'SOURCE_CONTRACT_UNVERIFIED'),
          approved,
          checkedAt: state.checkedAt?.toISOString() ?? null,
          lastSuccessAt: state.lastSuccessAt?.toISOString() ?? null,
          nextAllowedAt: state.nextAllowedAt?.toISOString() ?? null,
          sourceUrl: approval.sourceUrl,
        },
        policy: policyView(policy),
        publication: publication ? publicationView(publication) : null,
        quotes: publication?.quotes.map(quotationView) ?? [],
        currencies: catalog.map((d) => ({
          code: d.code,
          name: d.name,
          activeForCompany: active.some((a) => a.code === d.code),
          covered: publication?.quotes.some((q) => q.currency === d.code) ?? false,
        })),
        stale: !approved || !freshUntil || freshUntil.getTime() <= Date.now(),
        freshUntil: freshUntil?.toISOString() ?? null,
      });
    });
  }
  async history(c: DataContext, page: number) {
    return this.access.run(c, async (tx) => {
      await this.permission(tx, c);
      const [items, total] = await Promise.all([
        tx.bccPublication.findMany({
          orderBy: [{ publicationDate: 'desc' }, { retrievedAt: 'desc' }, { id: 'desc' }],
          include: { quotes: { orderBy: { currency: 'asc' } } },
          skip: (page - 1) * 25,
          take: 25,
        }),
        tx.bccPublication.count(),
      ]);
      return bccHistorySchema.parse({
        items: items.map((p) => ({ ...publicationView(p), quotes: p.quotes.map(quotationView) })),
        total,
        page,
        pageSize: 25,
      });
    });
  }
  async refresh(c: DataContext) {
    await this.access.run(c, async (tx) => {
      await this.permission(tx, c, 'cash:configure');
      await this.audit(tx, c, 'BCC_REFRESH_REQUESTED', c.companyId);
    });
    return this.refreshCoordinator.refresh();
  }
  async policy(c: DataContext, raw: unknown) {
    const { expectedVersion, confirmed, ...input } = exchangePolicyInputSchema.parse(raw);
    void confirmed;
    return this.access.run(c, async (tx) => {
      await this.permission(tx, c, 'cash:configure');
      const r = await tx.exchangeRatePolicy.updateMany({
        where: { companyId: c.companyId, version: expectedVersion },
        data: { ...input, version: { increment: 1 }, updatedById: c.userId },
      });
      if (r.count !== 1) throw new DataError('SETTINGS_CONFLICT');
      await this.audit(tx, c, 'EXCHANGE_POLICY_CONFIGURED', c.companyId);
      return { ok: true };
    });
  }
  async quote(c: DataContext, raw: unknown) {
    const input = exchangeQuoteInputSchema.parse(raw);
    return this.access.run(c, async (tx) => {
      await this.permission(tx, c);
      if (!validCurrencyAmount(input.amount, currencyPrecision(input.fromCurrency)))
        throw new DataError('CURRENCY_PRECISION');
      const policy = await tx.exchangeRatePolicy.findUniqueOrThrow({
        where: { companyId: c.companyId },
      });
      let referenceRate: string | null = null,
        publication: Publication | null = null;
      if (input.mode === 'BCC' || input.referencePublicationId) {
        if (!this.refreshCoordinator.connector.descriptor.verified)
          throw new DataError(
            this.refreshCoordinator.connector.descriptor.blockedReason ?? 'BCC_SOURCE_UNVERIFIED',
          );
        publication = input.referencePublicationId
          ? await tx.bccPublication.findUnique({ where: { id: input.referencePublicationId } })
          : await tx.bccPublication.findFirst({
              orderBy: [
                { publicationDate: 'desc' },
                { publishedAt: { sort: 'desc', nulls: 'last' } },
                { retrievedAt: 'desc' },
                { id: 'desc' },
              ],
            });
        if (!publication) throw new DataError('BCC_RATE_UNAVAILABLE');
        const quotes = await tx.bccQuotation.findMany({
            where: {
              publicationId: publication.id,
              currency: { in: [input.fromCurrency, input.toCurrency] },
            },
          }),
          key = policy.quoteKind === 'BUY' ? 'buy' : policy.quoteKind === 'SELL' ? 'sell' : 'mean';
        const value = (currency: string) =>
          currency === 'CDF' ? '1' : quotes.find((q) => q.currency === currency)?.[key]?.toString();
        const from = value(input.fromCurrency),
          to = value(input.toCurrency);
        if (!from || !to) throw new DataError('BCC_RATE_UNAVAILABLE');
        referenceRate = this.provider.cross(from, to);
      }
      if (input.mode === 'MANUAL') {
        await this.permission(tx, c, 'fx:manual');
        if (!policy.allowManual) throw new DataError('MANUAL_RATE_FORBIDDEN');
      }
      const appliedRate =
          input.mode === 'BCC' ? referenceRate! : new D(input.manualRate!).toFixed(12),
        now = new Date();
      const row = await tx.rateQuote.create({
        data: {
          id: randomUUID(),
          companyId: c.companyId,
          createdById: c.userId,
          fromCurrency: input.fromCurrency,
          toCurrency: input.toCurrency,
          amount: input.amount,
          targetAmount: moneyText(new D(input.amount).mul(appliedRate), input.toCurrency),
          mode: input.mode,
          quoteKind: policy.quoteKind,
          referenceRate,
          appliedRate,
          source:
            input.mode === 'BCC'
              ? `BCC ${publication!.publicationDate} ${policy.quoteKind}`
              : input.manualSource!,
          justification: input.justification ?? null,
          effectiveAt:
            input.mode === 'BCC'
              ? new Date(publication!.publicationDate + 'T00:00:00+01:00')
              : new Date(input.manualEffectiveAt!),
          createdAt: now,
          expiresAt: now,
          publicationId: publication?.id ?? null,
          policyVersion: policy.version,
          snapshot: {},
        },
      });
      await this.audit(tx, c, 'RATE_QUOTE_PREPARED', row.id);
      return exchangeQuoteSchema.parse({
        id: row.id,
        fromCurrency: row.fromCurrency,
        toCurrency: row.toCurrency,
        mode: row.mode,
        quoteKind: row.quoteKind,
        source: row.source,
        justification: row.justification,
        publicationId: row.publicationId,
        policyVersion: row.policyVersion,
        amount: moneyText(row.amount, row.fromCurrency),
        targetAmount: moneyText(row.targetAmount, row.toCurrency),
        referenceRate: row.referenceRate?.toFixed(12) ?? null,
        appliedRate: row.appliedRate.toFixed(12),
        effectiveAt: row.effectiveAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        snapshot: row.snapshot,
      });
    });
  }
  private audit(tx: Tx, c: DataContext, action: string, id: string) {
    return tx.auditEvent.create({
      data: {
        id: randomUUID(),
        companyId: c.companyId,
        actorId: c.userId,
        action,
        targetType: 'RATE',
        targetId: id,
      },
    });
  }
}
