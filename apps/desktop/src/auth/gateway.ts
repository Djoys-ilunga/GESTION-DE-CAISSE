import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  nativeSessionViewSchema,
  expensePoliciesSchema,
  expensePolicySchema,
  expenseDraftListSchema,
  expenseListSchema,
  expenseViewSchema,
  paymentVoucherSchema,
  type ExpensePolicy,
  type ExpensePolicyInput,
  type ExpenseDraftList,
  type ExpenseList,
  type ExpenseView,
  type ExpenseQuery,
  type DecideExpense,
  type PaymentVoucher,
  type NativeSessionView,
  type Draft,
  type ManagedUser,
  type AccessAssignment,
  type AuthLog,
  type DraftSyncResult,
  type RoleCode,
  cashSnapshotSchema,
  cashConfigurationSchema,
  confirmedReceiptSchema,
  receiptHistorySchema,
  receiptDraftListSchema,
  supportingDocumentSchema,
  type CashSnapshot,
  type CashConfiguration,
  type ConfirmedReceipt,
  type ReceiptHistory,
  type ReceiptDraftList,
  type ReceiptQuery,
  type SupportingDocument,
  type CreateCash,
  type CreateAgency,
  type UpdateCash,
} from '@caissepro/shared';
export type SessionDraft = {
  draft: Draft;
  agencyId: string;
  cashRegisterId: string | null;
  version: number;
  serverVersion: number | null;
  state: string;
  result: DraftSyncResult | null;
  updatedAt: string;
  confirmedReceiptId?: string | null;
  receiptNumber?: string | null;
  submittedExpenseId?: string | null;
};
export type DraftInput = {
  draft: Draft;
  agencyId: string;
  cashRegisterId: string | null;
  expectedVersion: number | null;
};
export type Balances = {
  data: {
    synchronizedAt: string;
    expiresAt: string | null;
    balances: {
      accountId: string;
      cashRegisterId: string;
      currency: 'CDF' | 'USD';
      balance: string;
      reserved: string;
      available: string;
    }[];
  };
  stale: boolean;
};
export type AccessCatalog = {
  roles: Record<RoleCode, string[]>;
  agencies: { id: string; name: string; code: string }[];
  cashRegisters: { id: string; agencyId: string; name: string; code: string }[];
};
export interface AuthGateway {
  expensePolicies(): Promise<{ items: ExpensePolicy[] }>;
  configureExpensePolicy(
    currency: 'CDF' | 'USD',
    input: ExpensePolicyInput,
  ): Promise<ExpensePolicy>;
  expenseDrafts(page?: number): Promise<ExpenseDraftList>;
  restoreExpenseDraft(id: string): Promise<SessionDraft>;
  submitExpense(id: string, expectedVersion: number, submitted: true): Promise<ExpenseView>;
  expenseList(query?: ExpenseQuery): Promise<ExpenseList>;
  expenseDetail(id: string): Promise<ExpenseView>;
  decideExpense(id: string, input: DecideExpense): Promise<ExpenseView>;
  payExpense(id: string, expectedVersion: number, paid: true): Promise<PaymentVoucher>;
  paymentVoucher(id: string): Promise<PaymentVoucher>;
  expenseEvidence(id: string, evidenceId: string): Promise<SupportingDocument>;
  cashCatalog(): Promise<CashSnapshot>;
  cashConfiguration(): Promise<CashConfiguration>;
  createAgency(input: CreateAgency): Promise<{ id: string }>;
  createCash(input: CreateCash): Promise<{ id: string }>;
  updateCash(id: string, input: UpdateCash): Promise<{ id: string }>;
  openCashSession(id: string): Promise<{ id: string }>;
  receiptDrafts(page?: number): Promise<ReceiptDraftList>;
  restoreReceiptDraft(id: string): Promise<SessionDraft>;
  confirmReceipt(id: string, expectedVersion: number, received: true): Promise<ConfirmedReceipt>;
  receiptHistory(query?: ReceiptQuery): Promise<ReceiptHistory>;
  receipt(id: string): Promise<ConfirmedReceipt>;
  receiptEvidence(id: string): Promise<SupportingDocument>;
  available: boolean;
  health(): Promise<boolean>;
  status(): Promise<NativeSessionView>;
  login(companyCode: string, email: string, password: string): Promise<NativeSessionView>;
  logout(): Promise<NativeSessionView>;
  lock(): Promise<NativeSessionView>;
  unlock(password: string): Promise<NativeSessionView>;
  revalidate(): Promise<NativeSessionView>;
  activity(): Promise<NativeSessionView>;
  changePassword(currentPassword: string, newPassword: string): Promise<NativeSessionView>;
  balances(): Promise<Balances>;
  drafts(): Promise<SessionDraft[]>;
  saveDraft(input: DraftInput): Promise<SessionDraft>;
  synchronize(): Promise<DraftSyncResult[]>;
  users(): Promise<ManagedUser[]>;
  catalog(): Promise<AccessCatalog>;
  createUser(input: {
    email: string;
    displayName: string;
    initialPassword: string;
    access: AccessAssignment;
  }): Promise<ManagedUser>;
  assignUser(
    userId: string,
    access: AccessAssignment,
    expectedVersion: number,
  ): Promise<ManagedUser>;
  logs(): Promise<AuthLog[]>;
}
export class NativeAuthGateway implements AuthGateway {
  private expenseCall(action: string, payload?: unknown) {
    return this.call('expense_action', { action, payload });
  }
  async expensePolicies() {
    return expensePoliciesSchema.parse(await this.expenseCall('policies'));
  }
  async configureExpensePolicy(currency: 'CDF' | 'USD', input: ExpensePolicyInput) {
    return expensePolicySchema.parse(
      await this.expenseCall('configure', { currency, data: input }),
    );
  }
  async expenseDrafts(page = 1) {
    return expenseDraftListSchema.parse(await this.expenseCall('drafts', { page }));
  }
  restoreExpenseDraft(id: string) {
    return this.expenseCall('restore', { id }) as Promise<SessionDraft>;
  }
  async submitExpense(id: string, expectedVersion: number, submitted: true) {
    return expenseViewSchema.parse(
      await this.expenseCall('submit', { id, expectedVersion, submitted }),
    );
  }
  async expenseList(query: ExpenseQuery = {}) {
    return expenseListSchema.parse(await this.expenseCall('list', query));
  }
  async expenseDetail(id: string) {
    return expenseViewSchema.parse(await this.expenseCall('detail', { id }));
  }
  async decideExpense(id: string, input: DecideExpense) {
    return expenseViewSchema.parse(await this.expenseCall('decide', { id, data: input }));
  }
  async payExpense(id: string, expectedVersion: number, paid: true) {
    return paymentVoucherSchema.parse(await this.expenseCall('pay', { id, expectedVersion, paid }));
  }
  async paymentVoucher(id: string) {
    return paymentVoucherSchema.parse(await this.expenseCall('voucher', { id }));
  }
  async expenseEvidence(id: string, evidenceId: string) {
    return supportingDocumentSchema.parse(await this.expenseCall('evidence', { id, evidenceId }));
  }
  private cashCall<T>(action: string, payload?: unknown): Promise<T> {
    return this.call<T>('cash_action', { action, payload });
  }
  async cashCatalog() {
    return cashSnapshotSchema.parse(await this.call('cash_catalog'));
  }
  async cashConfiguration() {
    return cashConfigurationSchema.parse(await this.cashCall('configuration'));
  }
  createAgency(input: CreateAgency) {
    return this.cashCall<{ id: string }>('create-agency', input);
  }
  createCash(input: CreateCash) {
    return this.cashCall<{ id: string }>('create', input);
  }
  updateCash(id: string, input: UpdateCash) {
    return this.cashCall<{ id: string }>('update', { id, data: input });
  }
  openCashSession(id: string) {
    return this.cashCall<{ id: string }>('open', { id });
  }
  async receiptDrafts(page = 1) {
    return receiptDraftListSchema.parse(await this.cashCall('pending', { page }));
  }
  restoreReceiptDraft(id: string) {
    return this.cashCall<SessionDraft>('restore', { id });
  }
  async confirmReceipt(id: string, expectedVersion: number, received: true) {
    return confirmedReceiptSchema.parse(
      await this.cashCall('confirm', { id, expectedVersion, received }),
    );
  }
  async receiptHistory(query: ReceiptQuery = {}) {
    return receiptHistorySchema.parse(await this.cashCall('history', query));
  }
  async receipt(id: string) {
    return confirmedReceiptSchema.parse(await this.cashCall('receipt', { id }));
  }
  async receiptEvidence(id: string) {
    return supportingDocumentSchema.parse(await this.cashCall('evidence', { id }));
  }
  readonly available = isTauri();
  private generation = 0;
  private async call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    if (!this.available) throw new Error('DESKTOP_REQUIRED');
    return invoke<T>(command, {
      ...args,
      ...(['auth_health', 'auth_login', 'auth_status'].includes(command)
        ? {}
        : { expectedGeneration: this.generation }),
    });
  }
  private async view(command: string, args?: Record<string, unknown>) {
    const view = nativeSessionViewSchema.parse(await this.call(command, args));
    this.generation = Math.max(this.generation, view.generation);
    return view;
  }
  async health() {
    try {
      await this.call('auth_health');
      return true;
    } catch {
      return false;
    }
  }
  status() {
    return this.view('auth_status');
  }
  login(companyCode: string, email: string, password: string) {
    return this.view('auth_login', { companyCode, email, password });
  }
  logout() {
    return this.view('auth_logout');
  }
  lock() {
    return this.view('auth_lock');
  }
  unlock(password: string) {
    return this.view('auth_unlock', { password });
  }
  revalidate() {
    return this.view('auth_revalidate');
  }
  activity() {
    return this.view('auth_activity');
  }
  changePassword(currentPassword: string, newPassword: string) {
    return this.view('auth_password', { currentPassword, newPassword });
  }
  balances() {
    return this.call<Balances>('workspace_balances');
  }
  drafts() {
    return this.call<SessionDraft[]>('workspace_drafts');
  }
  saveDraft(input: DraftInput) {
    return this.call<SessionDraft>('workspace_save_draft', { input });
  }
  synchronize() {
    return this.call<DraftSyncResult[]>('workspace_sync');
  }
  users() {
    return this.call<ManagedUser[]>('admin_request', { action: 'users' });
  }
  catalog() {
    return this.call<AccessCatalog>('admin_request', { action: 'catalog' });
  }
  createUser(input: {
    email: string;
    displayName: string;
    initialPassword: string;
    access: AccessAssignment;
  }) {
    return this.call<ManagedUser>('admin_request', { action: 'create', payload: input });
  }
  assignUser(userId: string, access: AccessAssignment, expectedVersion: number) {
    return this.call<ManagedUser>('admin_request', {
      action: 'access',
      payload: { userId, access, expectedVersion },
    });
  }
  logs() {
    return this.call<AuthLog[]>('admin_request', { action: 'logs' });
  }
}
export function message(error: unknown) {
  const code = error instanceof Error ? error.message : String(error);
  const labels: Record<string, string> = {
    EXPENSE_CONFLICT:
      'La demande ou les règles ont changé. Actualisez les demandes et réessayez sur la même demande.',
    EXPENSE_POLICY_REQUIRED:
      'Un administrateur doit configurer les plafonds de dépenses pour cette devise.',
    EXPENSE_LIMIT_EXCEEDED: 'Le montant dépasse votre plafond autorisé pour cette action.',
    INSUFFICIENT_FUNDS:
      'Les fonds disponibles sont insuffisants pour réserver ou payer cette dépense.',
    EXPENSE_EVIDENCE_REQUIRED: 'Au moins un justificatif est requis par les règles de dépenses.',
    FILE_INVALID:
      'Justificatifs invalides : PDF, PNG ou JPEG, 3 fichiers maximum et 1 Mio au total.',
    INVALID_CREDENTIALS: 'Identifiants ou déverrouillage non valides.',
    AUTH_THROTTLED: 'Trop de tentatives. Patientez avant de réessayer.',
    SERVER_UNAVAILABLE:
      'Le serveur est indisponible. Réessayez lorsque la connexion sera rétablie.',
    SERVER_IDENTITY_INVALID: 'Le serveur attendu ne peut pas être vérifié.',
    PERMISSION_DENIED: 'Vos autorisations ne permettent pas cette action.',
    SESSION_EXPIRED: 'Votre session a expiré. Connectez-vous de nouveau.',
    AUTH_REQUIRED: 'Une connexion est nécessaire.',
    SESSION_LOCKED: 'Déverrouillez votre session pour continuer.',
    ONLINE_REQUIRED: 'Cette action exige une connexion au serveur.',
    DESKTOP_REQUIRED: 'Ouvrez l’application CaissePro pour vous connecter.',
    LOCAL_VERSION_CONFLICT: 'Ce brouillon a changé. Actualisez la liste.',
    PASSWORD_CHANGE_REQUIRED: 'Renouvelez votre mot de passe pour continuer.',
    SESSION_CHANGED: 'La session a changé. Réessayez dans votre session actuelle.',
  };
  return labels[code] ?? 'Action impossible. Vérifiez vos informations et réessayez.';
}
