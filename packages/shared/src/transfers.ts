import { z } from 'zod';
import {
  currencySchema,
  positiveAmountSchema,
  validCurrencyAmount,
  currencyPrecision,
} from './money.js';

// Units of destination currency for exactly one unit of source currency.
export const transferRateSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,12})?$/)
  .refine((s) => /[1-9]/.test(s));
export const transferDraftSchema = z
  .object({
    id: z.uuid(),
    sourceCashRegisterId: z.uuid(),
    destinationCashRegisterId: z.uuid(),
    sourceCurrency: currencySchema,
    destinationCurrency: currencySchema,
    amount: positiveAmountSchema,
    rate: transferRateSchema.nullable(),
    rateSource: z.string().trim().max(100),
    description: z.string().trim().min(1).max(500),
  })
  .strict()
  .superRefine((v, ctx) => {
    try {
      if (!validCurrencyAmount(v.amount, currencyPrecision(v.sourceCurrency)))
        ctx.addIssue({ code: 'custom', message: 'Précision du montant source invalide.' });
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Métadonnées monétaires requises.' });
    }
    if (v.sourceCurrency === v.destinationCurrency) {
      if (
        v.sourceCashRegisterId === v.destinationCashRegisterId ||
        v.rate !== null ||
        v.rateSource !== ''
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Deux caisses distinctes et aucun taux pour un transfert de même devise.',
        });
    } else if (!v.rate || !v.rateSource) {
      ctx.addIssue({ code: 'custom', message: 'Taux explicite et source du taux requis.' });
    }
  });
export type TransferDraft = z.infer<typeof transferDraftSchema>;
export const handoverTransferSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    handedOver: z.literal(true),
    rateValidated: z.boolean(),
  })
  .strict();
export const receiveTransferSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    received: z.literal(true),
  })
  .strict();
export const transferSlipSchema = z
  .object({
    number: z.string(),
    companyName: z.string(),
    companyCode: z.string(),
    sourceCashName: z.string(),
    destinationCashName: z.string(),
    sourceAgencyName: z.string(),
    destinationAgencyName: z.string(),
    handedOverByName: z.string(),
    receivedByName: z.string(),
    handedOverAt: z.iso.datetime(),
    receivedAt: z.iso.datetime(),
    rounding: z.enum(['HALF_UP_0', 'HALF_UP_1', 'HALF_UP_2', 'HALF_UP_3', 'HALF_UP_4']),
  })
  .strict();
export const transferViewSchema = z
  .object({
    id: z.uuid(),
    authorId: z.uuid(),
    sourceCashRegisterId: z.uuid(),
    destinationCashRegisterId: z.uuid(),
    sourceCurrency: currencySchema,
    destinationCurrency: currencySchema,
    amount: positiveAmountSchema,
    targetAmount: positiveAmountSchema,
    rate: transferRateSchema.nullable(),
    rateSource: z.string(),
    description: z.string(),
    state: z.enum(['DRAFT', 'HANDED_OVER', 'RECEIVED']),
    version: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    handedOverAt: z.iso.datetime().nullable(),
    receivedAt: z.iso.datetime().nullable(),
    handedOverById: z.uuid().nullable(),
    receivedById: z.uuid().nullable(),
    operationId: z.uuid().nullable(),
    slip: transferSlipSchema.nullable(),
  })
  .strict();
export type TransferView = z.infer<typeof transferViewSchema>;
export const transferListSchema = z
  .object({
    items: z.array(transferViewSchema).max(25),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.literal(25),
  })
  .strict();
