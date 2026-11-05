import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { type ExpenseView, type PaymentVoucher, type CashView } from '@caissepro/shared';
import { profile, view, fakeGateway } from '../auth/test-fixture';
import { ExpensesPage } from './ExpensesPage';
import { ExpenseForm } from './ExpenseForm';

function setup() {
  const p = profile('Alice', 'FINANCE_MANAGER');
  p.permissions.push('expense:request', 'expense:approve', 'expense:pay');
  const cash: CashView = {
    id: crypto.randomUUID(),
    agency: { ...p.agencies[0]! },
    name: 'Caisse principale',
    code: 'C1',
    active: true,
    version: 1,
    session: { id: crypto.randomUUID(), openedAt: new Date().toISOString() },
    funds: [
      { currency: 'USD', balance: '100.00', reserved: '20.00', available: '80.00' },
      { currency: 'CDF', balance: '0.00', reserved: '0.00', available: '0.00' },
    ],
  };
  p.cashRegisters = [{ id: cash.id, agencyId: cash.agency.id, code: cash.code, name: cash.name }];
  const { gateway } = fakeGateway(view(p));
  vi.mocked(gateway.cashCatalog).mockResolvedValue({
    data: { items: [cash], synchronizedAt: new Date().toISOString(), expiresAt: p.offlineUntil },
    stale: false,
  });
  const expense: ExpenseView = {
    id: crypto.randomUUID(),
    sourceDraftId: crypto.randomUUID(),
    clientDraftId: crypto.randomUUID(),
    agencyId: cash.agency.id,
    cashRegisterId: cash.id,
    cashName: cash.name,
    agencyName: cash.agency.name,
    requestedById: crypto.randomUUID(),
    requesterName: 'Bob',
    currency: 'USD',
    amount: '20.00',
    description: 'Fournitures de bureau',
    beneficiary: 'Fournisseur Exemple',
    reference: 'FACT-01',
    state: 'APPROVED',
    version: 2,
    createdAt: new Date().toISOString(),
    approval: {
      approverId: crypto.randomUUID(),
      approverName: 'Directeur',
      decision: 'APPROVE',
      reason: '',
      createdAt: new Date().toISOString(),
    },
    reservation: 'ACTIVE',
    evidence: [],
    voucher: null,
  };
  const voucher: PaymentVoucher = {
    id: crypto.randomUUID(),
    expenseRequestId: expense.id,
    operationId: crypto.randomUUID(),
    number: 'BON-TEST-2026-000001',
    currency: 'USD',
    amount: '20.00',
    beneficiary: expense.beneficiary!,
    description: expense.description,
    reference: expense.reference!,
    companyName: p.company.name,
    companyCode: 'TEST',
    agencyName: cash.agency.name,
    cashName: cash.name,
    requesterName: 'Bob',
    approverName: 'Directeur',
    cashierName: 'Alice',
    approvedAt: new Date().toISOString(),
    postedAt: new Date().toISOString(),
  };
  vi.mocked(gateway.expenseList).mockResolvedValue({
    items: [expense],
    total: 1,
    page: 1,
    pageSize: 25,
    synchronizedAt: new Date().toISOString(),
  });
  return { p, gateway, cash, expense, voucher };
}
async function requests() {
  await userEvent.click(screen.getByRole('tab', { name: 'Demandes et paiements' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Consulter' }));
}
describe('Dépenses desktop avec courtier explicitement simulé', () => {
  it('configure un plafond exact par rôle et devise sans donner de permission supplémentaire', async () => {
    const s = setup();
    s.p.permissions.push('cash:configure');
    vi.mocked(s.gateway.configureExpensePolicy).mockResolvedValue({
      currency: 'USD',
      version: 1,
      requireEvidence: true,
      limits: [{ role: 'DIRECTOR', action: 'APPROVE', maximum: '250.00' }],
      configuredAt: new Date().toISOString(),
    });
    render(<ExpensesPage profile={s.p} gateway={s.gateway} online />);
    await userEvent.click(screen.getByRole('tab', { name: 'Plafonds et règles' }));
    await userEvent.type(screen.getByLabelText('Approbation — Directeur'), '250,00');
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer les plafonds' }));
    await waitFor(() =>
      expect(s.gateway.configureExpensePolicy).toHaveBeenCalledWith('USD', {
        expectedVersion: null,
        requireEvidence: true,
        limits: [{ role: 'DIRECTOR', action: 'APPROVE', maximum: '250.00' }],
      }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Règles enregistrées');
    expect(s.gateway.decideExpense).not.toHaveBeenCalled();
    expect(s.gateway.payExpense).not.toHaveBeenCalled();
  });
  it('prépare une demande complète hors connexion sans soumission ni paiement', async () => {
    const s = setup();
    render(<ExpensesPage profile={s.p} gateway={s.gateway} online={false} />);
    await userEvent.click(screen.getByRole('button', { name: 'Préparer une demande' }));
    await userEvent.selectOptions(screen.getByLabelText('Caisse de paiement'), s.cash.id);
    await userEvent.selectOptions(screen.getByLabelText('Devise'), 'CDF');
    await userEvent.type(screen.getByLabelText('Montant exact'), '12,34');
    await userEvent.type(screen.getByLabelText('Bénéficiaire'), 'Bénéficiaire local');
    await userEvent.type(screen.getByLabelText('Motif'), 'Achat à préparer');
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer le brouillon' }));
    await waitFor(() => expect(s.gateway.saveDraft).toHaveBeenCalledOnce());
    expect(s.gateway.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        cashRegisterId: s.cash.id,
        draft: expect.objectContaining({
          kind: 'expense-request',
          amount: '12.34',
          currency: 'CDF',
          expenseDetails: { beneficiary: 'Bénéficiaire local', reference: '', documents: [] },
        }),
      }),
    );
    expect(s.gateway.submitExpense).not.toHaveBeenCalled();
    expect(s.gateway.decideExpense).not.toHaveBeenCalled();
    expect(s.gateway.payExpense).not.toHaveBeenCalled();
    expect(s.gateway.expenseList).not.toHaveBeenCalled();
    expect(screen.getByText(/Non soumis \/ Hors connexion/)).toBeInTheDocument();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
  it('ne soumet un brouillon synchronisé que sur une action explicite', async () => {
    const s = setup();
    const source = {
      id: s.expense.sourceDraftId!,
      clientDraftId: s.expense.clientDraftId!,
      agencyId: s.cash.agency.id,
      cashRegisterId: s.cash.id,
      version: 1,
      currency: 'USD' as const,
      amount: '20.00',
      description: 'Achat à soumettre',
      beneficiary: 'Fournisseur',
      reference: '',
      documentCount: 1,
      receivedAt: new Date().toISOString(),
      expenseRequestId: null,
    };
    vi.mocked(s.gateway.expenseDrafts).mockResolvedValue({
      items: [source],
      total: 1,
      page: 1,
      pageSize: 25,
    });
    vi.mocked(s.gateway.submitExpense).mockResolvedValue({
      ...s.expense,
      state: 'PENDING',
      version: 1,
      approval: null,
      reservation: null,
    });
    render(<ExpensesPage profile={s.p} gateway={s.gateway} online />);
    const submit = await screen.findByRole('button', { name: 'Soumettre la demande' });
    expect(s.gateway.submitExpense).not.toHaveBeenCalled();
    await userEvent.click(submit);
    await waitFor(() => expect(s.gateway.submitExpense).toHaveBeenCalledWith(source.id, 1, true));
    expect(s.gateway.decideExpense).not.toHaveBeenCalled();
    expect(s.gateway.payExpense).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('exige la remise effective avant de confirmer et affiche uniquement le bon retourné', async () => {
    const s = setup();
    vi.mocked(s.gateway.payExpense).mockResolvedValue(s.voucher);
    render(<ExpensesPage profile={s.p} gateway={s.gateway} online />);
    await requests();
    const confirm = screen.getByRole('button', { name: 'Confirmer le paiement' });
    expect(confirm).toBeDisabled();
    await userEvent.click(
      screen.getByRole('checkbox', { name: /Je confirme la remise effective/ }),
    );
    await userEvent.click(confirm);
    await waitFor(() => expect(s.gateway.payExpense).toHaveBeenCalledWith(s.expense.id, 2, true));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(s.voucher.number)).toBeInTheDocument();
    expect(within(dialog).getByText('Payé et comptabilisé')).toBeInTheDocument();
  });
  it('ne fabrique aucun bon après une perte de connexion et retrouve le résultat central', async () => {
    const s = setup();
    vi.mocked(s.gateway.payExpense).mockRejectedValue(new Error('SERVER_UNAVAILABLE'));
    render(<ExpensesPage profile={s.p} gateway={s.gateway} online />);
    await requests();
    await userEvent.click(
      screen.getByRole('checkbox', { name: /Je confirme la remise effective/ }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Confirmer le paiement' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Résultat non confirmé');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    vi.mocked(s.gateway.expenseList).mockResolvedValue({
      items: [
        {
          ...s.expense,
          state: 'PAID',
          version: 3,
          reservation: 'CONSUMED',
          voucher: { id: s.voucher.id, number: s.voucher.number },
        },
      ],
      total: 1,
      page: 1,
      pageSize: 25,
      synchronizedAt: new Date().toISOString(),
    });
    vi.mocked(s.gateway.paymentVoucher).mockResolvedValue(s.voucher);
    await userEvent.click(screen.getByRole('button', { name: 'Actualiser les demandes' }));
    await userEvent.click(
      await screen.findByRole('button', { name: `Consulter le bon ${s.voucher.number}` }),
    );
    expect(await screen.findByRole('dialog')).toHaveTextContent(s.voucher.number);
    expect(s.gateway.payExpense).toHaveBeenCalledOnce();
  });
  it('bloque les actions au passage hors connexion et réinitialise l’attestation', async () => {
    const s = setup();
    const r = render(<ExpensesPage profile={s.p} gateway={s.gateway} online />);
    await requests();
    await userEvent.click(
      screen.getByRole('checkbox', { name: /Je confirme la remise effective/ }),
    );
    r.rerender(<ExpensesPage profile={s.p} gateway={s.gateway} online={false} />);
    expect(
      screen.getByRole('checkbox', { name: /Je confirme la remise effective/ }),
    ).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Confirmer le paiement' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Confirmer le paiement' }));
    expect(s.gateway.payExpense).not.toHaveBeenCalled();
  });
  it('impose le motif du rejet et conserve la version de la demande', async () => {
    const s = setup();
    const pending = {
      ...s.expense,
      state: 'PENDING' as const,
      version: 1,
      approval: null,
      reservation: null,
    };
    vi.mocked(s.gateway.expenseList).mockResolvedValue({
      items: [pending],
      total: 1,
      page: 1,
      pageSize: 25,
      synchronizedAt: new Date().toISOString(),
    });
    vi.mocked(s.gateway.decideExpense).mockResolvedValue({
      ...pending,
      state: 'REJECTED',
      version: 2,
    });
    render(<ExpensesPage profile={s.p} gateway={s.gateway} online />);
    await requests();
    expect(screen.getByRole('button', { name: 'Rejeter la demande' })).toBeDisabled();
    await userEvent.type(
      screen.getByLabelText('Motif de décision (obligatoire pour un rejet)'),
      'Facture incorrecte',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Rejeter la demande' }));
    await waitFor(() =>
      expect(s.gateway.decideExpense).toHaveBeenCalledWith(pending.id, {
        expectedVersion: 1,
        decision: 'REJECT',
        reason: 'Facture incorrecte',
      }),
    );
    expect(s.gateway.payExpense).not.toHaveBeenCalled();
  });
  it('cache l’auto-approbation et les actions non autorisées', async () => {
    const s = setup();
    vi.mocked(s.gateway.expenseList).mockResolvedValue({
      items: [
        {
          ...s.expense,
          state: 'PENDING',
          version: 1,
          requestedById: s.p.user.id,
          approval: null,
          reservation: null,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 25,
      synchronizedAt: new Date().toISOString(),
    });
    render(<ExpensesPage profile={s.p} gateway={s.gateway} online />);
    await requests();
    expect(screen.getByText(/Vous ne pouvez pas approuver/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Approuver et réserver les fonds' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Plafonds et règles' })).not.toBeInTheDocument();
  });
  it('ne propose pas le paiement à un auditeur', async () => {
    const s = setup();
    s.p.permissions = ['ledger:read'];
    render(<ExpensesPage profile={s.p} gateway={s.gateway} online />);
    await requests();
    expect(screen.queryByRole('button', { name: 'Confirmer le paiement' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('tab', { name: 'Préparation et soumission' }),
    ).not.toBeInTheDocument();
  });
  it('annule la lecture des justificatifs au changement d’utilisateur', async () => {
    const s = setup();
    let resolve!: (buffer: ArrayBuffer) => void;
    const file = new File(['%PDF-1.4'], 'facture.pdf', { type: 'application/pdf' });
    file.arrayBuffer = () =>
      new Promise((r) => {
        resolve = r;
      });
    const r = render(
      <ExpenseForm
        gateway={s.gateway}
        profile={s.p}
        cashes={[s.cash]}
        source={null}
        copy={false}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await userEvent.type(screen.getByLabelText('Montant exact'), '10.00');
    await userEvent.type(screen.getByLabelText('Bénéficiaire'), 'Ancien utilisateur');
    await userEvent.type(screen.getByLabelText('Motif'), 'Motif privé');
    await userEvent.upload(screen.getByLabelText(/Justificatifs \(3 maximum/), file);
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer le brouillon' }));
    r.unmount();
    resolve(new TextEncoder().encode('%PDF-1.4').buffer);
    await Promise.resolve();
    expect(s.gateway.saveDraft).not.toHaveBeenCalled();
  });
});
