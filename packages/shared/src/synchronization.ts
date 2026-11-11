import { z } from 'zod';
export const syncStageSchema = z.enum([
  'local',
  'queued',
  'syncing',
  'synced',
  'conflict',
  'error',
]);
export const sourceStateSchema = z.enum(['draft', 'confirmed', 'submitted']);
export const syncRemoteSchema = z
  .object({
    serverId: z.uuid(),
    clientDraftId: z.uuid(),
    agencyId: z.uuid(),
    cashRegisterId: z.uuid().nullable(),
    kind: z.enum(['receipt', 'expense-request']),
    version: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    receivedAt: z.iso.datetime(),
    sourceState: sourceStateSchema,
    receiptId: z.uuid().nullable(),
    expenseRequestId: z.uuid().nullable(),
  })
  .strict();
export type SyncRemote = z.infer<typeof syncRemoteSchema>;
export const syncManifestSchema = z
  .object({
    items: z.array(syncRemoteSchema).max(50),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.literal(50),
  })
  .strict();
export type SyncManifest = z.infer<typeof syncManifestSchema>;
export const syncEventSchema = z
  .object({
    id: z.uuid(),
    attemptId: z.uuid(),
    clientDraftId: z.uuid(),
    version: z.number().int().positive(),
    stage: z.enum(['STARTED', 'SUCCESS', 'CONFLICT', 'ERROR']),
    code: z.enum([
      'started',
      'draft-received',
      'conflict',
      'validation-failed',
      'permission-denied',
      'expired',
      'interrupted',
    ]),
    serverId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
  })
  .strict();
export const syncEventsSchema = z
  .object({
    items: z.array(syncEventSchema).max(100),
    lastSuccessfulAt: z.iso.datetime().nullable(),
  })
  .strict();
export type SyncEvents = z.infer<typeof syncEventsSchema>;
export const syncStatusSchema = z
  .object({
    running: z.boolean(),
    apiOnline: z.boolean(),
    lastSuccessfulAt: z.iso.datetime().nullable(),
    cacheUpdatedAt: z.iso.datetime().nullable(),
    counts: z
      .object({
        local: z.number().int().nonnegative(),
        queued: z.number().int().nonnegative(),
        syncing: z.number().int().nonnegative(),
        synced: z.number().int().nonnegative(),
        conflict: z.number().int().nonnegative(),
        error: z.number().int().nonnegative(),
      })
      .strict(),
    persistence: z.literal('memory-only'),
    events: z
      .array(
        z
          .object({
            draftId: z.uuid(),
            version: z.number().int().positive(),
            code: z.string().max(60),
            at: z.iso.datetime(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export type SyncStatus = z.infer<typeof syncStatusSchema>;

export const formBufferInputSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(['receipt', 'expense-request', 'transfer']),
    agencyId: z.uuid(),
    cashRegisterId: z.uuid().nullable(),
    expectedLocalVersion: z.number().int().positive().nullable(),
    fields: z
      .object({
        destinationCashRegisterId: z.uuid().optional(),
        destinationCurrency: z.string().max(3).optional(),
        rate: z.string().max(25).optional(),
        rateSource: z.string().max(100).optional(),
        amount: z.string().max(21).optional(),
        currency: z.string().max(3).optional(),
        description: z.string().max(500).optional(),
        provenance: z.string().max(160).optional(),
        category: z.string().max(160).optional(),
        reference: z.string().max(160).optional(),
        beneficiary: z.string().max(160).optional(),
      })
      .strict(),
  })
  .strict();
export const formBufferSchema = formBufferInputSchema
  .extend({ createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), expiresAt: z.iso.datetime() })
  .strict();
export type FormBufferInput = z.infer<typeof formBufferInputSchema>;
export type FormBuffer = z.infer<typeof formBufferSchema>;
