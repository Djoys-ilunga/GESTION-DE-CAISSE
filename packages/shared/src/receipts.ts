import { z } from 'zod';
import { amountSchema, currencySchema } from './money.js';
export const MAX_EVIDENCE_BYTES = 1024 * 1024;
export const supportingDocumentSchema = z
  .object({
    fileName: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .refine((v) => !/\p{Cc}/u.test(v) && !v.includes('/') && !v.includes('\\')),
    mimeType: z.enum(['application/pdf', 'image/png', 'image/jpeg']),
    dataBase64: z
      .string()
      .min(4)
      .max(1398104)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  })
  .strict();
export const receiptDetailsSchema = z
  .object({
    provenance: z.string().trim().min(1).max(160),
    category: z.string().trim().min(1).max(80),
    reference: z.string().trim().max(160),
    supportingDocument: supportingDocumentSchema.nullable(),
  })
  .strict();
export type ReceiptDetails = z.infer<typeof receiptDetailsSchema>;
export type CreateAgency = z.infer<typeof createAgencySchema>;
export type CreateCash = z.infer<typeof createCashSchema>;
export type UpdateCash = z.infer<typeof updateCashSchema>;
export type SupportingDocument = z.infer<typeof supportingDocumentSchema>;
const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9_-]{0,39}$/);
export const createAgencySchema = z
  .object({ id: z.uuid(), code, name: z.string().trim().min(2).max(160) })
  .strict();
export const createCashSchema = z
  .object({
    id: z.uuid(),
    agencyId: z.uuid(),
    code,
    name: z.string().trim().min(2).max(160),
    authorizedUserIds: z.array(z.uuid()).max(200),
  })
  .strict();
export const updateCashSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    name: z.string().trim().min(2).max(160),
    active: z.boolean(),
  })
  .strict();
export const confirmReceiptSchema = z
  .object({ expectedVersion: z.number().int().positive(), received: z.literal(true) })
  .strict();
export const receiptQuerySchema = z
  .object({
    cashRegisterId: z.uuid().optional(),
    currency: currencySchema.optional(),
    category: z.string().trim().max(80).optional(),
    search: z.string().trim().max(160).optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    page: z.coerce.number().int().min(1).max(10000).default(1),
  })
  .strict()
  .refine((v) => !v.from || !v.to || v.from <= v.to, 'Période invalide.');
export type ReceiptQuery = z.input<typeof receiptQuerySchema>;
const agencyView = z.object({ id: z.uuid(), code: z.string(), name: z.string() }).strict();
const balanceSchema = z
  .string()
  .max(128)
  .regex(/^(?:0|[1-9]\d*)\.\d{2}$/);
export const cashViewSchema = z
  .object({
    id: z.uuid(),
    code: z.string(),
    name: z.string(),
    active: z.boolean(),
    version: z.number().int().positive(),
    agency: agencyView,
    session: z.object({ id: z.uuid(), openedAt: z.iso.datetime() }).strict().nullable(),
    funds: z.array(
      z
        .object({
          currency: currencySchema,
          balance: balanceSchema,
          reserved: balanceSchema,
          available: balanceSchema,
        })
        .strict(),
    ),
  })
  .strict();
export const cashSnapshotSchema = z
  .object({
    data: z
      .object({
        items: z.array(cashViewSchema),
        synchronizedAt: z.iso.datetime(),
        expiresAt: z.iso.datetime().nullable(),
      })
      .strict(),
    stale: z.boolean(),
  })
  .strict();
export type CashSnapshot = z.infer<typeof cashSnapshotSchema>;
export type CashView = z.infer<typeof cashViewSchema>;
export const cashConfigurationSchema = z
  .object({
    agencies: z.array(agencyView),
    registers: z.array(
      z
        .object({
          id: z.uuid(),
          agencyId: z.uuid(),
          code: z.string(),
          name: z.string(),
          active: z.boolean(),
          version: z.number().int().positive(),
        })
        .strict(),
    ),
    users: z.array(z.object({ id: z.uuid(), displayName: z.string(), email: z.email() }).strict()),
  })
  .strict();
export type CashConfiguration = z.infer<typeof cashConfigurationSchema>;
export const confirmedReceiptSchema = z
  .object({
    id: z.uuid(),
    number: z.string().min(1),
    operationId: z.uuid(),
    clientDraftId: z.uuid(),
    sourceDraftId: z.uuid(),
    version: z.number().int().positive(),
    cashRegisterId: z.uuid(),
    agencyId: z.uuid(),
    currency: currencySchema,
    amount: amountSchema,
    provenance: z.string(),
    category: z.string(),
    description: z.string(),
    reference: z.string(),
    companyName: z.string(),
    companyCode: z.string(),
    agencyName: z.string(),
    agencyCode: z.string(),
    cashName: z.string(),
    cashCode: z.string(),
    cashierName: z.string(),
    postedAt: z.iso.datetime(),
    evidence: z
      .object({
        fileName: z.string(),
        mimeType: z.string(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        byteLength: z.number().int().positive(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type ConfirmedReceipt = z.infer<typeof confirmedReceiptSchema>;
export const receiptHistorySchema = z
  .object({
    items: z.array(confirmedReceiptSchema),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
    synchronizedAt: z.iso.datetime(),
  })
  .strict();
export type ReceiptHistory = z.infer<typeof receiptHistorySchema>;
export const serverReceiptDraftSchema = z
  .object({
    id: z.uuid(),
    clientDraftId: z.uuid(),
    agencyId: z.uuid(),
    cashRegisterId: z.uuid(),
    version: z.number().int().positive(),
    currency: currencySchema,
    amount: amountSchema,
    description: z.string(),
    provenance: z.string().nullable(),
    category: z.string().nullable(),
    reference: z.string().nullable(),
    hasEvidence: z.boolean(),
    receivedAt: z.iso.datetime(),
    receiptId: z.uuid().nullable(),
    receiptNumber: z.string().nullable(),
  })
  .strict();
export const receiptDraftListSchema = z
  .object({
    items: z.array(serverReceiptDraftSchema),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
  })
  .strict();
export type ServerReceiptDraft = z.infer<typeof serverReceiptDraftSchema>;
export type ReceiptDraftList = z.infer<typeof receiptDraftListSchema>;
