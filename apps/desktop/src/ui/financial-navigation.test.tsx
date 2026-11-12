import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { ROLE_PERMISSIONS, type RoleCode, type CashView } from '@caissepro/shared';
import { fakeGateway, profile, view } from '../auth/test-fixture';
import { ReceiptsPage } from '../cash/ReceiptsPage';
import { ExpensesPage } from '../expenses/ExpensesPage';
import { TransfersPage } from '../transfers/TransfersPage';
import { MoneyProvider } from '../money/MoneyContext';
import { App } from '../App';
import { CashPage } from '../cash/CashPage';

function fixture(roles: RoleCode[], scoped = true) {
  const p = profile('Compte test', roles[0]);
  p.roles = roles;
  p.permissions = [...new Set(roles.flatMap((r) => [...ROLE_PERMISSIONS[r]]))];
  const cash: CashView = {
    id: crypto.randomUUID(),
    agency: p.agencies[0]!,
    code: 'A',
    name: 'Caisse autorisée',
    active: true,
    version: 1,
    session: { id: crypto.randomUUID(), openedAt: new Date().toISOString() },
    funds: [{ currency: 'USD', balance: '100.00', reserved: '0.00', available: '100.00' }],
  };
  p.cashRegisters = scoped
    ? [{ id: cash.id, agencyId: cash.agency.id, code: cash.code, name: cash.name }]
    : [];
  const { gateway } = fakeGateway(view(p));
  vi.mocked(gateway.cashCatalog).mockResolvedValue({
    stale: false,
    data: {
      items: scoped ? [cash] : [],
      synchronizedAt: new Date().toISOString(),
      expiresAt: p.offlineUntil,
    },
  });
  return { p, gateway, cash };
}
describe('Accès financiers visibles, avec permissions standard et courtier simulé', () => {
  it('montre l’ouverture désactivée avec la raison pour un administrateur technique', async () => {
    const s = fixture(['ADMINISTRATOR']);
    vi.mocked(s.gateway.cashCatalog).mockResolvedValue({
      stale: false,
      data: {
        items: [{ ...s.cash, session: null }],
        synchronizedAt: new Date().toISOString(),
        expiresAt: s.p.offlineUntil,
      },
    });
    render(<CashPage profile={s.p} gateway={s.gateway} online onOpenReport={vi.fn()} />);
    const button = await screen.findByRole('button', { name: 'Ouvrir la session de caisse' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(/rôle financier avec gestion des sessions requis/);
    expect(s.gateway.openCashSession).not.toHaveBeenCalled();
  });
  it('cumule explicitement les rôles de l’administrateur dans Utilisateurs avec périmètre, version et confirmation', async () => {
    const s = fixture(['ADMINISTRATOR']);
    const user = {
      id: s.p.user.id,
      memberId: crypto.randomUUID(),
      email: s.p.user.email,
      displayName: s.p.user.displayName,
      active: true,
      roles: ['ADMINISTRATOR'] as RoleCode[],
      agencyIds: [s.cash.agency.id],
      cashRegisterIds: [s.cash.id],
      version: 4,
    };
    vi.mocked(s.gateway.catalog).mockResolvedValue({
      roles: Object.fromEntries(
        Object.entries(ROLE_PERMISSIONS).map(([role, permissions]) => [role, [...permissions]]),
      ) as Record<RoleCode, string[]>,
      agencies: s.p.agencies,
      cashRegisters: s.p.cashRegisters,
    });
    vi.mocked(s.gateway.users).mockResolvedValue([user]);
    vi.mocked(s.gateway.assignUser).mockResolvedValue(user);
    render(<App gateway={s.gateway} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Rôles et permissions' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Gérer les attributions' }));
    const mine = await screen.findByRole('button', { name: 'Examiner mes rôles et affectations' });
    await waitFor(() => expect(mine).toBeEnabled());
    await userEvent.click(mine);
    await userEvent.click(screen.getByRole('checkbox', { name: /Responsable financier/ }));
    expect(screen.getByRole('checkbox', { name: /^Administrateur/ })).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer les accès' }));
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'sessions de cet utilisateur seront révoquées',
    );
    expect(s.gateway.assignUser).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Confirmer' }));
    await waitFor(() =>
      expect(s.gateway.assignUser).toHaveBeenCalledExactlyOnceWith(
        user.id,
        {
          roles: ['ADMINISTRATOR', 'FINANCE_MANAGER'],
          agencyIds: [s.cash.agency.id],
          cashRegisterIds: [s.cash.id],
          active: true,
        },
        4,
      ),
    );
  });
  it.each([
    ['ADMINISTRATOR'],
    ['ADMINISTRATOR', 'FINANCE_MANAGER'],
    ['CASHIER'],
    ['FINANCE_MANAGER'],
  ] as RoleCode[][])(
    'nouvelle entrée selon les rôles explicites %j',
    async (...roles: RoleCode[]) => {
      const s = fixture(roles);
      render(<ReceiptsPage profile={s.p} gateway={s.gateway} online />);
      await waitFor(() => expect(s.gateway.cashCatalog).toHaveBeenCalled());
      const button = screen.getByRole('button', { name: '+ Nouvelle entrée' });
      if (roles.length === 1 && roles[0] === 'ADMINISTRATOR') {
        expect(button).toBeDisabled();
        expect(button).toHaveAccessibleDescription(/attribution explicite d’un rôle financier/);
        expect(s.gateway.receiptDrafts).not.toHaveBeenCalled();
      } else {
        expect(button).toBeEnabled();
        await userEvent.click(button);
        expect(await screen.findByLabelText('Provenance / payeur')).toBeVisible();
      }
      expect(s.gateway.confirmReceipt).not.toHaveBeenCalled();
    },
  );
  it('explique l’absence d’affectation même pour un caissier possédant le rôle requis', async () => {
    const s = fixture(['CASHIER'], false);
    render(<ReceiptsPage profile={s.p} gateway={s.gateway} online />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '+ Nouvelle entrée' })).toBeDisabled(),
    );
    expect(screen.getByRole('button', { name: '+ Nouvelle entrée' })).toHaveAccessibleDescription(
      /Aucune caisse active autorisée/,
    );
  });
  it('met en évidence la demande et filtre les demandes réellement reçues du serveur', async () => {
    const s = fixture(['CASHIER']);
    render(<ExpensesPage profile={s.p} gateway={s.gateway} online />);
    await userEvent.click(
      screen.getByRole('button', { name: 'Voir les demandes en attente de validation' }),
    );
    await waitFor(() =>
      expect(s.gateway.expenseList).toHaveBeenLastCalledWith(
        expect.objectContaining({ state: 'PENDING', page: 1 }),
      ),
    );
    expect(screen.getByRole('region', { name: 'Circuit des dépenses' })).toHaveTextContent(
      'Approuver : rôle requis',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Nouvelle demande de dépense' }));
    expect(await screen.findByLabelText('Bénéficiaire')).toBeVisible();
    expect(s.gateway.submitExpense).not.toHaveBeenCalled();
  });
  it('affiche les trois créations interdites à l’administrateur sans rôle financier', async () => {
    const s = fixture(['ADMINISTRATOR']);
    const component = render(<ExpensesPage profile={s.p} gateway={s.gateway} online />);
    expect(screen.getByRole('button', { name: 'Nouvelle demande de dépense' })).toBeDisabled();
    component.rerender(<TransfersPage profile={s.p} gateway={s.gateway} online />);
    expect(screen.getByRole('button', { name: 'Nouveau transfert' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Nouvelle conversion' })).toBeDisabled();
    expect(screen.queryByLabelText('Montant à remettre')).not.toBeInTheDocument();
  });
  it('ouvre le même formulaire de conversion, exige un choix explicite et préserve la saisie si on annule', async () => {
    const s = fixture(['FINANCE_MANAGER']);
    render(<TransfersPage profile={s.p} gateway={s.gateway} online />);
    await userEvent.click(screen.getByRole('button', { name: 'Nouvelle conversion' }));
    expect(screen.getByRole('heading', { name: 'Préparer une conversion' })).toBeVisible();
    expect(screen.getByLabelText('Devise source')).toHaveValue('USD');
    expect(screen.getByLabelText('Devise destination')).toHaveValue('CDF');
    await userEvent.type(screen.getByLabelText('Montant à remettre'), '2.00');
    await userEvent.click(screen.getByRole('button', { name: 'Nouveau transfert' }));
    await userEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(screen.getByLabelText('Montant à remettre')).toHaveValue('2.00');
    expect(screen.getByLabelText('Devise destination')).toHaveValue('CDF');
    expect(s.gateway.sendTransfer).not.toHaveBeenCalled();
    expect(s.gateway.handoverTransfer).not.toHaveBeenCalled();
  });
  it('interdit le raccourci conversion avec une seule devise active de l’entreprise', async () => {
    const s = fixture(['FINANCE_MANAGER']);
    const data = await s.gateway.moneyContext();
    vi.mocked(s.gateway.moneyContext).mockResolvedValue({
      ...data,
      companyCurrencies: [{ code: 'USD', active: true, version: 1 }],
    });
    render(
      <MoneyProvider gateway={s.gateway} online>
        <TransfersPage profile={s.p} gateway={s.gateway} online />
      </MoneyProvider>,
    );
    const button = await screen.findByRole('button', { name: 'Nouvelle conversion' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(/Deux devises actives/);
    expect(screen.getByRole('button', { name: 'Nouveau transfert' })).toBeEnabled();
  });
  it.each(['Journal de caisse', 'Clôturer la caisse'])(
    'relie %s à Rapports sans perdre l’identifiant de caisse ni exécuter de clôture',
    async (label) => {
      const s = fixture(['FINANCE_MANAGER']);
      render(<App gateway={s.gateway} />);
      await userEvent.click(await screen.findByRole('button', { name: 'Caisses' }));
      await userEvent.click(await screen.findByRole('button', { name: label }));
      await waitFor(() =>
        expect(s.gateway.reportSnapshot).toHaveBeenLastCalledWith({
          period: 'month',
          cashRegisterId: s.cash.id,
        }),
      );
      expect(screen.getByRole('button', { name: 'Rapports' })).toHaveAttribute(
        'aria-current',
        'page',
      );
      expect(s.gateway.closeCash).not.toHaveBeenCalled();
    },
  );
});
