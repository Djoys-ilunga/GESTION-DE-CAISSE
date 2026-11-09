import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReportSnapshot } from '@caissepro/shared';
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
describe('Rapports avec passerelle simulée', () => {
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
