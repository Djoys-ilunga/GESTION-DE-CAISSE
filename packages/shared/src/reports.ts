import { z } from 'zod';
import { currencySchema, amountSchema, monetaryDecimalSchema } from './money.js';
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v);
export const reportQuerySchema = z
  .object({
    period: z.enum(['day', 'week', 'month', 'year', 'custom']).default('month'),
    date: date.optional(),
    from: date.optional(),
    to: date.optional(),
    agencyId: z.uuid().optional(),
    cashRegisterId: z.uuid().optional(),
    userId: z.uuid().optional(),
    category: z.string().max(80).optional(),
    kind: z.enum(['RECEIPT', 'DISBURSEMENT', 'TRANSFER', 'FX', 'REVERSAL']).optional(),
  })
  .strict();
export type ReportQuery = z.input<typeof reportQuerySchema>;
const decimal = monetaryDecimalSchema;
const totals = z
  .object({
    currency: currencySchema,
    balance: decimal,
    reserved: decimal,
    available: decimal,
    receipts: decimal,
    disbursements: decimal,
    opening: decimal,
    closing: decimal,
    todayReceipts: decimal,
    todayDisbursements: decimal,
  })
  .strict();
export const reportRowSchema = z
  .object({
    id: z.uuid(),
    operationId: z.uuid(),
    postedAt: z.iso.datetime(),
    kind: z.enum(['RECEIPT', 'DISBURSEMENT', 'TRANSFER', 'FX', 'REVERSAL']),
    cashRegisterId: z.uuid(),
    cashName: z.string(),
    agencyId: z.uuid(),
    agencyName: z.string(),
    userId: z.uuid(),
    userName: z.string(),
    currency: currencySchema,
    side: z.enum(['DEBIT', 'CREDIT']),
    amount: amountSchema,
    category: z.string(),
    reference: z.string(),
  })
  .strict();
export const closureViewSchema = z
  .object({
    id: z.uuid(),
    cashRegisterId: z.uuid(),
    cashName: z.string(),
    closedAt: z.iso.datetime(),
    closedBy: z.string(),
    number: z.string(),
    counts: z
      .array(
        z
          .object({
            currency: currencySchema,
            book: decimal,
            counted: amountSchema,
            difference: decimal,
          })
          .strict(),
      )
      .min(1)
      .max(300),
  })
  .strict();
export const reportSnapshotSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    company: z
      .object({
        name: z.string(),
        code: z.string(),
        address: z.string().optional(),
        phone: z.string().optional(),
        email: z.string().optional(),
        taxId: z.string().optional(),
      })
      .strict(),
    timezone: z.literal('Africa/Kinshasa'),
    from: date,
    to: date,
    query: reportQuerySchema,
    totals: z.array(totals).min(0).max(300),
    cash: z.array(
      z
        .object({
          id: z.uuid(),
          name: z.string(),
          agencyId: z.uuid(),
          agencyName: z.string(),
          currency: currencySchema,
          balance: decimal,
          reserved: decimal,
          available: decimal,
        })
        .strict(),
    ),
    daily: z
      .array(z.object({ date: date, currency: currencySchema, balance: decimal }).strict())
      .max(109800),
    rows: z.array(reportRowSchema).max(10000),
    groups: z.array(
      z
        .object({
          dimension: z.enum(['category', 'agency', 'user']),
          name: z.string(),
          currency: currencySchema,
          incoming: decimal,
          outgoing: decimal,
        })
        .strict(),
    ),
    pending: z.array(
      z
        .object({
          currency: currencySchema,
          count: z.number().int().nonnegative(),
          amount: decimal,
        })
        .strict(),
    ),
    decisions: z
      .array(
        z
          .object({
            id: z.uuid(),
            state: z.enum(['APPROVE', 'REJECT']),
            requestState: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'PAID', 'CANCELLED']),
            reason: z.string().nullable(),
            currency: currencySchema,
            amount: amountSchema,
            description: z.string(),
            requester: z.string(),
            approver: z.string().nullable(),
            decidedAt: z.iso.datetime().nullable(),
          })
          .strict(),
      )
      .max(10000),
    closures: z.array(closureViewSchema).max(1000),
    discrepancies: z
      .array(
        z
          .object({
            currency: currencySchema,
            measured: z.number().int().nonnegative(),
            count: z.number().int().nonnegative(),
            net: decimal.nullable(),
          })
          .strict(),
      )
      .min(0)
      .max(300),
    unmeasuredClosures: z.number().int().nonnegative(),
    users: z.array(z.object({ id: z.uuid(), name: z.string() }).strict()),
  })
  .strict();
export type ReportSnapshot = z.infer<typeof reportSnapshotSchema>;
const closeIdentity = { cashRegisterId: z.uuid(), sessionId: z.uuid(), confirmed: z.literal(true) };
export const closeCashSchema = z.union([
  z
    .object({
      ...closeIdentity,
      counts: z
        .array(z.object({ currency: currencySchema, amount: amountSchema }).strict())
        .min(1)
        .max(300),
    })
    .strict()
    .refine((v) => new Set(v.counts.map((c) => c.currency)).size === v.counts.length),
  z.object({ ...closeIdentity, countedUSD: amountSchema, countedCDF: amountSchema }).strict(),
]);
export type CloseCash = z.infer<typeof closeCashSchema>;
export const reportFileSchema = z
  .object({
    fileName: z.string().regex(/^CaissePro-[A-Za-z0-9-]+\.(pdf|xlsx)$/),
    mimeType: z.enum([
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ]),
    dataBase64: z.string().max(1800000),
  })
  .strict();

export const valuationInputSchema = z
  .object({
    query: reportQuerySchema,
    currency: currencySchema,
    rates: z.array(z.object({ currency: currencySchema, rateId: z.uuid() }).strict()).max(300),
    confirmed: z.literal(true),
  })
  .strict()
  .refine((v) => new Set(v.rates.map((r) => r.currency)).size === v.rates.length);
export type ValuationInput = z.infer<typeof valuationInputSchema>;
export const valuationSchema = z
  .object({
    currency: currencySchema,
    asOf: z.iso.datetime(),
    accounting: z.literal(false),
    rounding: z.literal('HALF_UP_BY_CURRENCY'),
    totalBalance: monetaryDecimalSchema,
    items: z
      .array(
        z
          .object({
            currency: currencySchema,
            originalBalance: monetaryDecimalSchema,
            equivalent: monetaryDecimalSchema,
            rateId: z.uuid().nullable(),
            rate: z.string(),
            source: z.string(),
            validFrom: z.iso.datetime().nullable(),
          })
          .strict(),
      )
      .max(300),
  })
  .strict();
export type Valuation = z.infer<typeof valuationSchema>;
