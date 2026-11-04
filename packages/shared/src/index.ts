import { z } from 'zod';
export * from './auth.js';
export const API_PROTOCOL_VERSION = 1 as const;
export const apiHealthSchema = z
  .object({
    service: z.literal('caissepro-api'),
    protocolVersion: z.literal(API_PROTOCOL_VERSION),
    deploymentId: z.string().min(1).max(100),
    status: z.literal('ready'),
  })
  .strict();
export type ApiHealth = z.infer<typeof apiHealthSchema>;
export const currencySchema = z.enum(['CDF', 'USD']);
export type Currency = z.infer<typeof currencySchema>;
export const amountSchema = z.string().regex(/^(?:0|[1-9]\d{0,15})\.\d{2}$/);
export const positiveAmountSchema = amountSchema.refine((v) => v !== '0.00');
export const draftSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(['receipt', 'expense-request']),
    currency: currencySchema,
    amount: positiveAmountSchema,
    description: z.string().trim().min(1).max(500),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .strict()
  .refine((d) => Date.parse(d.expiresAt) > Date.parse(d.createdAt), 'Expiration invalide.');
export type Draft = z.infer<typeof draftSchema>;
export const draftSyncResultSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      draftId: z.uuid(),
      outcome: z.literal('accepted-as-draft'),
      code: z.literal('draft-received'),
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
      ]),
    })
    .strict(),
]);
export type DraftSyncResult = z.infer<typeof draftSyncResultSchema>;
