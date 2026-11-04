import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  nativeSessionViewSchema,
  type NativeSessionView,
  type Draft,
  type ManagedUser,
  type AccessAssignment,
  type AuthLog,
  type DraftSyncResult,
  type RoleCode,
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
