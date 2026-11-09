import { test, expect, type Page } from '@playwright/test';
import type { SessionProfile, NativeSessionView, ReportSnapshot } from '@caissepro/shared';
async function install(page: Page) {
  await page.addInitScript(() => {
    const id = () => crypto.randomUUID(),
      now = new Date().toISOString(),
      cash = id(),
      agency = id();
    let logged = false;
    const p: SessionProfile = {
      sessionId: id(),
      deviceId: id(),
      user: {
        id: id(),
        email: 'audit@example.test',
        displayName: 'Alice',
        mustChangePassword: false,
      },
      company: { id: id(), name: 'Entreprise SYNTHÉTIQUE — test IPC', code: 'TEST' },
      roles: ['AUDITOR'],
      permissions: ['ledger:read', 'offline:access'],
      agencies: [{ id: agency, code: 'A', name: 'Agence de test' }],
      cashRegisters: [{ id: cash, agencyId: agency, code: 'C', name: 'Caisse test' }],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      idleExpiresAt: new Date(Date.now() + 900000).toISOString(),
      offlineUntil: new Date(Date.now() + 900000).toISOString(),
      validatedAt: now,
      locked: false,
      authorizationVersion: 1,
    };
    const snapshot: ReportSnapshot = {
      generatedAt: now,
      company: { name: p.company.name, code: 'TEST' },
      timezone: 'Africa/Kinshasa',
      from: '2026-11-01',
      to: '2026-11-30',
      query: { period: 'month' },
      cash: [
        {
          id: cash,
          name: 'Caisse test',
          agencyId: agency,
          agencyName: 'Agence de test',
          currency: 'USD',
          balance: '1234.56',
          reserved: '100.00',
          available: '1134.56',
        },
      ],
      totals: (['CDF', 'USD'] as const).map((currency) => ({
        currency,
        balance: currency === 'USD' ? '1234.56' : '2800000.00',
        reserved: '0.00',
        available: currency === 'USD' ? '1234.56' : '2800000.00',
        receipts: '100.00',
        disbursements: '25.00',
        opening: '0.00',
        closing: currency === 'USD' ? '1234.56' : '2800000.00',
        todayReceipts: '100.00',
        todayDisbursements: '25.00',
      })),
      daily: (['CDF', 'USD'] as const).flatMap((currency) => [
        { currency, date: '2026-11-01', balance: '100.00' },
        { currency, date: '2026-11-02', balance: currency === 'USD' ? '1234.56' : '2800000.00' },
      ]),
      rows: [
        {
          id: id(),
          operationId: id(),
          postedAt: now,
          kind: 'RECEIPT',
          cashRegisterId: cash,
          cashName: 'Caisse test',
          agencyId: agency,
          agencyName: 'Agence de test',
          userId: p.user.id,
          userName: 'Alice',
          currency: 'USD',
          side: 'DEBIT',
          amount: '100.00',
          category: 'VENTE',
          reference: 'REC-SYNTHETIQUE',
        },
      ],
      groups: [],
      pending: [
        { currency: 'USD', count: 2, amount: '50.00' },
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
    const status = (): NativeSessionView => ({
      state: logged ? 'online' : 'anonymous',
      profile: logged ? p : null,
      displayName: logged ? 'Alice' : null,
      offlineUntil: logged ? p.offlineUntil : null,
      reason: null,
      generation: logged ? 1 : 0,
    });
    const host = window as unknown as {
      isTauri: boolean;
      __TAURI_INTERNALS__: { invoke(c: string, a: Record<string, unknown>): Promise<unknown> };
    };
    host.isTauri = true;
    host.__TAURI_INTERNALS__ = {
      invoke: async (c, a) => {
        if (c === 'auth_health') return { status: 'ready' };
        if (c === 'auth_login') {
          logged = true;
          return status();
        }
        if (['auth_status', 'auth_activity', 'auth_revalidate'].includes(c)) return status();
        if (c === 'report_action') {
          if (a.action === 'snapshot') return snapshot;
          if (a.action === 'save-pdf' || a.action === 'save-xlsx') return { saved: true };
        }
        throw new Error('IPC_DOUBLE_UNHANDLED');
      },
    };
  });
}
async function login(page: Page) {
  await install(page);
  await page.goto('/');
  await page.getByLabel('Code entreprise').fill('TEST');
  await page.getByLabel('Adresse e-mail').fill('audit@example.test');
  await page.getByLabel('Mot de passe', { exact: true }).fill('Synthetique-test!');
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await expect(page.getByText('Trésorerie actuelle')).toBeVisible();
}
test('tableau de bord lisible et rapports filtrables avec IPC explicitement simulé', async ({
  page,
}) => {
  await login(page);
  await expect(page.getByRole('img', { name: /trésorerie en USD/ })).toBeVisible();
  await expect(page.getByRole('img', { name: /trésorerie en CDF/ })).toBeVisible();
  await page.screenshot({
    path: 'test-results/rapports-dashboard-synthetique.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Rapports', exact: true }).click();
  await page.getByLabel('Rechercher dans le journal').fill('inexistant');
  await expect(page.getByText('Aucun mouvement pour ces critères.')).toBeVisible();
  await page.getByRole('button', { name: 'Excel', exact: true }).click();
  await expect(page.getByText('Rapport enregistré à l’emplacement choisi.')).toBeVisible();
  await page.getByRole('tab', { name: 'Clôtures et écarts' }).click();
  await expect(page.getByText(/1 clôture.*historique.*sans comptage/)).toBeVisible();
});
test('tableau de bord adaptable à une fenêtre de 650 pixels, sans débordement global', async ({
  page,
}) => {
  await page.setViewportSize({ width: 650, height: 900 });
  await login(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'test-results/rapports-mobile-synthetique.png', fullPage: true });
});
