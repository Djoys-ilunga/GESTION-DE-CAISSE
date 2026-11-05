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
  });
});
