import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { ManagementSettings, Supervision } from '@caissepro/shared';
import { fakeGateway, profile, view } from '../auth/test-fixture';
import { SettingsPage } from './SettingsPage';
import { AuditPage } from './AuditPage';
import { NotificationCenter, OfflineOverview } from './Supervision';
import { Appearance } from '../ui/Appearance';
function setup() {
  const p = profile();
  p.permissions.push('cash:configure', 'users:manage', 'auth:logs:read');
  const { gateway } = fakeGateway(view(p));
  const now = new Date().toISOString();
  const data: ManagementSettings = {
    company: {
      ...p.company,
      address: 'Adresse réelle de test',
      phone: '',
      email: 'contact@example.test',
      taxId: 'TEST',
      version: 1,
      sessionMinutes: 480,
      idleMinutes: 15,
      offlineMinutes: 15,
    },
    agencies: [{ ...p.agencies[0]!, active: true, version: 1 }],
    categories: [],
    rates: [],
    generatedAt: now,
  };
  vi.mocked(gateway.settings).mockResolvedValue(data);
  vi.mocked(gateway.configureCompany).mockResolvedValue({ ok: true, sessionsRevoked: false });
  return { p, gateway, data, now };
}
afterEach(() => {
  localStorage.clear();
});
describe('Interface d’administration et supervision avec courtier simulé', () => {
  it('demande confirmation avant toute modification de l’entreprise et permet l’annulation au clavier', async () => {
    const s = setup();
    render(<SettingsPage gateway={s.gateway} profile={s.p} online />);
    const name = await screen.findByLabelText('Raison sociale');
    fireEvent.change(name, { target: { value: 'Nouvelle entreprise' } });
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer l’entreprise' }));
    expect(s.gateway.configureCompany).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Annuler' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(s.gateway.configureCompany).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer l’entreprise' }));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirmer' }),
    );
    await waitFor(() => expect(s.gateway.configureCompany).toHaveBeenCalledOnce());
    expect(vi.mocked(s.gateway.configureCompany).mock.calls[0]![0]).toMatchObject({
      name: 'Nouvelle entreprise',
      expectedVersion: 1,
      confirmed: true,
    });
    expect(vi.mocked(s.gateway.configureCompany).mock.calls[0]![0]).not.toHaveProperty('companyId');
  });
  it('annonce la révocation des sessions et applique uniquement la politique confirmée', async () => {
    const s = setup();
    vi.mocked(s.gateway.configureCompany).mockResolvedValue({ ok: true, sessionsRevoked: true });
    render(<SettingsPage gateway={s.gateway} profile={s.p} online />);
    await screen.findByLabelText('Raison sociale');
    await userEvent.click(screen.getByRole('button', { name: 'Sessions' }));
    fireEvent.change(screen.getByLabelText('Accès hors connexion maximal (minutes)'), {
      target: { value: '0' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer les durées' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('y compris la vôtre');
    expect(s.gateway.configureCompany).not.toHaveBeenCalled();
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirmer' }),
    );
    expect(await screen.findByText(/Durées enregistrées/)).toBeVisible();
    expect(s.gateway.settings).toHaveBeenCalledTimes(1);
    expect(vi.mocked(s.gateway.configureCompany).mock.calls[0]![0].offlineMinutes).toBe(0);
  });
  it('refuse de présenter des paramètres fictifs après une erreur serveur', async () => {
    const s = setup();
    vi.mocked(s.gateway.settings).mockRejectedValue(new Error('SERVER_UNAVAILABLE'));
    render(<SettingsPage gateway={s.gateway} profile={s.p} online />);
    expect(await screen.findByRole('alert')).toHaveTextContent('indisponible');
    expect(screen.queryByLabelText('Raison sociale')).not.toBeInTheDocument();
  });
  it('ignore une réponse ancienne après perte de connexion et nouveau chargement', async () => {
    const s = setup();
    let deliver!: (v: ManagementSettings) => void;
    vi.mocked(s.gateway.settings).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deliver = resolve;
        }),
    );
    const ui = render(<SettingsPage gateway={s.gateway} profile={s.p} online />);
    ui.rerender(<SettingsPage gateway={s.gateway} profile={s.p} online={false} />);
    expect(screen.getByText('Administration indisponible hors connexion')).toBeVisible();
    const current = { ...s.data, company: { ...s.data.company, name: 'Entreprise actuelle' } };
    vi.mocked(s.gateway.settings).mockResolvedValue(current);
    ui.rerender(<SettingsPage gateway={s.gateway} profile={s.p} online />);
    await waitFor(() =>
      expect(screen.getByLabelText('Raison sociale')).toHaveValue('Entreprise actuelle'),
    );
    await act(async () => deliver(s.data));
    expect(screen.getByLabelText('Raison sociale')).toHaveValue('Entreprise actuelle');
  });
  it('conserve l’identité de création d’une catégorie lors d’une reprise après erreur', async () => {
    const s = setup();
    vi.mocked(s.gateway.configureCategory)
      .mockRejectedValueOnce(new Error('SERVER_UNAVAILABLE'))
      .mockResolvedValueOnce({ ok: true });
    render(<SettingsPage gateway={s.gateway} profile={s.p} online />);
    await screen.findByLabelText('Raison sociale');
    await userEvent.click(screen.getByRole('button', { name: 'Catégories' }));
    fireEvent.change(screen.getByLabelText('Code de la catégorie'), { target: { value: 'LOYER' } });
    fireEvent.change(screen.getByLabelText('Libellé'), { target: { value: 'Loyer' } });
    await userEvent.selectOptions(screen.getByLabelText('Type de catégorie'), 'EXPENSE');
    for (let n = 0; n < 2; n++) {
      await userEvent.click(screen.getByRole('button', { name: 'Enregistrer la catégorie' }));
      expect(s.gateway.configureCategory).toHaveBeenCalledTimes(n);
      await userEvent.click(
        within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirmer' }),
      );
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    }
    const calls = vi.mocked(s.gateway.configureCategory).mock.calls;
    expect(calls[0]![0]).toEqual(calls[1]![0]);
    expect(calls[0]![0]).toMatchObject({ expectedVersion: null, kind: 'EXPENSE', confirmed: true });
  });
  it('filtre l’audit côté serveur et exporte les filtres appliqués sans utiliser les saisies non appliquées', async () => {
    const s = setup();
    s.p.cashRegisters = [
      {
        id: crypto.randomUUID(),
        agencyId: s.p.agencies[0]!.id,
        code: 'A',
        name: 'Caisse autorisée',
      },
    ];
    vi.mocked(s.gateway.saveAudit).mockResolvedValue({ saved: true });
    render(<AuditPage profile={s.p} gateway={s.gateway} online />);
    await screen.findByText('Aucun événement dans ce périmètre.');
    fireEvent.change(screen.getByLabelText('Du'), { target: { value: '2026-11-01' } });
    await userEvent.selectOptions(
      screen.getByLabelText('Caisse du journal'),
      s.p.cashRegisters[0]!.id,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Exporter le journal Excel' }));
    expect(s.gateway.saveAudit).toHaveBeenLastCalledWith('xlsx', { page: 1 });
    await userEvent.click(screen.getByRole('button', { name: 'Filtrer le journal' }));
    await waitFor(() =>
      expect(s.gateway.auditLog).toHaveBeenLastCalledWith({
        page: 1,
        from: '2026-10-31T23:00:00.000Z',
        cashRegisterId: s.p.cashRegisters[0]!.id,
      }),
    );
    await screen.findByText('Aucun événement dans ce périmètre.');
    await userEvent.click(screen.getByRole('button', { name: 'Exporter le journal PDF' }));
    expect(s.gateway.saveAudit).toHaveBeenLastCalledWith('pdf', {
      page: 1,
      from: '2026-10-31T23:00:00.000Z',
      cashRegisterId: s.p.cashRegisters[0]!.id,
    });
  });
  it('retire les événements sensibles du journal dès la perte de connexion', async () => {
    const s = setup();
    vi.mocked(s.gateway.auditLog).mockResolvedValue({
      generatedAt: s.now,
      page: 1,
      pageSize: 50,
      total: 1,
      items: [
        {
          id: crypto.randomUUID(),
          action: 'OPERATION_POSTED',
          targetType: 'OPERATION',
          targetId: crypto.randomUUID(),
          actorName: 'Responsable privé',
          createdAt: s.now,
        },
      ],
    });
    const ui = render(<AuditPage profile={s.p} gateway={s.gateway} online />);
    await screen.findByText('Responsable privé');
    ui.rerender(<AuditPage profile={s.p} gateway={s.gateway} online={false} />);
    expect(screen.queryByText('Responsable privé')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Exporter le journal PDF' }),
    ).not.toBeInTheDocument();
  });
  it('affiche uniquement les notifications serveur et les masque hors connexion', async () => {
    const s = setup(),
      navigate = vi.fn();
    const data: Supervision = {
      generatedAt: s.now,
      cash: [],
      users: null,
      notificationTotal: 1,
      notifications: [
        {
          id: 'expense-test',
          title: 'Dépense en attente',
          message: 'Montant privé réel du serveur',
          severity: 'info',
          target: 'expenses',
          createdAt: s.now,
        },
      ],
    };
    const ui = render(<NotificationCenter data={data} error="" online onNavigate={navigate} />);
    await userEvent.click(screen.getByRole('button', { name: 'Notifications internes' }));
    expect(screen.getByText('Montant privé réel du serveur')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Consulter' }));
    expect(navigate).toHaveBeenCalledWith('expenses');
    ui.rerender(<NotificationCenter data={data} error="" online={false} onNavigate={navigate} />);
    await userEvent.click(screen.getByRole('button', { name: 'Notifications internes' }));
    expect(screen.queryByText('Montant privé réel du serveur')).not.toBeInTheDocument();
    expect(screen.getByText(/Indisponibles hors connexion/)).toBeVisible();
  });
  it('signale les soldes locaux comme anciens sans demander de rapport en ligne', async () => {
    const s = setup();
    vi.mocked(s.gateway.cashCatalog).mockResolvedValue({
      stale: true,
      data: {
        items: [
          {
            id: crypto.randomUUID(),
            code: 'A',
            name: 'Caisse autorisée',
            agency: s.p.agencies[0]!,
            active: true,
            version: 1,
            session: null,
            funds: [{ currency: 'USD', balance: '12.34', reserved: '0.00', available: '12.34' }],
          },
        ],
        synchronizedAt: s.now,
        expiresAt: s.p.offlineUntil,
      },
    });
    render(<OfflineOverview gateway={s.gateway} profile={s.p} onNavigate={vi.fn()} />);
    expect(await screen.findByText(/Dernière lecture serveur/)).toHaveTextContent(
      'Ces montants ne sont pas actualisés',
    );
    expect(screen.getAllByText('12,34')).toHaveLength(2);
    expect(s.gateway.reportSnapshot).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });
  it('mémorise uniquement la préférence d’apparence et prend en charge le thème sombre', async () => {
    render(<Appearance />);
    await userEvent.selectOptions(screen.getByLabelText('Apparence'), 'dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.length).toBe(1);
    expect(localStorage.getItem('caissepro.appearance')).toBe('dark');
    await userEvent.selectOptions(screen.getByLabelText('Apparence'), 'light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
