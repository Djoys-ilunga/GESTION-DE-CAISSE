import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import type { FormBuffer } from '@caissepro/shared';
import { fakeGateway, view, profile } from '../auth/test-fixture';
import type { SessionDraft } from '../auth/gateway';
import { SyncCenter } from './SyncCenter';
import { ExpenseForm } from '../expenses/ExpenseForm';
import { App } from '../App';
import { StorageNotice } from './StorageNotice';
function setup() {
  const p = profile();
  const { gateway, set } = fakeGateway(view(p));
  const now = new Date().toISOString();
  const record: SessionDraft = {
    draft: {
      id: crypto.randomUUID(),
      kind: 'expense-request',
      currency: 'USD',
      amount: '12.34',
      description: 'Achat synthétique',
      createdAt: now,
      expiresAt: p.offlineUntil!,
      expenseDetails: { beneficiary: 'Fournisseur synthétique', reference: '', documents: [] },
    },
    agencyId: p.agencies[0]!.id,
    cashRegisterId: null,
    version: 2,
    serverVersion: 1,
    state: 'conflict',
    updatedAt: now,
    result: { draftId: crypto.randomUUID(), outcome: 'conflict', code: 'conflict' },
  };
  vi.mocked(gateway.drafts).mockResolvedValue([record]);
  vi.mocked(gateway.syncStatus).mockResolvedValue({
    running: false,
    apiOnline: true,
    counts: { local: 0, queued: 0, syncing: 0, synced: 0, conflict: 1, error: 0 },
    lastSuccessfulAt: now,
    cacheUpdatedAt: null,
    persistence: 'memory-only',
    events: [],
  });
  return { p, gateway, set, record, now };
}
function noFinance(gateway: ReturnType<typeof setup>['gateway']) {
  for (const method of [
    gateway.confirmReceipt,
    gateway.submitExpense,
    gateway.decideExpense,
    gateway.payExpense,
  ])
    expect(method).not.toHaveBeenCalled();
}
describe('Centre de synchronisation sécurisé', () => {
  it('annonce la persistance seulement si le courtier la confirme et ne synchronise rien automatiquement', async () => {
    const { p, gateway } = setup();
    const current = await gateway.syncStatus();
    vi.mocked(gateway.syncStatus).mockResolvedValue({
      ...current,
      persistence: 'encrypted-sqlcipher',
      retentionMs: 604800000,
      lastSavedAt: new Date().toISOString(),
    });
    render(<SyncCenter profile={p} gateway={gateway} online={false} />);
    expect(await screen.findByText(/Brouillons chiffrés sur cet appareil/)).toBeVisible();
    expect(screen.queryByText(/Fermer l’application efface/)).not.toBeInTheDocument();
    expect(screen.getByText(/L’expiration du bail hors connexion verrouille/)).toBeVisible();
    expect(gateway.synchronize).not.toHaveBeenCalled();
    noFinance(gateway);
  });
  it('ne promet aucune conservation après fermeture lorsque le stockage est non vérifiable', async () => {
    const { gateway } = setup();
    vi.mocked(gateway.syncStatus).mockRejectedValue(new Error('LOCAL_STORAGE_UNAVAILABLE'));
    render(<StorageNotice gateway={gateway} />);
    expect(await screen.findByText(/État du stockage non vérifiable/)).toBeVisible();
    expect(screen.queryByText(/Brouillons chiffrés sur cet appareil/)).not.toBeInTheDocument();
    noFinance(gateway);
  });
  it('affiche versions, conflits et protection mémoire puis résout uniquement sur action explicite', async () => {
    const { p, gateway, record } = setup();
    render(<SyncCenter profile={p} gateway={gateway} online />);
    expect(await screen.findByText(record.draft.id)).toBeInTheDocument();
    expect(screen.getByText(/Fermer l’application efface/)).toBeInTheDocument();
    expect(gateway.resolveSyncConflict).not.toHaveBeenCalled();
    expect(gateway.synchronize).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole('button', { name: 'Conserver ma correction et remettre en attente' }),
    );
    expect(gateway.resolveSyncConflict).toHaveBeenCalledWith(record.draft.id, 2, 'local');
    noFinance(gateway);
  });
  it('ne transmet rien hors connexion et garde les informations datées', async () => {
    const { p, gateway } = setup();
    render(<SyncCenter profile={p} gateway={gateway} online={false} />);
    expect(await screen.findByText(/Hors connexion ou session à revalider/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Synchroniser maintenant' })).toBeDisabled();
    expect(
      await screen.findByRole('button', { name: 'Remplacer par la version serveur' }),
    ).toBeDisabled();
    expect(gateway.syncManifest).not.toHaveBeenCalled();
    expect(gateway.synchronize).not.toHaveBeenCalled();
    noFinance(gateway);
  });
  it('limite la nouvelle tentative à la révision affichée sans transmission implicite', async () => {
    const { p, gateway, record } = setup();
    vi.mocked(gateway.drafts).mockResolvedValue([{ ...record, state: 'error' }]);
    render(<SyncCenter profile={p} gateway={gateway} online />);
    await userEvent.click(await screen.findByRole('button', { name: 'Remettre en attente' }));
    expect(gateway.retrySyncDraft).toHaveBeenCalledWith(record.draft.id, 2);
    expect(gateway.synchronize).not.toHaveBeenCalled();
    noFinance(gateway);
  });
  it('masque les actions d’écriture à un lecteur et bloque les commandes pendant un envoi', async () => {
    const { p, gateway, record } = setup();
    p.permissions = p.permissions.filter((v) => v !== 'draft:write_own');
    vi.mocked(gateway.drafts).mockResolvedValue([{ ...record, state: 'syncing' }]);
    render(<SyncCenter profile={p} gateway={gateway} online />);
    expect(await screen.findByText(record.draft.id)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Corriger' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Synchroniser maintenant' })).toBeDisabled();
    noFinance(gateway);
  });
  it('ignore une réponse tardive du centre précédent lors du changement d’utilisateur', async () => {
    const { p, gateway } = setup();
    let resolve!: (value: Awaited<ReturnType<typeof gateway.syncManifest>>) => void;
    vi.mocked(gateway.syncManifest).mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const mounted = render(<SyncCenter profile={p} gateway={gateway} online />);
    await waitFor(() => expect(gateway.syncManifest).toHaveBeenCalled());
    mounted.unmount();
    const second = setup();
    render(<SyncCenter profile={second.p} gateway={second.gateway} online={false} />);
    await act(async () => resolve({ items: [], total: 100, page: 1, pageSize: 50 }));
    expect(screen.getByRole('button', { name: 'Suivant' })).toBeDisabled();
    expect(second.gateway.synchronize).not.toHaveBeenCalled();
  });
  it('reprend la saisie après interruption avec le même UUID sans la transmettre', async () => {
    const { p, gateway, now } = setup();
    let captured: FormBuffer | undefined;
    vi.mocked(gateway.saveFormBuffer).mockImplementation(async (input) => {
      captured = { ...input, createdAt: now, updatedAt: now, expiresAt: p.offlineUntil! };
      return captured;
    });
    vi.mocked(gateway.formBuffers).mockImplementation(async () => (captured ? [captured] : []));
    const form = render(
      <ExpenseForm
        gateway={gateway}
        profile={p}
        cashes={[]}
        source={null}
        copy={false}
        onSaved={() => {}}
        onCancel={() => {}}
      />,
    );
    await userEvent.type(screen.getByLabelText('Montant exact'), '12,');
    await userEvent.type(screen.getByLabelText('Bénéficiaire'), 'Fournisseur temporaire');
    await waitFor(() => expect(captured?.fields.beneficiary).toBe('Fournisseur temporaire'));
    const stable = captured!.id;
    form.unmount();
    render(<SyncCenter profile={p} gateway={gateway} online={false} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Reprendre la saisie' }));
    expect(screen.getByLabelText('Montant exact')).toHaveValue('12,');
    expect(screen.getByLabelText('Bénéficiaire')).toHaveValue('Fournisseur temporaire');
    await userEvent.clear(screen.getByLabelText('Montant exact'));
    await userEvent.type(screen.getByLabelText('Montant exact'), '12,34');
    await userEvent.type(screen.getByLabelText('Motif'), 'Fournitures synthétiques');
    await userEvent.click(screen.getByRole('button', { name: /Enregistrer/ }));
    await waitFor(() => expect(gateway.saveDraft).toHaveBeenCalled());
    expect(vi.mocked(gateway.saveDraft).mock.calls[0]![0].draft).toMatchObject({
      id: stable,
      amount: '12.34',
      createdAt: captured!.createdAt,
      expiresAt: captured!.expiresAt,
    });
    expect(gateway.synchronize).not.toHaveBeenCalled();
    noFinance(gateway);
  });
  it('retire tous les champs de saisie de React pendant le verrouillage de l’application', async () => {
    const { p, gateway, set } = setup();
    p.permissions.push('expense:request');
    vi.mocked(gateway.cashCatalog).mockResolvedValue({
      stale: false,
      data: {
        synchronizedAt: new Date().toISOString(),
        expiresAt: p.offlineUntil,
        items: [
          {
            id: crypto.randomUUID(),
            agency: p.agencies[0]!,
            code: 'A',
            name: 'Caisse de test',
            active: true,
            version: 1,
            session: null,
            funds: [],
          },
        ],
      },
    });
    render(<App gateway={gateway} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Dépenses' }));
    await userEvent.click(
      await screen.findByRole('button', { name: /Nouvelle demande de dépense/ }),
    );
    await userEvent.type(screen.getByLabelText('Bénéficiaire'), 'Donnée privée en cours');
    set({ ...view(p), state: 'locked', profile: null });
    window.dispatchEvent(new Event('offline'));
    expect(await screen.findByRole('heading', { name: 'Session verrouillée' })).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Donnée privée en cours')).not.toBeInTheDocument();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    noFinance(gateway);
  });
});
