import { describe, it, expect, vi } from 'vitest';
import { ConnectionService } from './connection';
import { MemoryLocalStore, createLocalDraft, assertDiskPersistenceAllowed } from './local-store';
import { SyncCoordinator } from './sync';
const draft = () =>
  createLocalDraft({ kind: 'receipt', currency: 'USD', amount: '10.20', description: 'Brouillon' });
function store() {
  const s = new MemoryLocalStore();
  s.activateScope('test-scope');
  return s;
}
const response = (deploymentId = 'expected') =>
  new Response(
    JSON.stringify({ service: 'caissepro-api', protocolVersion: 2, deploymentId, status: 'ready' }),
  );
describe('Disponibilité réelle', () => {
  it('vérifie le contrat et l’identité de déploiement', async () => {
    const fetcher = vi.fn().mockResolvedValue(response());
    const c = new ConnectionService('https://example.test', 'expected', false, fetcher);
    await c.check();
    expect(c.isOnline()).toBe(true);
    expect(fetcher).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ cache: 'no-store', redirect: 'error', credentials: 'omit' }),
    );
  });
  it('refuse un serveur différent', async () => {
    const c = new ConnectionService(
      'https://example.test',
      'expected',
      false,
      vi.fn().mockResolvedValue(response('other')),
    );
    await c.check();
    expect(c.getSnapshot().reason).toBe('identity-mismatch');
    expect(c.isOnline()).toBe(false);
  });
  it('refuse HTTP public même en développement et les URL avec secrets', async () => {
    for (const url of [
      'http://example.test',
      'https://user:password@example.test',
      'https://example.test?token=secret',
    ]) {
      const f = vi.fn();
      const c = new ConnectionService(url, 'expected', true, f);
      await c.check();
      expect(c.isOnline()).toBe(false);
      expect(f).not.toHaveBeenCalled();
    }
  });
  it('autorise HTTP uniquement sur loopback en développement', async () => {
    const c = new ConnectionService(
      'http://127.0.0.1:3000',
      'expected',
      true,
      vi.fn().mockResolvedValue(response()),
    );
    await c.check();
    expect(c.isOnline()).toBe(true);
  });
  it('classe les pannes en hors connexion sans exposer l’erreur', async () => {
    const c = new ConnectionService(
      'https://example.test',
      'expected',
      false,
      vi.fn().mockRejectedValue(new Error('secret')),
    );
    await c.check();
    expect(c.getSnapshot()).toMatchObject({ state: 'offline', reason: 'unavailable' });
  });
  it('expire un ancien résultat de disponibilité', async () => {
    const c = new ConnectionService(
      'https://example.test',
      'expected',
      false,
      vi.fn().mockResolvedValue(response()),
    );
    await c.check();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 21000);
    expect(c.isOnline()).toBe(false);
    vi.restoreAllMocks();
  });
});
describe('Stockage hors connexion', () => {
  it('refuse une autorisation de cache sans date limite valide', () => {
    const now = Date.now();
    for (const authorizedUntil of [Number.NaN, Number.POSITIVE_INFINITY, now + 10000.5]) {
      const s = store();
      expect(() =>
        s.cacheAuthorized(
          {
            id: 'balance',
            version: 1,
            schemaVersion: 1,
            synchronizedAt: new Date(now).toISOString(),
            expiresAt: new Date(now + 5000).toISOString(),
            data: { amount: '12.34' },
          },
          {
            scope: 'test-scope',
            resourceId: 'balance',
            permission: 'ledger:read',
            authorizedUntil,
          },
        ),
      ).toThrow('OFFLINE_ACCESS_DENIED');
      expect(s.readCache('balance', 'ledger:read')).toBeNull();
    }
  });
  it('refuse un cache dont l’expiration précède sa synchronisation', () => {
    const now = Date.now(),
      s = store();
    expect(() =>
      s.cacheAuthorized(
        {
          id: 'balance',
          version: 1,
          schemaVersion: 1,
          synchronizedAt: new Date(now + 1000).toISOString(),
          expiresAt: new Date(now + 500).toISOString(),
          data: { amount: '12.34' },
        },
        {
          scope: 'test-scope',
          resourceId: 'balance',
          permission: 'ledger:read',
          authorizedUntil: now + 5000,
        },
      ),
    ).toThrow('OFFLINE_ACCESS_DENIED');
    expect(s.readCache('balance', 'ledger:read')).toBeNull();
  });
  it('interdit tout disque sensible et exige un périmètre autorisé', () => {
    expect(assertDiskPersistenceAllowed).toThrow('PLATFORM_ENCRYPTION_NOT_VALIDATED');
    expect(() => new MemoryLocalStore().saveDraft(draft())).toThrow('AUTHORIZED_SCOPE_REQUIRED');
  });
  it('conserve un UUID et une révision stable sans solde financier', () => {
    const s = store(),
      d = draft();
    expect(s.saveDraft(d).version).toBe(1);
    expect(s.saveDraft(d).version).toBe(1);
    expect(s.saveDraft({ ...d, amount: '20.00' }, 1)).toMatchObject({
      version: 2,
      draft: { id: d.id, amount: '20.00' },
    });
    expect('balance' in s).toBe(false);
  });
  it('refuse une modification concurrente et une prolongation de durée', () => {
    const s = store(),
      d = draft();
    s.saveDraft(d);
    s.saveDraft({ ...d, amount: '20.00' }, 1);
    expect(() => s.saveDraft({ ...d, amount: '30.00' }, 1)).toThrow('LOCAL_VERSION_CONFLICT');
    expect(() =>
      s.saveDraft({ ...d, expiresAt: new Date(Date.parse(d.expiresAt) + 1000).toISOString() }, 2),
    ).toThrow();
  });
  it('retourne des copies et efface le périmètre précédent', () => {
    const s = store(),
      d = draft();
    s.saveDraft(d);
    s.listDrafts()[0]!.draft.amount = '99.00';
    expect(s.listDrafts()[0]!.draft.amount).toBe('10.20');
    s.activateScope('other');
    expect(s.listDrafts()).toHaveLength(0);
  });
  it('supprime les brouillons expirés', () => {
    const s = store(),
      d = draft();
    s.saveDraft(d);
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(d.expiresAt));
    expect(s.listDrafts()).toHaveLength(0);
    vi.restoreAllMocks();
  });
  it('borne le cache par autorisation, version et durée et le marque non actualisé', () => {
    const s = store(),
      now = Date.now(),
      snap = {
        id: 'balance',
        version: 1,
        schemaVersion: 1 as const,
        synchronizedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 10000).toISOString(),
        data: { amount: '12.34' },
      },
      grant = {
        scope: 'test-scope',
        resourceId: 'balance',
        permission: 'ledger:read',
        authorizedUntil: now + 10000,
      };
    s.cacheAuthorized(snap, grant);
    expect(s.readCache('balance', 'ledger:read')?.stale).toBe(true);
    expect(s.readCache('balance', 'other')).toBe(null);
    expect(() => s.cacheAuthorized(snap, { ...grant, scope: 'other' })).toThrow();
    expect(() => s.cacheAuthorized(snap, grant)).toThrow('LOCAL_VERSION_CONFLICT');
  });
});
describe('Synchronisation de brouillons', () => {
  it('diffère hors connexion et ne touche pas aux montants', async () => {
    const s = store(),
      d = draft();
    s.saveDraft(d);
    const send = vi.fn();
    expect(
      await new SyncCoordinator(s, { isOnline: () => false }, { sendDraft: send }).synchronize(),
    ).toEqual([{ draftId: d.id, outcome: 'deferred', code: 'offline' }]);
    expect(send).not.toHaveBeenCalled();
    expect(s.listDrafts()[0]!.draft.amount).toBe('10.20');
  });
  it('ne dispose pas de transport financier par défaut', async () => {
    const s = store();
    s.saveDraft(draft());
    expect((await new SyncCoordinator(s, { isOnline: () => true }).synchronize())[0]!.code).toBe(
      'not-configured',
    );
  });
  it('transmet UUID, révision, base serveur et synchronise sans confirmation', async () => {
    const s = store(),
      d = draft();
    s.saveDraft(d);
    const send = vi
      .fn()
      .mockResolvedValue({ draftId: d.id, outcome: 'accepted-as-draft', code: 'draft-received' });
    await new SyncCoordinator(s, { isOnline: () => true }, { sendDraft: send }).synchronize();
    expect(send).toHaveBeenCalledWith(d, d.id, 1, null);
    expect(s.listDrafts()[0]).toMatchObject({ state: 'synced', serverVersion: 1 });
  });
  it('rejette un résultat inventant une confirmation financière', async () => {
    const s = store(),
      d = draft();
    s.saveDraft(d);
    const result = await new SyncCoordinator(
      s,
      { isOnline: () => true },
      { sendDraft: async () => ({ draftId: d.id, outcome: 'payment-confirmed', code: 'paid' }) },
    ).synchronize();
    expect(result[0]!.code).toBe('transport-error');
    expect(s.listDrafts()[0]!.state).toBe('local');
  });
  it('ignore un résultat après changement de session', async () => {
    const s = store(),
      d = draft();
    s.saveDraft(d);
    const result = await new SyncCoordinator(
      s,
      { isOnline: () => true },
      {
        sendDraft: async () => {
          s.clear();
          return { draftId: d.id, outcome: 'accepted-as-draft', code: 'draft-received' };
        },
      },
    ).synchronize();
    expect(result[0]!.code).toBe('session-changed');
  });
  it('ignore un résultat reçu pour une ancienne révision', async () => {
    const s = store(),
      d = draft();
    s.saveDraft(d);
    const result = await new SyncCoordinator(
      s,
      { isOnline: () => true },
      {
        sendDraft: async () => {
          s.saveDraft({ ...d, amount: '11.00' }, 1);
          return { draftId: d.id, outcome: 'accepted-as-draft', code: 'draft-received' };
        },
      },
    ).synchronize();
    expect(result[0]!.code).toBe('local-version-conflict');
    expect(s.listDrafts()[0]!.version).toBe(2);
  });
  it('mutualise les tentatives simultanées', async () => {
    const s = store(),
      d = draft();
    s.saveDraft(d);
    const sync = new SyncCoordinator(
      s,
      { isOnline: () => true },
      { sendDraft: async () => ({ draftId: d.id, outcome: 'conflict', code: 'conflict' }) },
    );
    const a = sync.synchronize(),
      b = sync.synchronize();
    expect(a).toBe(b);
    await a;
  });
});

it('ne réessaie pas automatiquement un conflit déjà présenté', async () => {
  const s = store(),
    d = draft();
  s.saveDraft(d);
  const send = vi.fn(async () => ({ draftId: d.id, outcome: 'conflict', code: 'conflict' }));
  const sync = new SyncCoordinator(s, { isOnline: () => true }, { sendDraft: send });
  await sync.synchronize();
  await sync.synchronize();
  expect(send).toHaveBeenCalledTimes(1);
});
