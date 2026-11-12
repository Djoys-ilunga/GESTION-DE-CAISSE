import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  BCC_CONNECTOR,
  BccExchangeRateProvider,
  BccProviderError,
  type BccSourceConnector,
} from './bcc.provider';
import { BccRepository } from './bcc.repository';
const minimumInterval = 3600000;
@Injectable()
export class BccRefreshCoordinator implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(
    @Inject(BccRepository) private readonly repo: BccRepository,
    @Inject(BccExchangeRateProvider) private readonly provider: BccExchangeRateProvider,
    @Inject(BCC_CONNECTOR) readonly connector: BccSourceConnector,
  ) {}
  onModuleInit() {
    if (process.env.BCC_SCHEDULER_ENABLED === '0' || !this.connector.descriptor.verified) return;
    this.timer = setInterval(() => {
      void this.refresh().catch(() => {});
    }, 60000);
    this.timer.unref();
  }
  onModuleDestroy() {
    clearInterval(this.timer);
  }
  async refresh(): Promise<{
    state: string;
    code: string;
    publicationId: string | null;
    performed: boolean;
  }> {
    const descriptor = this.connector.descriptor;
    const approved = await this.repo.run((tx) =>
      tx.bccSourceApproval.findUniqueOrThrow({ where: { id: 'bcc' } }),
    );
    if (
      !descriptor.verified ||
      !approved.approved ||
      approved.sourceUrl !== descriptor.sourceUrl ||
      approved.contractVersion !== descriptor.contractVersion
    )
      return {
        state: 'UNVERIFIED',
        code: descriptor.blockedReason ?? 'SOURCE_CONTRACT_UNVERIFIED',
        publicationId: null,
        performed: false,
      };
    const token = randomUUID();
    const lease = await this.repo.run(
      (tx) =>
        tx.$queryRaw<
          { id: string }[]
        >`UPDATE "BccRefreshState" SET state='FETCHING',code='BCC_REFRESHING',"checkedAt"=clock_timestamp(),"nextAllowedAt"=clock_timestamp()+interval'1 hour',"leaseToken"=${token}::uuid,"leaseUntil"=clock_timestamp()+interval'30 seconds' WHERE id='bcc' AND("nextAllowedAt" IS NULL OR "nextAllowedAt"<=clock_timestamp())AND("leaseUntil" IS NULL OR "leaseUntil"<=clock_timestamp()) RETURNING id`,
    );
    if (!lease.length)
      return {
        state: (
          await this.repo.run((tx) =>
            tx.bccRefreshState.findUniqueOrThrow({ where: { id: 'bcc' } }),
          )
        ).state,
        code: 'BCC_REFRESH_THROTTLED',
        publicationId: null,
        performed: false,
      };
    try {
      const document = await this.connector.retrieve(),
        now = new Date();
      if (
        !/^[0-9a-f]{64}$/.test(document.contentSha256) ||
        !(document.retrievedAt instanceof Date) ||
        !Number.isFinite(document.retrievedAt.getTime()) ||
        document.retrievedAt.getTime() > now.getTime() + 30000 ||
        document.retrievedAt.getTime() < now.getTime() - 300000
      )
        throw new BccProviderError('BCC_RETRIEVAL_INVALID');
      const normalized = this.provider.normalize(document.candidate, now);
      return await this.repo.run(async (tx) => {
        const state = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM "BccRefreshState" WHERE id='bcc' AND "leaseToken"=${token}::uuid AND "leaseUntil">clock_timestamp() FOR UPDATE`;
        if (!state.length) throw new BccProviderError('BCC_LEASE_EXPIRED');
        const known = await tx.currencyDefinition.count({
          where: { code: { in: normalized.quotes.map((q) => q.currency) } },
        });
        if (known !== normalized.quotes.length) throw new BccProviderError('BCC_CURRENCY_UNKNOWN');
        let publication = await tx.bccPublication.findFirst({
          where: {
            sourceId: 'bcc',
            contentSha256: document.contentSha256,
            connectorVersion: descriptor.contractVersion,
          },
        });
        const isNew = !publication;
        if (!publication) {
          publication = await tx.bccPublication.create({
            data: {
              id: randomUUID(),
              sourceId: 'bcc',
              sourceUrl: descriptor.sourceUrl,
              sourceReference: normalized.sourceReference,
              publicationDate: normalized.publicationDate,
              publishedAt: normalized.publishedAt,
              retrievedAt: document.retrievedAt,
              contentSha256: document.contentSha256,
              connectorVersion: descriptor.contractVersion,
            },
          });
          await tx.bccQuotation.createMany({
            data: normalized.quotes.map((q) => ({ ...q, publicationId: publication!.id })),
          });
        }
        const latest = await tx.bccPublication.findFirstOrThrow({
          orderBy: [
            { publicationDate: 'desc' },
            { publishedAt: { sort: 'desc', nulls: 'last' } },
            { retrievedAt: 'desc' },
            { id: 'desc' },
          ],
          include: { quotes: { select: { currency: true } } },
        });
        // Availability means presence in the latest verified publication, not freshness.
        await tx.currencyDefinition.updateMany({ data: { bccRateStatus: 'UNAVAILABLE' } });
        await tx.currencyDefinition.updateMany({
          where: { code: { in: latest.quotes.map((q) => q.currency) } },
          data: { bccRateStatus: 'AVAILABLE' },
        });
        await tx.bccRefreshState.update({
          where: { id: 'bcc' },
          data: {
            state: 'READY',
            code: isNew ? 'BCC_NEW_PUBLICATION' : 'BCC_NO_NEW_PUBLICATION',
            lastSuccessAt: now,
            leaseToken: null,
            leaseUntil: null,
            failures: 0,
            nextAllowedAt: new Date(now.getTime() + minimumInterval),
          },
        });
        await tx.bccRefreshEvent.create({
          data: {
            id: randomUUID(),
            state: 'READY',
            code: isNew ? 'BCC_NEW_PUBLICATION' : 'BCC_NO_NEW_PUBLICATION',
            checkedAt: now,
            retrievedAt: document.retrievedAt,
            publicationId: publication.id,
          },
        });
        return {
          state: 'READY',
          code: isNew ? 'BCC_NEW_PUBLICATION' : 'BCC_NO_NEW_PUBLICATION',
          publicationId: publication.id,
          performed: true,
        };
      });
    } catch (error) {
      const code = error instanceof BccProviderError ? error.code : 'BCC_REFRESH_FAILED';
      await this.repo.run(async (tx) => {
        const rows = await tx.$queryRaw<
          { failures: number }[]
        >`SELECT failures FROM "BccRefreshState" WHERE id='bcc' AND "leaseToken"=${token}::uuid FOR UPDATE`;
        if (!rows.length) return;
        const now = new Date(),
          delay = Math.min(
            6 * minimumInterval,
            minimumInterval * 2 ** Math.min(rows[0]!.failures, 3),
          );
        await tx.bccRefreshState.update({
          where: { id: 'bcc' },
          data: {
            state: 'UNAVAILABLE',
            code,
            leaseToken: null,
            leaseUntil: null,
            failures: { increment: 1 },
            nextAllowedAt: new Date(now.getTime() + delay),
          },
        });
        await tx.bccRefreshEvent.create({
          data: { id: randomUUID(), state: 'UNAVAILABLE', code, checkedAt: now },
        });
      });
      return { state: 'UNAVAILABLE', code, publicationId: null, performed: true };
    }
  }
}
