import { vi } from 'vitest';
import type { NativeSessionView, SessionProfile, FormBufferInput } from '@caissepro/shared';
import type { AuthGateway } from './gateway';
import { anonymous } from './controller';
export function profile(name = 'Alice', role = 'CASHIER'): SessionProfile {
  const now = Date.now();
  return {
    sessionId: crypto.randomUUID(),
    deviceId: crypto.randomUUID(),
    user: {
      id: crypto.randomUUID(),
      displayName: name,
      email: `${name.toLowerCase()}@example.test`,
      mustChangePassword: false,
    },
    company: { id: crypto.randomUUID(), code: 'TEST', name: 'Entreprise test' },
    roles: [role],
    permissions: ['ledger:read', 'offline:access', 'draft:write_own', 'draft:read_own'],
    agencies: [{ id: crypto.randomUUID(), code: 'A', name: 'Agence A' }],
    cashRegisters: [],
    expiresAt: new Date(now + 3600000).toISOString(),
    idleExpiresAt: new Date(now + 900000).toISOString(),
    offlineUntil: new Date(now + 900000).toISOString(),
    validatedAt: new Date(now).toISOString(),
    authorizationVersion: 1,
    locked: false,
  };
}
export function view(p = profile()): NativeSessionView {
  return {
    state: 'online',
    profile: p,
    displayName: p.user.displayName,
    offlineUntil: p.offlineUntil,
    reason: null,
    generation: 1,
  };
}
export function fakeGateway(initial: NativeSessionView = anonymous) {
  let current = structuredClone(initial);
  const gateway: AuthGateway = {
    reportSnapshot: vi.fn(async () => {
      throw new Error('ONLINE_REQUIRED');
    }),
    saveReport: vi.fn(),
    closeCash: vi.fn(),
    sendTransfer: vi.fn(),
    transferList: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 25 as const })),
    transferDetail: vi.fn(),
    handoverTransfer: vi.fn(),
    receiveTransfer: vi.fn(),
    formBuffers: vi.fn(async () => []),
    saveFormBuffer: vi.fn(async (input: FormBufferInput) => ({
      ...input,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 900000).toISOString(),
    })),
    removeFormBuffer: vi.fn(),
    syncStatus: vi.fn(async () => ({
      running: false,
      apiOnline: current.state === 'online',
      lastSuccessfulAt: null,
      cacheUpdatedAt: null,
      counts: { local: 0, queued: 0, syncing: 0, synced: 0, conflict: 0, error: 0 },
      persistence: 'memory-only' as const,
      events: [],
    })),
    syncManifest: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 50 as const })),
    syncEvents: vi.fn(async () => ({ items: [], lastSuccessfulAt: null })),
    restoreSynchronizedDraft: vi.fn(),
    resolveSyncConflict: vi.fn(),
    retrySyncDraft: vi.fn(),
    expensePolicies: vi.fn(async () => ({ items: [] })),
    configureExpensePolicy: vi.fn(),
    expenseDrafts: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 25 })),
    restoreExpenseDraft: vi.fn(),
    submitExpense: vi.fn(),
    expenseList: vi.fn(async () => ({
      items: [],
      total: 0,
      page: 1,
      pageSize: 25,
      synchronizedAt: new Date().toISOString(),
    })),
    expenseDetail: vi.fn(),
    decideExpense: vi.fn(),
    payExpense: vi.fn(),
    paymentVoucher: vi.fn(),
    expenseEvidence: vi.fn(),
    cashCatalog: vi.fn(async () => ({
      data: {
        items: [],
        synchronizedAt: new Date().toISOString(),
        expiresAt: current.offlineUntil,
      },
      stale: current.state === 'offline',
    })),
    cashConfiguration: vi.fn(async () => ({ agencies: [], registers: [], users: [] })),
    createAgency: vi.fn(),
    createCash: vi.fn(),
    updateCash: vi.fn(),
    openCashSession: vi.fn(),
    receiptDrafts: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 25 })),
    restoreReceiptDraft: vi.fn(),
    confirmReceipt: vi.fn(),
    receiptHistory: vi.fn(async () => ({
      items: [],
      total: 0,
      page: 1,
      pageSize: 25,
      synchronizedAt: new Date().toISOString(),
    })),
    receipt: vi.fn(),
    receiptEvidence: vi.fn(),
    available: true,
    health: vi.fn(async () => true),
    status: vi.fn(async () => structuredClone(current)),
    login: vi.fn(async () => {
      current = view();
      return structuredClone(current);
    }),
    logout: vi.fn(async () => {
      current = { ...anonymous, generation: current.generation + 1 };
      return current;
    }),
    lock: vi.fn(async () => {
      current = { ...current, state: 'locked', profile: null };
      return current;
    }),
    unlock: vi.fn(async () => {
      current = view();
      return current;
    }),
    revalidate: vi.fn(async () => current),
    activity: vi.fn(async () => current),
    changePassword: vi.fn(async () => {
      current = { ...anonymous, reason: 'PASSWORD_CHANGED' };
      return current;
    }),
    balances: vi.fn(async () => ({
      data: {
        synchronizedAt: new Date().toISOString(),
        expiresAt: current.offlineUntil,
        balances: [],
      },
      stale: current.state === 'offline',
    })),
    drafts: vi.fn(async () => []),
    saveDraft: vi.fn(),
    synchronize: vi.fn(async () => []),
    users: vi.fn(async () => []),
    catalog: vi.fn(),
    createUser: vi.fn(),
    assignUser: vi.fn(),
    logs: vi.fn(async () => []),
  };
  return {
    gateway,
    set: (value: NativeSessionView) => {
      current = structuredClone(value);
    },
  };
}
