import { z } from 'zod';
import { currencySchema } from './money.js';
const label = z.string().trim().min(2).max(160);
const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9_-]{0,39}$/);
const companySettingsFields = z
  .object({
    expectedVersion: z.number().int().positive(),
    name: label,
    address: z.string().trim().max(300),
    phone: z.string().trim().max(60),
    email: z.union([z.literal(''), z.email().max(254)]),
    taxId: z.string().trim().max(100),
    sessionMinutes: z.number().int().min(15).max(480),
    idleMinutes: z.number().int().min(1).max(15),
    offlineMinutes: z.number().int().min(0).max(15),
    confirmed: z.literal(true),
  })
  .strict();
export const companySettingsInputSchema = companySettingsFields.refine(
  (v) => v.idleMinutes <= v.sessionMinutes && v.offlineMinutes <= v.idleMinutes,
  'Durées incompatibles.',
);
export const companySettingsSchema = companySettingsFields
  .omit({ expectedVersion: true, confirmed: true })
  .extend({
    id: z.uuid(),
    code: z.string(),
    version: z.number().int().positive(),
  })
  .strict();
export type CompanySettings = z.infer<typeof companySettingsSchema>;
export type CompanySettingsInput = z.infer<typeof companySettingsInputSchema>;
export const agencySettingsInputSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    name: label,
    active: z.boolean(),
    confirmed: z.literal(true),
  })
  .strict();
export const categoryInputSchema = z
  .object({
    id: z.uuid(),
    expectedVersion: z.number().int().positive().nullable(),
    code,
    name: z.string().trim().min(1).max(80),
    kind: z.enum(['RECEIPT', 'EXPENSE']),
    active: z.boolean(),
    confirmed: z.literal(true),
  })
  .strict();
export const categorySchema = categoryInputSchema
  .omit({ expectedVersion: true, confirmed: true })
  .extend({ version: z.number().int().positive() })
  .strict();
export type FinancialCategory = z.infer<typeof categorySchema>;
const referenceRateFields = z
  .object({
    id: z.uuid(),
    fromCurrency: currencySchema,
    toCurrency: currencySchema,
    rate: z
      .string()
      .regex(/^(?:0|[1-9]\d{0,11})\.\d{1,12}$/)
      .refine((v) => /[1-9]/.test(v)),
    source: z.string().trim().min(3).max(100),
    validFrom: z.iso.datetime(),
    confirmed: z.literal(true),
  })
  .strict();
export const referenceRateInputSchema = referenceRateFields.refine(
  (v) => v.fromCurrency !== v.toCurrency,
  'Les devises doivent être différentes.',
);
export const referenceRateSchema = referenceRateFields
  .omit({ confirmed: true })
  .extend({ publishedAt: z.iso.datetime() })
  .strict();
export type ReferenceRate = z.infer<typeof referenceRateSchema>;
export const referenceDataSchema = z
  .object({
    categories: z.array(categorySchema),
    rates: z.array(referenceRateSchema),
    generatedAt: z.iso.datetime(),
  })
  .strict();
export type ReferenceData = z.infer<typeof referenceDataSchema>;
export const managementSettingsSchema = z
  .object({
    company: companySettingsSchema,
    agencies: z.array(
      z
        .object({
          id: z.uuid(),
          code: z.string(),
          name: z.string(),
          active: z.boolean(),
          version: z.number().int().positive(),
        })
        .strict(),
    ),
    categories: z.array(categorySchema),
    rates: z.array(referenceRateSchema),
    generatedAt: z.iso.datetime(),
  })
  .strict();
export type ManagementSettings = z.infer<typeof managementSettingsSchema>;
export const supervisionSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    cash: z.array(
      z
        .object({
          id: z.uuid(),
          name: z.string(),
          agencyName: z.string(),
          active: z.boolean(),
          openedAt: z.iso.datetime().nullable(),
        })
        .strict(),
    ),
    users: z
      .array(
        z
          .object({
            id: z.uuid(),
            name: z.string(),
            active: z.boolean(),
            validSessions: z.number().int().nonnegative(),
            lastSeenAt: z.iso.datetime().nullable(),
          })
          .strict(),
      )
      .nullable(),
    notifications: z
      .array(
        z
          .object({
            id: z.string(),
            title: z.string(),
            message: z.string(),
            severity: z.enum(['info', 'warning']),
            target: z.enum(['expenses', 'transfers', 'reports']),
            createdAt: z.iso.datetime(),
          })
          .strict(),
      )
      .max(20),
    notificationTotal: z.number().int().nonnegative(),
  })
  .strict();
export type Supervision = z.infer<typeof supervisionSchema>;
export const auditQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(10000).default(1),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    action: z
      .string()
      .regex(/^[A-Z_]{1,60}$/)
      .optional(),
    actorId: z.uuid().optional(),
    cashRegisterId: z.uuid().optional(),
  })
  .strict()
  .refine((v) => !v.from || !v.to || v.from <= v.to, 'Dates incompatibles.');
export type AuditQuery = z.input<typeof auditQuerySchema>;
export const auditPageSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    page: z.number().int().positive(),
    pageSize: z.literal(50),
    total: z.number().int().nonnegative(),
    items: z.array(
      z
        .object({
          id: z.uuid(),
          action: z.string(),
          targetType: z.string(),
          targetId: z.uuid(),
          actorName: z.string(),
          createdAt: z.iso.datetime(),
        })
        .strict(),
    ),
  })
  .strict();
export type AuditPage = z.infer<typeof auditPageSchema>;

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  OPERATION_POSTED: 'Opération comptabilisée',
  EXPENSE_REQUESTED: 'Dépense demandée',
  EXPENSE_APPROVED: 'Dépense approuvée',
  EXPENSE_REJECTED: 'Dépense rejetée',
  DRAFT_RECEIVED: 'Brouillon reçu',
  CASH_CONFIGURED: 'Caisse configurée',
  AGENCY_CONFIGURED: 'Agence configurée',
  EXPENSE_POLICY_CONFIGURED: 'Seuils d’approbation modifiés',
  EXPENSE_PAYMENT_CONFIRMED: 'Paiement de dépense confirmé',
  COMPANY_CONFIGURED: 'Entreprise modifiée',
  CATEGORY_CONFIGURED: 'Catégorie modifiée',
  REFERENCE_RATE_PUBLISHED: 'Taux de référence publié',
  SESSION_POLICY_CONFIGURED: 'Politique de session modifiée',
  CASH_SESSION_CLOSED: 'Session de caisse clôturée',
  CASH_SESSION_OPENED: 'Session de caisse ouverte',
  TRANSFER_DRAFT_RECEIVED: 'Brouillon de transfert reçu',
  TRANSFER_HANDED_OVER: 'Fonds de transfert remis',
  TRANSFER_RECEIVED: 'Fonds de transfert reçus et comptabilisés',
};
export const AUDIT_TARGET_LABELS: Record<string, string> = {
  OPERATION: 'Opération',
  EXPENSE: 'Dépense',
  DRAFT: 'Brouillon',
  CASH: 'Caisse',
  AGENCY: 'Agence',
  COMPANY: 'Entreprise',
  CATEGORY: 'Catégorie',
  RATE: 'Taux',
  CLOSURE: 'Procès-verbal',
  TRANSFER: 'Transfert',
};
