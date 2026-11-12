import { z } from 'zod';
import { currencySchema, positiveAmountSchema, monetaryDecimalSchema } from './money.js';
import { transferRateSchema } from './transfers.js';
export const bccQuoteKindSchema = z.enum(['BUY', 'MEAN', 'SELL']);
export type BccQuoteKind = z.infer<typeof bccQuoteKindSchema>;
export const exchangePolicyInputSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    allowManual: z.boolean(),
    quoteKind: bccQuoteKindSchema,
    maxAgeHours: z.number().int().min(1).max(168),
    quoteTtlMinutes: z.number().int().min(1).max(30),
    confirmed: z.literal(true),
  })
  .strict();
export const exchangePolicySchema = exchangePolicyInputSchema
  .omit({ expectedVersion: true, confirmed: true })
  .extend({ version: z.number().int().positive() })
  .strict();
export type ExchangePolicy = z.infer<typeof exchangePolicySchema>;
export const exchangeQuoteInputSchema = z
  .object({
    fromCurrency: currencySchema,
    toCurrency: currencySchema,
    amount: positiveAmountSchema,
    mode: z.enum(['BCC', 'MANUAL']),
    manualRate: transferRateSchema.optional(),
    manualSource: z.string().trim().min(3).max(100).optional(),
    justification: z.string().trim().min(3).max(500).optional(),
    manualEffectiveAt: z.iso.datetime().optional(),
    referencePublicationId: z.uuid().optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.fromCurrency === v.toCurrency)
      c.addIssue({ code: 'custom', message: 'Deux monnaies différentes sont requises.' });
    if (
      v.mode === 'MANUAL' &&
      (!v.manualRate || !v.manualSource || !v.justification || !v.manualEffectiveAt)
    )
      c.addIssue({
        code: 'custom',
        message: 'Taux, source, date et justification obligatoires pour un taux manuel.',
      });
    if (
      v.mode === 'BCC' &&
      (v.manualRate || v.manualSource || v.justification || v.manualEffectiveAt)
    )
      c.addIssue({
        code: 'custom',
        message: 'Un taux manuel ne peut pas être présenté comme BCC.',
      });
  });
export type ExchangeQuoteInput = z.infer<typeof exchangeQuoteInputSchema>;
export const exchangeQuoteSchema = z
  .object({
    id: z.uuid(),
    fromCurrency: currencySchema,
    toCurrency: currencySchema,
    amount: positiveAmountSchema,
    targetAmount: positiveAmountSchema,
    mode: z.enum(['BCC', 'MANUAL']),
    quoteKind: bccQuoteKindSchema,
    referenceRate: transferRateSchema.nullable(),
    appliedRate: transferRateSchema,
    source: z.string(),
    justification: z.string().nullable(),
    effectiveAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    publicationId: z.uuid().nullable(),
    policyVersion: z.number().int().positive(),
    snapshot: z.record(z.string(), z.unknown()),
  })
  .strict();
export type ExchangeQuote = z.infer<typeof exchangeQuoteSchema>;
export const bccPublicationSchema = z
  .object({
    id: z.uuid(),
    sourceUrl: z.url(),
    sourceReference: z.string(),
    publicationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    publishedAt: z.iso.datetime().nullable(),
    retrievedAt: z.iso.datetime(),
    contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
    connectorVersion: z.string(),
  })
  .strict();
export const bccQuotationSchema = z
  .object({
    currency: currencySchema,
    unit: z.enum(['1', '100']),
    unitEvidence: z.string(),
    rawBuy: z.string().nullable(),
    rawMean: z.string().nullable(),
    rawSell: z.string().nullable(),
    buy: z.string().nullable(),
    mean: z.string().nullable(),
    sell: z.string().nullable(),
  })
  .strict();
export type BccPublication = z.infer<typeof bccPublicationSchema>;
export const bccRatesSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    source: z
      .object({
        state: z.enum(['UNVERIFIED', 'READY', 'FETCHING', 'UNAVAILABLE']),
        code: z.string(),
        approved: z.boolean(),
        checkedAt: z.iso.datetime().nullable(),
        lastSuccessAt: z.iso.datetime().nullable(),
        nextAllowedAt: z.iso.datetime().nullable(),
        sourceUrl: z.url(),
      })
      .strict(),
    policy: exchangePolicySchema,
    publication: bccPublicationSchema.nullable(),
    quotes: z.array(bccQuotationSchema).max(300),
    currencies: z
      .array(
        z
          .object({
            code: currencySchema,
            name: z.string(),
            activeForCompany: z.boolean(),
            covered: z.boolean(),
          })
          .strict(),
      )
      .max(300),
    stale: z.boolean(),
    freshUntil: z.iso.datetime().nullable(),
  })
  .strict();
export type BccRates = z.infer<typeof bccRatesSchema>;
export const bccHistorySchema = z
  .object({
    items: z
      .array(bccPublicationSchema.extend({ quotes: z.array(bccQuotationSchema).max(300) }))
      .max(25),
    page: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    pageSize: z.literal(25),
  })
  .strict();
export type BccHistory = z.infer<typeof bccHistorySchema>;
// Kept separate from accounting balances: the simulator never posts to the ledger.
export const referenceMoneySchema = monetaryDecimalSchema;
