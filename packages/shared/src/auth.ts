import { z } from 'zod';
export const ROLE_LABELS = {
  ADMINISTRATOR: 'Administrateur',
  DIRECTOR: 'Directeur',
  FINANCE_MANAGER: 'Responsable financier',
  ACCOUNTANT: 'Comptable',
  CASHIER: 'Caissier',
  AUDITOR: 'Auditeur',
} as const;
export const roleCodeSchema = z.enum([
  'ADMINISTRATOR',
  'DIRECTOR',
  'FINANCE_MANAGER',
  'ACCOUNTANT',
  'CASHIER',
  'AUDITOR',
]);
export type RoleCode = z.infer<typeof roleCodeSchema>;
const read = ['directory:read', 'ledger:read'];
const drafts = ['draft:receive', 'draft:read_own', 'draft:write_own', 'offline:access'];
export const ROLE_PERMISSIONS: Record<RoleCode, readonly string[]> = {
  ADMINISTRATOR: [...read, 'users:manage', 'roles:assign', 'auth:logs:read'],
  DIRECTOR: [...read, 'expense:approve', 'auth:logs:read', 'offline:access'],
  FINANCE_MANAGER: [
    ...read,
    ...drafts,
    'receipt:post',
    'expense:request',
    'expense:approve',
    'expense:pay',
    'transfer:post',
    'fx:post',
    'ledger:reverse',
    'session:manage',
    'auth:logs:read',
  ],
  ACCOUNTANT: [
    ...read,
    ...drafts,
    'receipt:post',
    'expense:request',
    'transfer:post',
    'fx:post',
    'ledger:reverse',
  ],
  CASHIER: [...read, ...drafts, 'receipt:post', 'expense:request', 'expense:pay', 'session:manage'],
  AUDITOR: [...read, 'auth:logs:read', 'offline:access'],
};
export const loginSchema = z
  .object({
    email: z
      .email()
      .max(254)
      .transform((v) => v.trim().toLowerCase()),
    companyCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9][A-Z0-9-]{2,31}$/),
    password: z.string().min(1).max(128),
    deviceId: z.uuid(),
  })
  .strict();
export const newPasswordSchema = z.string().min(12).max(128);
export const accessAssignmentSchema = z
  .object({
    roles: z.array(roleCodeSchema).min(1).max(6),
    agencyIds: z.array(z.uuid()).max(200),
    cashRegisterIds: z.array(z.uuid()).max(500),
    active: z.boolean(),
  })
  .strict();
export const createUserSchema = z
  .object({
    email: z
      .email()
      .max(254)
      .transform((v) => v.trim().toLowerCase()),
    displayName: z.string().trim().min(2).max(160),
    initialPassword: newPasswordSchema,
    access: accessAssignmentSchema,
  })
  .strict();
export type AccessAssignment = z.infer<typeof accessAssignmentSchema>;
export const sessionProfileSchema = z
  .object({
    sessionId: z.uuid(),
    deviceId: z.uuid(),
    user: z
      .object({
        id: z.uuid(),
        displayName: z.string(),
        email: z.email(),
        mustChangePassword: z.boolean(),
      })
      .strict(),
    company: z.object({ id: z.uuid(), code: z.string(), name: z.string() }).strict(),
    roles: z.array(z.string()),
    permissions: z.array(z.string()),
    agencies: z.array(z.object({ id: z.uuid(), code: z.string(), name: z.string() }).strict()),
    cashRegisters: z.array(
      z.object({ id: z.uuid(), agencyId: z.uuid(), code: z.string(), name: z.string() }).strict(),
    ),
    expiresAt: z.iso.datetime(),
    idleExpiresAt: z.iso.datetime(),
    offlineUntil: z.iso.datetime().nullable(),
    validatedAt: z.iso.datetime(),
    locked: z.boolean(),
    authorizationVersion: z.number().int().positive(),
  })
  .strict();
export type SessionProfile = z.infer<typeof sessionProfileSchema>;
export type NativeSessionView = {
  state: 'anonymous' | 'locked' | 'online' | 'offline' | 'revalidating';
  profile: SessionProfile | null;
  displayName: string | null;
  offlineUntil: string | null;
  reason: string | null;
  generation: number;
};
export type ManagedUser = {
  id: string;
  memberId: string;
  email: string;
  displayName: string;
  active: boolean;
  roles: RoleCode[];
  agencyIds: string[];
  cashRegisterIds: string[];
  version: number;
};
export type AuthLog = {
  id: string;
  code: string;
  createdAt: string;
  actorId: string | null;
  subjectId: string | null;
  actorName: string | null;
  subjectName: string | null;
};

export const nativeSessionViewSchema = z
  .object({
    state: z.enum(['anonymous', 'locked', 'online', 'offline', 'revalidating']),
    profile: sessionProfileSchema.nullable(),
    displayName: z.string().nullable(),
    offlineUntil: z.iso.datetime().nullable(),
    reason: z.string().nullable(),
    generation: z.number().int().nonnegative(),
  })
  .strict();
