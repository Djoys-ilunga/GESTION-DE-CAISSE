import { z } from 'zod';
import {
  currencySchema,
  positiveAmountSchema,
  validCurrencyAmount,
  currencyPrecision,
} from './money.js';
import { receiptDetailsSchema } from './receipts.js';
import { expenseDetailsSchema } from './expenses.js';
export * from './auth.js';
export * from './money.js';
export * from './receipts.js';
export * from './expenses.js';
export * from './synchronization.js';
export const API_PROTOCOL_VERSION = 2 as const;
export const apiHealthSchema = z
  .object({
    service: z.literal('caissepro-api'),
    protocolVersion: z.literal(API_PROTOCOL_VERSION),
    deploymentId: z.string().min(1).max(100),
    status: z.literal('ready'),
  })
  .strict();
export type ApiHealth = z.infer<typeof apiHealthSchema>;
export const draftSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(['receipt', 'expense-request']),
    currency: currencySchema,
    amount: positiveAmountSchema,
    description: z.string().trim().min(1).max(500),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    receiptDetails: receiptDetailsSchema.optional(),
    expenseDetails: expenseDetailsSchema.optional(),
  })
  .strict()
  .refine((d) => {
    try {
      return validCurrencyAmount(d.amount, currencyPrecision(d.currency));
    } catch {
      return false;
    }
  }, 'Précision monétaire invalide.')
  .refine((d) => Date.parse(d.expiresAt) > Date.parse(d.createdAt), 'Expiration invalide.')
  .refine(
    (d) =>
      (!d.receiptDetails || d.kind === 'receipt') &&
      (!d.expenseDetails || d.kind === 'expense-request'),
    'Détails incompatibles.',
  );
export type Draft = z.infer<typeof draftSchema>;
export const draftSyncResultSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      draftId: z.uuid(),
      outcome: z.literal('accepted-as-draft'),
      code: z.literal('draft-received'),
      serverId: z.uuid().optional(),
      serverVersion: z.number().int().positive().optional(),
      synchronizedAt: z.iso.datetime().optional(),
      sourceState: z.enum(['draft', 'confirmed', 'submitted']).optional(),
      receiptId: z.uuid().nullable().optional(),
      expenseRequestId: z.uuid().nullable().optional(),
    })
    .strict(),
  z
    .object({
      draftId: z.uuid(),
      outcome: z.literal('rejected'),
      code: z.literal('validation-failed'),
    })
    .strict(),
  z
    .object({ draftId: z.uuid(), outcome: z.literal('conflict'), code: z.literal('conflict') })
    .strict(),
  z
    .object({
      draftId: z.uuid(),
      outcome: z.literal('deferred'),
      code: z.enum([
        'offline',
        'not-configured',
        'transport-error',
        'session-changed',
        'draft-expired',
        'local-version-conflict',
        'rate-limited',
      ]),
    })
    .strict(),
]);
export type DraftSyncResult = z.infer<typeof draftSyncResultSchema>;

export * from './transfers.js';
export * from './reports.js';
export * from './management.js';
