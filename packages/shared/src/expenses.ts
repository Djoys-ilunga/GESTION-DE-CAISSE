import { z } from 'zod';
import { amountSchema, currencySchema, positiveAmountSchema } from './money.js';
import { roleCodeSchema } from './auth.js';
import { supportingDocumentSchema } from './receipts.js';

export const expenseDetailsSchema = z
  .object({
    category: z.string().trim().min(1).max(80).optional(),
    beneficiary: z.string().trim().min(1).max(160),
    reference: z.string().trim().max(160),
    documents: z.array(supportingDocumentSchema).max(3),
  })
  .strict();
export type ExpenseDetails = z.infer<typeof expenseDetailsSchema>;
export const expenseLimitSchema = z
  .object({
    role: roleCodeSchema,
    action: z.enum(['REQUEST', 'APPROVE', 'PAY']),
    maximum: positiveAmountSchema,
  })
  .strict();
export const expensePolicyInputSchema = z
  .object({
    expectedVersion: z.number().int().positive().nullable(),
    requireEvidence: z.boolean(),
    limits: z.array(expenseLimitSchema).max(18),
  })
  .strict()
  .refine(
    (v) => new Set(v.limits.map((l) => `${l.role}:${l.action}`)).size === v.limits.length,
    'Plafond dupliqué.',
  );
export type ExpensePolicyInput = z.infer<typeof expensePolicyInputSchema>;
export const expensePolicySchema = z
  .object({
    currency: currencySchema,
    version: z.number().int().positive(),
    requireEvidence: z.boolean(),
    limits: z.array(expenseLimitSchema),
    configuredAt: z.iso.datetime(),
  })
  .strict();
export type ExpensePolicy = z.infer<typeof expensePolicySchema>;
export const expensePoliciesSchema = z.object({ items: z.array(expensePolicySchema) }).strict();
export const submitExpenseSchema = z
  .object({ expectedVersion: z.number().int().positive(), submitted: z.literal(true) })
  .strict();
export const decideExpenseSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    decision: z.enum(['APPROVE', 'REJECT']),
    reason: z.string().trim().max(500),
  })
  .strict()
  .refine((v) => v.decision !== 'REJECT' || v.reason.length >= 3, 'Motif de rejet obligatoire.');
export type DecideExpense = z.infer<typeof decideExpenseSchema>;
export const payExpenseSchema = z
  .object({ expectedVersion: z.number().int().positive(), paid: z.literal(true) })
  .strict();
export const expenseQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(10000).default(1),
    state: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'PAID', 'CANCELLED']).optional(),
    currency: currencySchema.optional(),
    cashRegisterId: z.uuid().optional(),
  })
  .strict();
export type ExpenseQuery = z.input<typeof expenseQuerySchema>;
const evidenceSchema = z
  .object({
    id: z.uuid(),
    fileName: z.string(),
    mimeType: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteLength: z.number().int().positive(),
  })
  .strict();
export const expenseViewSchema = z
  .object({
    id: z.uuid(),
    sourceDraftId: z.uuid().nullable(),
    clientDraftId: z.uuid().nullable(),
    agencyId: z.uuid(),
    cashRegisterId: z.uuid().nullable(),
    cashName: z.string().nullable(),
    agencyName: z.string(),
    requestedById: z.uuid(),
    requesterName: z.string(),
    currency: currencySchema,
    amount: amountSchema,
    description: z.string(),
    beneficiary: z.string().nullable(),
    reference: z.string().nullable(),
    state: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'PAID', 'CANCELLED']),
    version: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    approval: z
      .object({
        approverId: z.uuid(),
        approverName: z.string(),
        decision: z.enum(['APPROVE', 'REJECT']),
        reason: z.string().nullable(),
        createdAt: z.iso.datetime(),
      })
      .strict()
      .nullable(),
    reservation: z.enum(['ACTIVE', 'CONSUMED', 'RELEASED']).nullable(),
    evidence: z.array(evidenceSchema),
    voucher: z.object({ id: z.uuid(), number: z.string() }).strict().nullable(),
  })
  .strict();
export type ExpenseView = z.infer<typeof expenseViewSchema>;
export const expenseListSchema = z
  .object({
    items: z.array(expenseViewSchema),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
    synchronizedAt: z.iso.datetime(),
  })
  .strict();
export type ExpenseList = z.infer<typeof expenseListSchema>;
export const expenseDraftViewSchema = z
  .object({
    id: z.uuid(),
    clientDraftId: z.uuid(),
    agencyId: z.uuid(),
    cashRegisterId: z.uuid().nullable(),
    version: z.number().int().positive(),
    currency: currencySchema,
    amount: amountSchema,
    description: z.string(),
    beneficiary: z.string().nullable(),
    reference: z.string().nullable(),
    documentCount: z.number().int().nonnegative(),
    receivedAt: z.iso.datetime(),
    expenseRequestId: z.uuid().nullable(),
  })
  .strict();
export type ExpenseDraftView = z.infer<typeof expenseDraftViewSchema>;
export const expenseDraftListSchema = z
  .object({
    items: z.array(expenseDraftViewSchema),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
  })
  .strict();
export type ExpenseDraftList = z.infer<typeof expenseDraftListSchema>;
export const paymentVoucherSchema = z
  .object({
    id: z.uuid(),
    expenseRequestId: z.uuid(),
    operationId: z.uuid(),
    number: z.string(),
    currency: currencySchema,
    amount: amountSchema,
    beneficiary: z.string(),
    description: z.string(),
    reference: z.string(),
    companyName: z.string(),
    companyCode: z.string(),
    agencyName: z.string(),
    cashName: z.string(),
    requesterName: z.string(),
    approverName: z.string(),
    cashierName: z.string(),
    approvedAt: z.iso.datetime(),
    postedAt: z.iso.datetime(),
  })
  .strict();
export type PaymentVoucher = z.infer<typeof paymentVoucherSchema>;
