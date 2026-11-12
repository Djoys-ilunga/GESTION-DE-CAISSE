import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CashView, ReportSnapshot } from '@caissepro/shared';
import { profile, fakeGateway, view } from '../auth/test-fixture';
import { ReportsPage } from './ReportsPage';
function fixture() {
  const p = profile(),
    { gateway } = fakeGateway(view(p));
  const now = new Date().toISOString(),
    id = crypto.randomUUID();
  p.cashRegisters = [{ id, agencyId: p.agencies[0]!.id, code: 'A', name: 'Caisse A' }];
  const data: ReportSnapshot = {
    generatedAt: now,
    company: { name: 'Entreprise test', code: 'TEST' },
    timezone: 'Africa/Kinshasa',
    from: '2026-11-01',
    to: '2026-11-30',
    query: { period: 'month' },
    totals: ['CDF', 'USD'].map((c) => ({
      currency: c as 'CDF' | 'USD',
      balance: c === 'CDF' ? '280000.00' : '1000.00',
      reserved: '0.00',
      available: c === 'CDF' ? '280000.00' : '1000.00',
      opening: '0.00',
      closing: c === 'CDF' ? '280000.00' : '1000.00',
      receipts: c === 'CDF' ? '280000.00' : '1000.00',
      disbursements: '0.00',
      todayReceipts: '0.00',
      todayDisbursements: '0.00',
    })),
    cash: [
      {
        id,
        name: 'Caisse A',
        agencyId: p.agencies[0]!.id,
        agencyName: 'Agence A',
        currency: 'USD',
        balance: '1000.00',
        reserved: '0.00',
        available: '1000.00',
      },
    ],
    daily: [{ date: '2026-11-01', currency: 'USD', balance: '1000.00' }],
    rows: [
      {
        id: crypto.randomUUID(),
        operationId: crypto.randomUUID(),
        postedAt: now,
        kind: 'RECEIPT',
        cashRegisterId: id,
        cashName: 'Caisse A',
        agencyId: p.agencies[0]!.id,
        agencyName: 'Agence A',
        userId: p.user.id,
        userName: 'Alice',
        currency: 'USD',
        side: 'DEBIT',
        amount: '1000.00',
        category: 'VENTE',
        reference: 'REC-TEST-1',
      },
    ],
    groups: [],
    pending: [
      { currency: 'USD', count: 1, amount: '25.00' },
      { currency: 'CDF', count: 0, amount: '0.00' },
    ],
    decisions: [],
    closures: [],
    discrepancies: [
      { currency: 'CDF', measured: 0, count: 0, net: null },
      { currency: 'USD', measured: 0, count: 0, net: null },
    ],
    unmeasuredClosures: 1,
    users: [{ id: p.user.id, name: 'Alice' }],
  };
  vi.mocked(gateway.reportSnapshot).mockResolvedValue(data);
  return { p, gateway, data, id };
}
function closureFixture() {
  const s = fixture();
  s.p.permissions.push('session:manage');
  const items: CashView[] = ['A', 'B'].map((name) => ({
    id: crypto.randomUUID(),
    agency: s.p.agencies[0]!,
    code: name,
    name: 'Caisse ' + name,
    active: true,
    version: 1,
    session: { id: crypto.randomUUID(), openedAt: new Date().toISOString() },
    funds: ['CDF', 'USD'].map((currency) => ({
      currency,
      balance: '0.00',
      available: '0.00',
      reserved: '0.00',
    })),
  }));
  s.p.cashRegisters = items.map((c) => ({
    id: c.id,
    agencyId: c.agency.id,
    code: c.code,
    name: c.name,
  }));
  const catalog = {
    data: { items, synchronizedAt: new Date().toISOString(), expiresAt: s.p.offlineUntil },
    stale: false,
  };
  vi.mocked(s.gateway.cashCatalog).mockResolvedValue(catalog);
  return { ...s, items, catalog };
}
async function prepareClosure() {
  await screen.findByText('Trésorerie actuelle');
  await userEvent.click(screen.getByRole('tab', { name: 'Clôtures et écarts' }));
  await userEvent.click(screen.getByRole('button', { name: 'Préparer une clôture avec comptage' }));
  await screen.findByLabelText('Caisse à clôturer');
}
async function fillCounts(usd = '1000.00', cdf = '280000.00') {
  fireEvent.change(screen.getByLabelText('USD comptés'), { target: { value: usd } });
  fireEvent.change(screen.getByLabelText('CDF comptés'), { target: { value: cdf } });
  await userEvent.click(screen.getByRole('checkbox', { name: /Je confirme le comptage physique/ }));
}
describe('Rapports avec passerelle simulée', () => {
  it('prend la caisse du raccourci de clôture, exige le comptage et ne sélectionne jamais une autre caisse si elle a disparu', async () => {
    const s = closureFixture(),
      target = s.items[1]!;
    const component = render(
      <ReportsPage
        profile={s.p}
        gateway={s.gateway}
        online
        reports
        entry={{ tab: 'closures', cashRegisterId: target.id }}
      />,
    );
    await screen.findByText('Trésorerie actuelle');
    expect(screen.getByRole('tab', { name: 'Clôtures et écarts' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Préparer une clôture avec comptage' }),
    );
    await waitFor(() => expect(screen.getByLabelText('Caisse à clôturer')).toHaveValue(target.id));
    expect(screen.getByLabelText('USD comptés')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Clôturer et établir le PV' })).toBeDisabled();
    expect(s.gateway.closeCash).not.toHaveBeenCalled();
    component.unmount();
    vi.mocked(s.gateway.cashCatalog).mockResolvedValue({
      ...s.catalog,
      data: { ...s.catalog.data, items: [s.items[0]!] },
    });
    render(
      <ReportsPage
        profile={s.p}
        gateway={s.gateway}
        online
        reports
        entry={{ tab: 'closures', cashRegisterId: target.id }}
      />,
    );
    await screen.findByText('Trésorerie actuelle');
    await userEvent.click(
      screen.getByRole('button', { name: 'Préparer une clôture avec comptage' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Aucune autre caisse');
    expect(screen.getByLabelText('Caisse à clôturer')).toHaveValue('');
    expect(s.gateway.closeCash).not.toHaveBeenCalled();
  });
  it('exige un nouveau comptage et une confirmation après changement de caisse avant de clôturer', async () => {
    const s = closureFixture();
    vi.mocked(s.gateway.closeCash).mockResolvedValue({});
    render(<ReportsPage profile={s.p} gateway={s.gateway} online reports />);
    await prepareClosure();
    await userEvent.selectOptions(screen.getByLabelText('Caisse à clôturer'), s.items[0]!.id);
    await fillCounts();
    expect(screen.getByRole('button', { name: 'Clôturer et établir le PV' })).toBeEnabled();
    await userEvent.selectOptions(screen.getByLabelText('Caisse à clôturer'), s.items[1]!.id);
    expect(screen.getByLabelText('USD comptés')).toHaveValue('');
    expect(screen.getByLabelText('CDF comptés')).toHaveValue('');
    expect(
      screen.getByRole('checkbox', { name: /Je confirme le comptage physique/ }),
    ).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Clôturer et établir le PV' })).toBeDisabled();
    expect(s.gateway.closeCash).not.toHaveBeenCalled();
    await fillCounts('12.34', '500.00');
    await userEvent.click(screen.getByRole('button', { name: 'Clôturer et établir le PV' }));
    await waitFor(() =>
      expect(s.gateway.closeCash).toHaveBeenCalledExactlyOnceWith({
        cashRegisterId: s.items[1]!.id,
        sessionId: s.items[1]!.session!.id,
        confirmed: true,
        counts: [
          { currency: 'CDF', amount: '500.00' },
          { currency: 'USD', amount: '12.34' },
        ],
      }),
    );
    expect(await screen.findByText(/Clôture et procès-verbal enregistrés/)).toBeVisible();
  });
  it('ne réaffecte pas un comptage à une session nouvellement ouverte après actualisation', async () => {
    const s = closureFixture();
    const ui = render(<ReportsPage profile={s.p} gateway={s.gateway} online reports />);
    await prepareClosure();
    await userEvent.selectOptions(screen.getByLabelText('Caisse à clôturer'), s.items[0]!.id);
    await fillCounts();
    const refreshed = structuredClone(s.catalog);
    refreshed.data.items[0]!.session!.id = crypto.randomUUID();
    vi.mocked(s.gateway.cashCatalog).mockResolvedValue(refreshed);
    await userEvent.click(
      screen.getByRole('button', { name: 'Préparer une clôture avec comptage' }),
    );
    await waitFor(() => expect(s.gateway.cashCatalog).toHaveBeenCalledTimes(2));
    expect(await screen.findByLabelText('Caisse à clôturer')).toHaveValue('');
    expect(screen.queryByLabelText('USD comptés')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('CDF comptés')).not.toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: /Je confirme le comptage physique/ }),
    ).not.toBeChecked();
    expect(s.gateway.closeCash).not.toHaveBeenCalled();
    ui.rerender(<ReportsPage profile={s.p} gateway={s.gateway} online={false} reports />);
    expect(
      screen.queryByRole('button', { name: 'Clôturer et établir le PV' }),
    ).not.toBeInTheDocument();
  });
  it('ne remplace pas un serveur indisponible par des chiffres fictifs', async () => {
    const s = fixture();
    vi.mocked(s.gateway.reportSnapshot).mockRejectedValue(new Error('SERVER_UNAVAILABLE'));
    render(<ReportsPage profile={s.p} gateway={s.gateway} online />);
    expect(await screen.findByRole('alert')).toHaveTextContent('indisponible');
    expect(screen.queryByText('Trésorerie actuelle')).not.toBeInTheDocument();
  });
  it('retire les anciens indicateurs si une actualisation échoue', async () => {
    const s = fixture();
    render(<ReportsPage profile={s.p} gateway={s.gateway} online />);
    await screen.findByText('Trésorerie actuelle');
    vi.mocked(s.gateway.reportSnapshot).mockRejectedValueOnce(new Error('SERVER_UNAVAILABLE'));
    await userEvent.click(screen.getByRole('button', { name: 'Actualiser' }));
    await screen.findByRole('alert');
    expect(screen.queryByText('Trésorerie actuelle')).not.toBeInTheDocument();
  });
  it('bloque les rapports et exports hors connexion', () => {
    const s = fixture();
    render(<ReportsPage profile={s.p} gateway={s.gateway} online={false} />);
    expect(screen.getByText('Rapports indisponibles hors connexion')).toBeVisible();
    expect(s.gateway.reportSnapshot).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Excel' })).not.toBeInTheDocument();
  });
  it('présente les valeurs exactes du serveur dans des graphiques séparés par devise', async () => {
    const s = fixture();
    render(<ReportsPage profile={s.p} gateway={s.gateway} online />);
    await screen.findByText('Trésorerie actuelle');
    expect(screen.getByRole('img', { name: /Évolution observée.*USD/ })).toBeInTheDocument();
    expect(screen.getByText('Soldes de vos caisses')).toBeInTheDocument();
    expect(screen.getAllByText(/1\s000,00/).length).toBeGreaterThan(0);
  });
  it('applique les filtres seulement à la demande et exporte le rapport serveur appliqué', async () => {
    const s = fixture();
    render(<ReportsPage profile={s.p} gateway={s.gateway} online reports />);
    await screen.findByText('Trésorerie actuelle');
    fireEvent.change(screen.getByRole('combobox', { name: 'Période' }), {
      target: { value: 'year' },
    });
    expect(s.gateway.reportSnapshot).toHaveBeenCalledTimes(1);
    vi.mocked(s.gateway.saveReport).mockResolvedValue({ saved: true });
    await userEvent.click(screen.getByRole('button', { name: 'Excel' }));
    expect(s.gateway.saveReport).toHaveBeenCalledWith('xlsx', { period: 'month' });
    await userEvent.click(screen.getByRole('button', { name: 'Appliquer' }));
    await waitFor(() =>
      expect(s.gateway.reportSnapshot).toHaveBeenLastCalledWith({ period: 'year' }),
    );
  });
  it('filtre le journal local et signale les anciennes clôtures non mesurées', async () => {
    const s = fixture();
    render(<ReportsPage profile={s.p} gateway={s.gateway} online reports />);
    await screen.findByText('REC-TEST-1');
    fireEvent.change(screen.getByLabelText('Rechercher dans le journal'), {
      target: { value: 'introuvable' },
    });
    expect(screen.getByText('Aucun mouvement pour ces critères.')).toBeVisible();
    await userEvent.click(screen.getByRole('tab', { name: 'Clôtures et écarts' }));
    expect(screen.getByText(/1 clôture.*historique.*sans comptage/)).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Préparer une clôture avec comptage' }),
    ).not.toBeInTheDocument();
  });
  it('retire les données dès la perte de connexion', async () => {
    const s = fixture();
    const ui = render(<ReportsPage profile={s.p} gateway={s.gateway} online />);
    await screen.findByText('REC-TEST-1');
    ui.rerender(<ReportsPage profile={s.p} gateway={s.gateway} online={false} />);
    expect(screen.queryByText('REC-TEST-1')).not.toBeInTheDocument();
    expect(s.gateway.saveReport).not.toHaveBeenCalled();
  });
});
