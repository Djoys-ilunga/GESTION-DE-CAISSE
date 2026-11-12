import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Prisma } from '../generated/prisma/client';
export const BCC_OFFICIAL_PAGES = [
  'https://www.bcc.cd/marche-des-changes/cours-de-change',
  'https://www.bcc.cd/marche-des-changes/convertisseur',
  'https://www.bcc.cd/statistiques/secteur-exterieur/cours-de-change',
] as const;
export const BCC_CONNECTOR = Symbol('BCC_CONNECTOR');
export class BccProviderError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const decimal = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,17})(?:\.\d{1,12})?$/)
  .refine((v) => /[1-9]/.test(v));
const quote = z
  .object({
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .refine((c) => c !== 'CDF'),
    unit: z.enum(['1', '100']),
    unitEvidence: z.string().trim().min(1).max(160),
    buy: decimal.nullable(),
    mean: decimal.nullable(),
    sell: decimal.nullable(),
  })
  .strict()
  .refine((q) => q.buy !== null || q.mean !== null || q.sell !== null);
export const bccCandidateSchema = z
  .object({
    publicationDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((v) => !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v),
    publishedAt: z.iso.datetime().nullable(),
    sourceReference: z.string().trim().min(1).max(160),
    quotes: z.array(quote).min(1).max(300),
  })
  .strict()
  .refine((v) => new Set(v.quotes.map((q) => q.currency)).size === v.quotes.length);
export type BccCandidate = z.infer<typeof bccCandidateSchema>;
export interface BccSourceConnector {
  readonly descriptor: {
    sourceUrl: string;
    contractVersion: string;
    verified: boolean;
    blockedReason?: 'BCC_AUTHORIZATION_REQUIRED';
  };
  // This is an internal adapter contract, NOT a claimed public BCC API.
  retrieve(): Promise<{ candidate: unknown; contentSha256: string; retrievedAt: Date }>;
}
@Injectable()
export class UnverifiedBccConnector implements BccSourceConnector {
  readonly descriptor = {
    sourceUrl: BCC_OFFICIAL_PAGES[0],
    contractVersion: 'UNVERIFIED',
    verified: false,
  };
  async retrieve(): Promise<never> {
    throw new BccProviderError('SOURCE_CONTRACT_UNVERIFIED');
  }
}
const D = Prisma.Decimal.clone({ precision: 80, rounding: Prisma.Decimal.ROUND_HALF_UP });
@Injectable()
export class BccExchangeRateProvider {
  normalize(raw: unknown, now: Date) {
    const parsed = bccCandidateSchema.safeParse(raw);
    if (!parsed.success) throw new BccProviderError('BCC_FORMAT_INVALID');
    const v = parsed.data,
      today = new Date(now.getTime() + 3600000).toISOString().slice(0, 10);
    if (
      v.publicationDate > today ||
      (v.publishedAt &&
        (Date.parse(v.publishedAt) > now.getTime() + 30000 ||
          new Date(Date.parse(v.publishedAt) + 3600000).toISOString().slice(0, 10) <
            v.publicationDate))
    )
      throw new BccProviderError('BCC_DATE_INVALID');
    return {
      ...v,
      publishedAt: v.publishedAt ? new Date(v.publishedAt) : null,
      quotes: v.quotes.map((q) => {
        if (q.buy && q.sell && new D(q.buy).gt(q.sell))
          throw new BccProviderError('BCC_SPREAD_INVALID');
        if (q.buy && q.mean && q.sell && (new D(q.mean).lt(q.buy) || new D(q.mean).gt(q.sell)))
          throw new BccProviderError('BCC_SPREAD_INVALID');
        const norm = (value: string | null) =>
          value === null ? null : new D(value).div(q.unit).toFixed(18);
        return {
          currency: q.currency,
          unit: q.unit,
          unitEvidence: q.unitEvidence,
          rawBuy: q.buy,
          rawMean: q.mean,
          rawSell: q.sell,
          buy: norm(q.buy),
          mean: norm(q.mean),
          sell: norm(q.sell),
        };
      }),
    };
  }
  cross(source: string, destination: string): string {
    const result = new D(source).div(destination).toDecimalPlaces(12).toFixed(12);
    if (new D(result).lte(0) || new D(result).gte('1000000000000'))
      throw new BccProviderError('BCC_RATE_OUT_OF_RANGE');
    return result;
  }
}
