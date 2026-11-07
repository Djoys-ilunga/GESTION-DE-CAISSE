import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type CashSnapshot, type TransferView } from '@caissepro/shared';
import { fakeGateway, profile as makeProfile, view } from '../auth/test-fixture';
import { TransfersPage } from './TransfersPage';
function setup(online = true) {
  const p = makeProfile();
  p.permissions.push('transfer:post', 'fx:post');
  const a = crypto.randomUUID(),
    b = crypto.randomUUID();
  p.cashRegisters = [
    { id: a, agencyId: p.agencies[0]!.id, code: 'A', name: 'Caisse A' },
    { id: b, agencyId: p.agencies[0]!.id, code: 'B', name: 'Caisse B' },
  ];
  const { gateway } = fakeGateway(view(p));
  const snapshot: CashSnapshot = {
    stale: !online,
    data: {
      expiresAt: p.offlineUntil,
      synchronizedAt: new Date().toISOString(),
      items: p.cashRegisters.map((r) => ({
        ...r,
        active: true,
        version: 1,
        agency: p.agencies[0]!,
        session: { id: crypto.randomUUID(), openedAt: new Date().toISOString() },
        funds: [
          { currency: 'USD', balance: '100.00', reserved: '0.00', available: '100.00' },
          { currency: 'CDF', balance: '0.00', reserved: '0.00', available: '0.00' },
        ],
      })),
    },
  };
  vi.mocked(gateway.cashCatalog).mockResolvedValue(snapshot);
  const row: TransferView = {
    id: crypto.randomUUID(),
    authorId: p.user.id,
    sourceCashRegisterId: a,
    destinationCashRegisterId: b,
    sourceCurrency: 'USD',
    destinationCurrency: 'USD',
    amount: '20.00',
    targetAmount: '20.00',
    rate: null,
    rateSource: '',
    description: 'Approvisionnement agence',
    state: 'DRAFT',
    version: 1,
    createdAt: new Date().toISOString(),
    handedOverAt: null,
    receivedAt: null,
    handedOverById: null,
    receivedById: null,
    operationId: null,
    slip: null,
  };
  vi.mocked(gateway.transferList).mockResolvedValue({
    items: [row],
    total: 1,
    page: 1,
    pageSize: 25,
  });
  vi.mocked(gateway.transferDetail).mockResolvedValue(row);
  return { p, gateway, row, a, b };
}
async function open(s: ReturnType<typeof setup>, online = true) {
  render(<TransfersPage profile={s.p} gateway={s.gateway} online={online} />);
  await waitFor(() =>
    expect(screen.getByLabelText('Caisse source').querySelectorAll('option')).toHaveLength(3),
  );
}
async function fill(s: ReturnType<typeof setup>) {
  fireEvent.change(screen.getByLabelText('Caisse source'), { target: { value: s.a } });
  fireEvent.change(screen.getByLabelText('Caisse destination'), { target: { value: s.b } });
  fireEvent.change(screen.getByLabelText('Montant à remettre'), { target: { value: '20.00' } });
  fireEvent.change(screen.getByLabelText('Motif'), { target: { value: 'Approvisionnement' } });
}
describe('Écrans de transfert avec courtier simulé', () => {
  it('prépare hors connexion sans transmission ni modification des soldes', async () => {
    const s = setup(false);
    await open(s, false);
    await fill(s);
    await userEvent.click(screen.getByRole('button', { name: 'Conserver le brouillon' }));
    await waitFor(() => expect(s.gateway.saveFormBuffer).toHaveBeenCalled());
    expect(s.gateway.saveFormBuffer).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'transfer',
        fields: expect.objectContaining({ amount: '20.00' }),
      }),
    );
    expect(s.gateway.sendTransfer).not.toHaveBeenCalled();
    expect(s.gateway.handoverTransfer).not.toHaveBeenCalled();
    expect(s.gateway.receiveTransfer).not.toHaveBeenCalled();
    expect(screen.getByText(/Disponible non actualisé/)).toHaveTextContent('100,00 USD');
  });
  it('exige des caisses distinctes pour une même devise', async () => {
    const s = setup();
    await open(s);
    await fill(s);
    fireEvent.change(screen.getByLabelText('Caisse destination'), { target: { value: s.a } });
    await userEvent.click(screen.getByRole('button', { name: 'Conserver le brouillon' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Vérifiez');
    expect(s.gateway.saveFormBuffer).not.toHaveBeenCalled();
  });
  it('sépare le taux, la remise et la transmission du brouillon', async () => {
    const s = setup();
    Object.assign(s.row, {
      destinationCurrency: 'CDF',
      targetAmount: '56000.00',
      rate: '2800.000000000000',
      rateSource: 'Guichet',
    });
    await open(s);
    await userEvent.click(screen.getByRole('button', { name: /Approvisionnement agence/ }));
    const button = screen.getByRole('button', { name: 'Confirmer la remise' });
    expect(button).toBeDisabled();
    await userEvent.click(screen.getByLabelText(/Je confirme la remise effective/));
    expect(button).toBeDisabled();
    await userEvent.click(screen.getByLabelText(/Je valide explicitement ce taux/));
    expect(button).toBeEnabled();
    vi.mocked(s.gateway.handoverTransfer).mockResolvedValue({
      ...s.row,
      state: 'HANDED_OVER',
      version: 2,
      handedOverById: s.p.user.id,
      handedOverAt: new Date().toISOString(),
    });
    await userEvent.click(button);
    await waitFor(() =>
      expect(s.gateway.handoverTransfer).toHaveBeenCalledWith(s.row.id, 1, true, true),
    );
    expect(s.gateway.receiveTransfer).not.toHaveBeenCalled();
  });
  it('interdit la réception par la personne qui a remis les fonds', async () => {
    const s = setup();
    Object.assign(s.row, {
      state: 'HANDED_OVER',
      version: 2,
      handedOverById: s.p.user.id,
      handedOverAt: new Date().toISOString(),
    });
    await open(s);
    await userEvent.click(screen.getByRole('button', { name: /Approvisionnement agence/ }));
    expect(screen.getByText(/Un autre utilisateur autorisé doit/)).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Confirmer la réception et comptabiliser' }),
    ).not.toBeInTheDocument();
  });
  it('la réception est explicite et le bordereau provient de la réponse serveur', async () => {
    const s = setup();
    Object.assign(s.row, {
      state: 'HANDED_OVER',
      version: 2,
      handedOverById: crypto.randomUUID(),
      handedOverAt: new Date().toISOString(),
    });
    const received: TransferView = {
      ...s.row,
      state: 'RECEIVED',
      version: 3,
      receivedById: s.p.user.id,
      receivedAt: new Date().toISOString(),
      operationId: crypto.randomUUID(),
      slip: {
        number: 'TRF-TEST-001',
        companyName: 'Société',
        companyCode: 'TEST',
        sourceCashName: 'Caisse A',
        destinationCashName: 'Caisse B',
        sourceAgencyName: 'Agence A',
        destinationAgencyName: 'Agence B',
        handedOverByName: 'Alice',
        receivedByName: 'Bob',
        handedOverAt: s.row.handedOverAt!,
        receivedAt: new Date().toISOString(),
        rounding: 'HALF_UP_2',
      },
    };
    vi.mocked(s.gateway.receiveTransfer).mockResolvedValue(received);
    await open(s);
    await userEvent.click(screen.getByRole('button', { name: /Approvisionnement agence/ }));
    const button = screen.getByRole('button', { name: 'Confirmer la réception et comptabiliser' });
    expect(button).toBeDisabled();
    await userEvent.click(screen.getByLabelText(/Je confirme la réception effective/));
    await userEvent.click(button);
    await waitFor(() => expect(s.gateway.receiveTransfer).toHaveBeenCalledWith(s.row.id, 2, true));
    await userEvent.click(screen.getByRole('button', { name: 'Voir le bordereau' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('TRF-TEST-001');
  });
  it('ne montre aucune action financière à un lecteur et retire les détails hors connexion', async () => {
    const s = setup();
    s.p.permissions = ['ledger:read'];
    const ui = render(<TransfersPage profile={s.p} gateway={s.gateway} online />);
    await userEvent.click(await screen.findByRole('button', { name: /Approvisionnement agence/ }));
    expect(screen.queryByRole('button', { name: 'Confirmer la remise' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Conserver le brouillon' }),
    ).not.toBeInTheDocument();
    ui.rerender(<TransfersPage profile={s.p} gateway={s.gateway} online={false} />);
    expect(screen.queryByText('Détail du transfert')).not.toBeInTheDocument();
  });
});
