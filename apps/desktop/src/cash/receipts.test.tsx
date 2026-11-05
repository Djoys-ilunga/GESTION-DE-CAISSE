import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import type { CashView, ConfirmedReceipt, ServerReceiptDraft } from '@caissepro/shared';
import { profile, fakeGateway, view } from '../auth/test-fixture';
import { ReceiptsPage } from './ReceiptsPage';
import { CashPage } from './CashPage';
import { ReceiptForm } from './ReceiptForm';
import { ReceiptViewer } from './ReceiptViewer';
function setup() {
  const p = profile();
  p.permissions.push('receipt:read', 'receipt:post', 'session:manage');
  const cash: CashView = {
    id: crypto.randomUUID(),
    agency: p.agencies[0]!,
    code: 'C1',
    name: 'Caisse principale',
    active: true,
    version: 1,
    session: { id: crypto.randomUUID(), openedAt: new Date().toISOString() },
    funds: [
      { currency: 'CDF', balance: '0.00', reserved: '0.00', available: '0.00' },
      { currency: 'USD', balance: '10.00', reserved: '0.00', available: '10.00' },
    ],
  };
  p.cashRegisters = [{ id: cash.id, agencyId: cash.agency.id, code: cash.code, name: cash.name }];
  const { gateway } = fakeGateway(view(p));
  vi.mocked(gateway.cashCatalog).mockResolvedValue({
    data: { items: [cash], synchronizedAt: new Date().toISOString(), expiresAt: p.offlineUntil },
    stale: false,
  });
  const source: ServerReceiptDraft = {
    id: crypto.randomUUID(),
    clientDraftId: crypto.randomUUID(),
    agencyId: cash.agency.id,
    cashRegisterId: cash.id,
    version: 1,
    currency: 'USD',
    amount: '12.34',
    description: 'Vente professionnelle',
    provenance: 'Client Alpha',
    category: 'Ventes',
    reference: 'FACT-001',
    hasEvidence: false,
    receivedAt: new Date().toISOString(),
    receiptId: null,
    receiptNumber: null,
  };
  const receipt: ConfirmedReceipt = {
    id: crypto.randomUUID(),
    number: 'REC-TEST-2026-000001',
    operationId: crypto.randomUUID(),
    clientDraftId: source.clientDraftId,
    sourceDraftId: source.id,
    version: 1,
    cashRegisterId: cash.id,
    agencyId: cash.agency.id,
    currency: 'USD',
    amount: '12.34',
    description: source.description,
    provenance: source.provenance!,
    category: 'Ventes',
    reference: 'FACT-001',
    companyName: 'Entreprise test',
    companyCode: 'TEST',
    agencyName: cash.agency.name,
    agencyCode: 'A',
    cashName: cash.name,
    cashCode: cash.code,
    cashierName: 'Alice',
    postedAt: new Date().toISOString(),
    evidence: null,
  };
  vi.mocked(gateway.receiptDrafts).mockResolvedValue({
    items: [source],
    total: 1,
    page: 1,
    pageSize: 25,
  });
  vi.mocked(gateway.confirmReceipt).mockResolvedValue(receipt);
  vi.mocked(gateway.receipt).mockResolvedValue(receipt);
  return { p, cash, gateway, source, receipt };
}
async function fillForm() {
  await userEvent.selectOptions(screen.getByLabelText('Devise'), 'USD');
  await userEvent.type(screen.getByLabelText('Montant'), '12,34');
  await userEvent.type(screen.getByLabelText('Provenance / payeur'), 'Client Alpha');
  await userEvent.type(screen.getByLabelText('Catégorie'), 'Ventes');
  await userEvent.type(screen.getByLabelText('Motif'), 'Vente professionnelle');
}
describe('Encaissements desktop avec courtier simulé', () => {
  it('prépare hors connexion sans confirmer ni produire de reçu', async () => {
    const { p, gateway } = setup();
    vi.mocked(gateway.saveDraft).mockResolvedValue({} as never);
    render(<ReceiptsPage gateway={gateway} profile={p} online={false} />);
    await screen.findByText(/Derniers soldes connus/);
    await userEvent.click(screen.getByRole('button', { name: 'Nouveau brouillon d’encaissement' }));
    expect(screen.getByRole('group', { name: 'Caisse d’encaissement' })).toHaveTextContent(
      'Caisse principale',
    );
    expect(screen.queryByRole('combobox', { name: 'Caisse' })).not.toBeInTheDocument();
    await fillForm();
    expect(screen.getByText(/Solde consulté dans cette devise/)).toHaveTextContent('10,00 USD');
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer le brouillon' }));
    await waitFor(() => expect(gateway.saveDraft).toHaveBeenCalledOnce());
    const input = vi.mocked(gateway.saveDraft).mock.calls[0]![0];
    expect(input.draft.amount).toBe('12.34');
    expect(input.draft.receiptDetails?.provenance).toBe('Client Alpha');
    expect(input.expectedVersion).toBeNull();
    expect(gateway.confirmReceipt).not.toHaveBeenCalled();
    expect(gateway.receipt).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(localStorage.length).toBe(0);
    expect(screen.getByRole('button', { name: 'Transmettre les brouillons' })).toBeDisabled();
  });
  it('exige l’attestation avant la confirmation et affiche le reçu du serveur', async () => {
    const { p, gateway, source, receipt } = setup();
    render(<ReceiptsPage gateway={gateway} profile={p} online />);
    await userEvent.click(screen.getByRole('tab', { name: 'Suivi serveur' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Vérifier et confirmer' }));
    expect(screen.getByRole('button', { name: 'Confirmer et comptabiliser' })).toBeDisabled();
    expect(gateway.confirmReceipt).not.toHaveBeenCalled();
    await userEvent.click(screen.getByLabelText(/J’atteste avoir effectivement reçu/));
    await userEvent.click(screen.getByRole('button', { name: 'Confirmer et comptabiliser' }));
    expect(await screen.findByRole('heading', { name: 'Reçu d’encaissement' })).toBeInTheDocument();
    expect(gateway.confirmReceipt).toHaveBeenCalledExactlyOnceWith(source.id, 1, true);
    expect(screen.getAllByText(receipt.number).length).toBeGreaterThan(0);
  });
  it('signale un résultat de confirmation inconnu sans inventer un reçu', async () => {
    const { p, gateway } = setup();
    vi.mocked(gateway.confirmReceipt).mockRejectedValue(new Error('SERVER_UNAVAILABLE'));
    render(<ReceiptsPage gateway={gateway} profile={p} online />);
    await userEvent.click(screen.getByRole('tab', { name: 'Suivi serveur' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Vérifier et confirmer' }));
    await userEvent.click(screen.getByLabelText(/J’atteste avoir effectivement reçu/));
    await userEvent.click(screen.getByRole('button', { name: 'Confirmer et comptabiliser' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Confirmation non vérifiée');
    expect(screen.queryByRole('heading', { name: 'Reçu d’encaissement' })).not.toBeInTheDocument();
  });
  it('réserve l’auditeur à la lecture et transmet les filtres à l’API', async () => {
    const { p, gateway } = setup();
    p.permissions = ['ledger:read', 'receipt:read'];
    render(<ReceiptsPage gateway={gateway} profile={p} online />);
    expect(
      screen.queryByRole('button', { name: 'Nouveau brouillon d’encaissement' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Suivi serveur' })).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Devise'), 'USD');
    await userEvent.type(screen.getByLabelText('Provenance, motif, référence ou reçu'), 'FACT-001');
    await userEvent.click(screen.getByRole('button', { name: 'Filtrer l’historique' }));
    await waitFor(() =>
      expect(gateway.receiptHistory).toHaveBeenLastCalledWith({
        currency: 'USD',
        search: 'FACT-001',
        page: 1,
      }),
    );
    expect(gateway.receiptDrafts).not.toHaveBeenCalled();
  });
  it('annule la lecture de justificatif en cours lors du changement d’utilisateur', async () => {
    const { cash, gateway } = setup();
    let resolve!: (value: ArrayBuffer) => void;
    const pending = new Promise<ArrayBuffer>((done) => {
      resolve = done;
    });
    const file = new File(['%PDF-1.7'], 'justificatif.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'arrayBuffer', { value: () => pending });
    const component = render(
      <ReceiptForm
        gateway={gateway}
        cashes={[cash]}
        editing={null}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await fillForm();
    await userEvent.upload(screen.getByLabelText('Justificatif'), file);
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer le brouillon' }));
    component.unmount();
    await act(async () => resolve(new TextEncoder().encode('%PDF-1.7').buffer));
    expect(gateway.saveDraft).not.toHaveBeenCalled();
  });
  it('désactive l’impression hors connexion même pour un reçu historique', () => {
    const { receipt, gateway } = setup();
    render(<ReceiptViewer receipt={receipt} gateway={gateway} online={false} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Imprimer' })).toBeDisabled();
  });
  it('présente les soldes CDF/USD datés sans les agréger hors connexion', async () => {
    const { p, gateway } = setup();
    render(<CashPage gateway={gateway} profile={p} online={false} />);
    expect(await screen.findByText(/Derniers soldes connus, non actualisés/)).toBeInTheDocument();
    expect(screen.getByText('10,00')).toBeInTheDocument();
    expect(screen.getByText('0,00')).toBeInTheDocument();
    expect(screen.getByText('CDF')).toBeInTheDocument();
    expect(screen.getByText('USD')).toBeInTheDocument();
    expect(gateway.openCashSession).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Votre caisse' })).toBeInTheDocument();
  });
});

describe('Présentation monocaisse et multicaisse', () => {
  it('conserve le rattachement initial lors de l’ajout d’une agence', async () => {
    const { p, cash, gateway } = setup();
    p.permissions.push('cash:configure');
    const base = { agencies: [cash.agency], registers: [], users: [] },
      second = { id: crypto.randomUUID(), code: '0-ANNEXE', name: 'Nouvelle agence' };
    vi.mocked(gateway.cashConfiguration)
      .mockResolvedValueOnce(base)
      .mockResolvedValue({ ...base, agencies: [second, cash.agency] });
    vi.mocked(gateway.createAgency).mockResolvedValue({ id: second.id });
    render(<CashPage gateway={gateway} profile={p} online />);
    await userEvent.click(screen.getByRole('button', { name: 'Configuration des caisses' }));
    await screen.findByRole('group', { name: 'Agence de rattachement' });
    await userEvent.type(screen.getByLabelText('Nom de la caisse'), 'Saisie conservée');
    await userEvent.type(screen.getByLabelText('Code de l’agence'), '0-ANNEXE');
    await userEvent.type(screen.getByLabelText('Nom de l’agence'), 'Nouvelle agence');
    await userEvent.click(screen.getByRole('button', { name: 'Créer l’agence' }));
    expect(await screen.findByRole('combobox', { name: 'Agence de rattachement' })).toHaveValue(
      cash.agency.id,
    );
    expect(screen.getByLabelText('Nom de la caisse')).toHaveValue('Saisie conservée');
  });
  const otherCash = (cash: CashView): CashView => ({
    ...cash,
    id: crypto.randomUUID(),
    code: 'C2',
    name: 'Deuxième caisse',
  });
  it('permet de sélectionner explicitement une autre caisse sans changer les devises', async () => {
    const { cash, gateway } = setup(),
      second = otherCash(cash);
    vi.mocked(gateway.saveDraft).mockResolvedValue({} as never);
    render(
      <ReceiptForm
        gateway={gateway}
        cashes={[cash, second]}
        editing={null}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Caisse' }), second.id);
    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer le brouillon' }));
    await waitFor(() => expect(gateway.saveDraft).toHaveBeenCalledOnce());
    expect(vi.mocked(gateway.saveDraft).mock.calls[0]![0]).toMatchObject({
      cashRegisterId: second.id,
      agencyId: second.agency.id,
      draft: { amount: '12.34', currency: 'USD' },
    });
    expect(gateway.confirmReceipt).not.toHaveBeenCalled();
  });
  it('sélectionne la caisse unique lorsque le catalogue arrive après le formulaire', async () => {
    const { cash, gateway } = setup();
    vi.mocked(gateway.saveDraft).mockResolvedValue({} as never);
    const props = { gateway, editing: null, onSaved: vi.fn(), onCancel: vi.fn() };
    const component = render(<ReceiptForm {...props} cashes={[]} />);
    expect(screen.queryByRole('group', { name: 'Caisse d’encaissement' })).not.toBeInTheDocument();
    component.rerender(<ReceiptForm {...props} cashes={[cash]} />);
    expect(await screen.findByRole('group', { name: 'Caisse d’encaissement' })).toHaveTextContent(
      cash.name,
    );
    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer le brouillon' }));
    await waitFor(() => expect(gateway.saveDraft).toHaveBeenCalledOnce());
    expect(vi.mocked(gateway.saveDraft).mock.calls[0]![0].cashRegisterId).toBe(cash.id);
  });
  it('réaffiche le choix à l’ajout d’une caisse en conservant la saisie et la caisse initiale', async () => {
    const { cash, gateway } = setup(),
      second = otherCash(cash);
    vi.mocked(gateway.saveDraft).mockResolvedValue({} as never);
    const props = { gateway, editing: null, onSaved: vi.fn(), onCancel: vi.fn() };
    const component = render(<ReceiptForm {...props} cashes={[cash]} />);
    await fillForm();
    component.rerender(<ReceiptForm {...props} cashes={[second, cash]} />);
    expect(screen.getByRole('combobox', { name: 'Caisse' })).toHaveValue(cash.id);
    expect(screen.getByLabelText('Montant')).toHaveValue('12,34');
    expect(screen.getByLabelText('Provenance / payeur')).toHaveValue('Client Alpha');
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer le brouillon' }));
    await waitFor(() => expect(gateway.saveDraft).toHaveBeenCalledOnce());
    expect(vi.mocked(gateway.saveDraft).mock.calls[0]![0].cashRegisterId).toBe(cash.id);
  });
  it('ne remplace pas silencieusement une caisse désactivée par l’unique autre caisse', async () => {
    const { cash, gateway } = setup(),
      second = otherCash(cash);
    const props = { gateway, editing: null, onSaved: vi.fn(), onCancel: vi.fn() };
    const component = render(<ReceiptForm {...props} cashes={[cash]} />);
    await fillForm();
    component.rerender(<ReceiptForm {...props} cashes={[{ ...cash, active: false }, second]} />);
    expect(screen.queryByRole('group', { name: 'Caisse d’encaissement' })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Caisse' })).toBeInTheDocument();
    expect(gateway.saveDraft).not.toHaveBeenCalled();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Caisse' }), second.id);
    expect(await screen.findByRole('group', { name: 'Caisse d’encaissement' })).toHaveTextContent(
      second.name,
    );
  });
  it('masque le filtre de caisse unique tout en conservant les filtres de devise et de date', async () => {
    const { p, gateway } = setup();
    p.permissions = ['ledger:read', 'receipt:read'];
    render(<ReceiptsPage gateway={gateway} profile={p} online />);
    await screen.findByRole('group', { name: 'Caisse de l’historique' });
    expect(screen.queryByRole('combobox', { name: 'Caisse' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Devise')).toBeInTheDocument();
    expect(screen.getByLabelText('Du')).toBeInTheDocument();
    expect(screen.getByLabelText('Au')).toBeInTheDocument();
  });
  it('conserve l’accès à l’historique d’une ancienne caisse désactivée', async () => {
    const { p, cash, gateway } = setup(),
      archived = { ...otherCash(cash), active: false };
    p.permissions = ['ledger:read', 'receipt:read'];
    vi.mocked(gateway.cashCatalog).mockResolvedValue({
      data: {
        items: [cash, archived],
        synchronizedAt: new Date().toISOString(),
        expiresAt: p.offlineUntil,
      },
      stale: false,
    });
    render(<ReceiptsPage gateway={gateway} profile={p} online />);
    const select = await screen.findByRole('combobox', { name: 'Caisse' });
    await waitFor(() =>
      expect(
        screen.getByRole('option', { name: 'Deuxième caisse (désactivée)' }),
      ).toBeInTheDocument(),
    );
    await userEvent.selectOptions(select, archived.id);
    await userEvent.click(screen.getByRole('button', { name: 'Filtrer l’historique' }));
    await waitFor(() =>
      expect(gateway.receiptHistory).toHaveBeenLastCalledWith({
        cashRegisterId: archived.id,
        page: 1,
      }),
    );
  });
  it('laisse créer une nouvelle caisse même lorsque la configuration est monocaisse', async () => {
    const { p, cash, gateway } = setup();
    p.permissions.push('cash:configure');
    vi.mocked(gateway.cashConfiguration).mockResolvedValue({
      agencies: [cash.agency],
      registers: [
        {
          id: cash.id,
          agencyId: cash.agency.id,
          code: cash.code,
          name: cash.name,
          active: true,
          version: 1,
        },
      ],
      users: [],
    });
    vi.mocked(gateway.createCash).mockResolvedValue({ id: crypto.randomUUID() });
    render(<CashPage gateway={gateway} profile={p} online />);
    await userEvent.click(screen.getByRole('button', { name: 'Configuration des caisses' }));
    expect(await screen.findByRole('group', { name: 'Agence de rattachement' })).toHaveTextContent(
      cash.agency.name,
    );
    expect(
      screen.queryByRole('combobox', { name: 'Agence de rattachement' }),
    ).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Code de caisse'), 'C2');
    await userEvent.type(screen.getByLabelText('Nom de la caisse'), 'Nouvelle caisse');
    await userEvent.click(screen.getByRole('button', { name: 'Créer la caisse' }));
    await waitFor(() => expect(gateway.createCash).toHaveBeenCalledOnce());
    expect(vi.mocked(gateway.createCash).mock.calls[0]![0]).toMatchObject({
      agencyId: cash.agency.id,
      code: 'C2',
      name: 'Nouvelle caisse',
      authorizedUserIds: [],
    });
  });
});
