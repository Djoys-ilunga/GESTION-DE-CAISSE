import { test, expect, type Page } from '@playwright/test';
import type {
  SessionProfile,
  NativeSessionView,
  ExpenseView,
  PaymentVoucher,
} from '@caissepro/shared';
import type { DraftInput, SessionDraft } from '../../apps/desktop/src/auth/gateway';

// Double IPC de présentation uniquement ; les finances réelles sont éprouvées séparément.
async function installDouble(page: Page, offline = false) {
  await page.addInitScript(
    ({ offline }) => {
      const now = new Date().toISOString(),
        agency = crypto.randomUUID(),
        cash = crypto.randomUUID();
      const p: SessionProfile = {
        sessionId: crypto.randomUUID(),
        deviceId: crypto.randomUUID(),
        user: {
          id: crypto.randomUUID(),
          displayName: 'Alice',
          email: 'alice@example.test',
          mustChangePassword: false,
        },
        company: { id: crypto.randomUUID(), code: 'TEST', name: 'Entreprise synthétique' },
        roles: ['FINANCE_MANAGER'],
        permissions: [
          'ledger:read',
          'draft:read_own',
          'draft:write_own',
          'draft:receive',
          'offline:access',
          'expense:request',
          'expense:approve',
          'expense:pay',
        ],
        agencies: [{ id: agency, code: 'A', name: 'Agence principale' }],
        cashRegisters: [{ id: cash, agencyId: agency, code: 'C1', name: 'Caisse principale' }],
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        idleExpiresAt: new Date(Date.now() + 900000).toISOString(),
        offlineUntil: new Date(Date.now() + 900000).toISOString(),
        validatedAt: now,
        locked: false,
        authorizationVersion: 1,
      };
      let logged = false,
        generation = 0,
        financialCalls = 0;
      const records: SessionDraft[] = [];
      const expense: ExpenseView = {
        id: crypto.randomUUID(),
        sourceDraftId: crypto.randomUUID(),
        clientDraftId: crypto.randomUUID(),
        agencyId: agency,
        cashRegisterId: cash,
        cashName: 'Caisse principale',
        agencyName: 'Agence principale',
        requestedById: crypto.randomUUID(),
        requesterName: 'Bob',
        currency: 'USD',
        amount: '20.00',
        description: 'Achat de fournitures de bureau',
        beneficiary: 'Fournisseur synthétique',
        reference: 'FACT-001',
        state: 'APPROVED',
        version: 2,
        createdAt: now,
        approval: {
          approverId: crypto.randomUUID(),
          approverName: 'Directrice synthétique',
          decision: 'APPROVE',
          reason: 'Facture vérifiée',
          createdAt: now,
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
        companyCode: p.company.code,
        agencyName: 'Agence principale',
        cashName: 'Caisse principale',
        requesterName: 'Bob',
        approverName: 'Directrice synthétique',
        cashierName: 'Alice',
        approvedAt: now,
        postedAt: now,
      };
      const status = (): NativeSessionView => ({
        state: !logged ? 'anonymous' : offline ? 'offline' : 'online',
        profile: logged ? p : null,
        displayName: logged ? 'Alice' : null,
        offlineUntil: logged ? p.offlineUntil : null,
        reason: null,
        generation,
      });
      const host = window as unknown as {
        isTauri: boolean;
        expenseDouble: { financialCalls(): number };
        __TAURI_INTERNALS__: {
          invoke(command: string, args: Record<string, unknown>): Promise<unknown>;
        };
      };
      host.isTauri = true;
      host.expenseDouble = { financialCalls: () => financialCalls };
      host.__TAURI_INTERNALS__ = {
        invoke: async (command, args) => {
          if (command === 'admin_request' && args.action === 'money-context')
            return {
              currencies: ['CDF', 'USD'].map((code) => ({
                code,
                numericCode: code === 'CDF' ? '976' : '840',
                name: code,
                symbol: code,
                precision: 2,
                active: true,
                bccRateStatus: 'UNVERIFIED',
                sourceDate: '2024-06-25',
              })),
              companyCurrencies: ['CDF', 'USD'].map((code) => ({ code, active: true, version: 1 })),
              preferences: {
                displayCurrency: null,
                favoriteCurrency: null,
                locale: 'fr-FR',
                version: 0,
              },
              reporting: { currency: null, version: 1 },
              generatedAt: new Date().toISOString(),
            };
          if (command === 'auth_health') {
            if (offline) throw new Error('SERVER_UNAVAILABLE');
            return {
              service: 'caissepro-api',
              protocolVersion: 2,
              deploymentId: 'caissepro-development',
              status: 'ready',
            };
          }
          if (command === 'auth_login') {
            logged = true;
            generation++;
            return status();
          }
          if (['auth_status', 'auth_revalidate', 'auth_activity'].includes(command))
            return status();
          if (command === 'workspace_balances')
            return {
              data: { synchronizedAt: now, expiresAt: p.offlineUntil, balances: [] },
              stale: offline,
            };
          if (command === 'workspace_drafts') return structuredClone(records);
          if (command === 'workspace_save_draft') {
            const input = args.input as DraftInput;
            const row: SessionDraft = {
              ...input,
              version: 1,
              serverVersion: null,
              state: 'local',
              result: null,
              updatedAt: now,
            };
            records.push(row);
            return row;
          }
          if (command === 'workspace_sync') {
            if (offline) throw new Error('ONLINE_REQUIRED');
            return [];
          }
          if (command === 'cash_catalog')
            return {
              data: {
                items: [
                  {
                    id: cash,
                    agency: p.agencies[0],
                    code: 'C1',
                    name: 'Caisse principale',
                    active: true,
                    version: 1,
                    session: { id: crypto.randomUUID(), openedAt: now },
                    funds: [
                      {
                        currency: 'USD',
                        balance: financialCalls ? '80.00' : '100.00',
                        reserved: financialCalls ? '0.00' : '20.00',
                        available: '80.00',
                      },
                      { currency: 'CDF', balance: '0.00', reserved: '0.00', available: '0.00' },
                    ],
                  },
                ],
                synchronizedAt: now,
                expiresAt: p.offlineUntil,
              },
              stale: offline,
            };
          if (command === 'expense_action') {
            if (offline) throw new Error('ONLINE_REQUIRED');
            const payload = args.payload as Record<string, unknown>;
            if (args.action === 'drafts') return { items: [], total: 0, page: 1, pageSize: 25 };
            if (args.action === 'list')
              return { items: [expense], total: 1, page: 1, pageSize: 25, synchronizedAt: now };
            if (args.action === 'pay') {
              if (payload.paid !== true || payload.id !== expense.id)
                throw new Error('REQUEST_INVALID');
              if (expense.state !== 'PAID') financialCalls++;
              expense.state = 'PAID';
              expense.version = 3;
              expense.reservation = 'CONSUMED';
              expense.voucher = { id: voucher.id, number: voucher.number };
              return voucher;
            }
            if (args.action === 'voucher') return voucher;
          }
          throw new Error('REQUEST_INVALID');
        },
      };
    },
    { offline },
  );
}
async function login(page: Page, offline = false) {
  await page.goto('/');
  await page.getByLabel('Code entreprise').fill('TEST');
  await page.getByLabel('Adresse e-mail').fill('alice@example.test');
  await page.getByLabel('Mot de passe', { exact: true }).fill('Mot-de-passe-synthétique');
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await expect(
    page.getByRole('heading', {
      name: offline ? 'Votre espace hors connexion' : /Bienvenue, Alice/,
    }),
  ).toBeVisible();
  if (offline)
    await expect(page.getByText(/Dernière lecture serveur/)).toHaveText(
      /Ces montants ne sont pas actualisés/,
    );
  await page.getByRole('button', { name: 'Dépenses', exact: true }).click();
}
test('paiement et bon de sortie dans Chromium avec double IPC explicite', async ({ page }) => {
  await installDouble(page);
  await login(page);
  await page.getByRole('tab', { name: 'Demandes et paiements' }).click();
  await page.getByRole('button', { name: 'Consulter', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Confirmer le paiement' })).toBeDisabled();
  await page.screenshot({ path: 'test-results/caissepro-depense-synthetique.png', fullPage: true });
  await page.getByLabel(/Je confirme la remise effective/).check();
  await page.getByRole('button', { name: 'Confirmer le paiement' }).click();
  await expect(page.getByRole('heading', { name: 'Bon de sortie' })).toBeVisible();
  await expect(page.locator('.official-receipt')).toContainText('BON-TEST-2026-000001');
  await page.screenshot({ path: 'test-results/caissepro-bon-synthetique.png', fullPage: true });
  await page.emulateMedia({ media: 'print' });
  const pdf = await page.pdf({
    path: 'test-results/caissepro-bon-synthetique.pdf',
    format: 'A4',
    printBackground: true,
  });
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  expect(pdf.toString('latin1').match(/\/Type\s*\/Page\b/g)).toHaveLength(1);
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { expenseDouble: { financialCalls(): number } }
      ).expenseDouble.financialCalls(),
    ),
  ).toBe(1);
});
test('demande hors connexion sans soumission ni paiement dans Chromium avec double IPC', async ({
  page,
}) => {
  await installDouble(page, true);
  await login(page, true);
  await page.getByRole('button', { name: 'Nouvelle demande de dépense' }).click();
  await page.getByLabel('Caisse de paiement').selectOption({ label: 'Caisse principale' });
  await page.getByRole('combobox', { name: 'Devise', exact: true }).selectOption('CDF');
  await page.getByLabel('Montant exact').fill('125,50');
  await page.getByLabel('Bénéficiaire', { exact: true }).fill('Fournisseur hors connexion');
  await page.getByLabel('Motif', { exact: true }).fill('Préparation sans paiement');
  await page.getByRole('button', { name: 'Enregistrer le brouillon' }).click();
  await expect(page.getByRole('cell', { name: '125,50 CDF' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Non soumis / Hors connexion' })).toBeVisible();
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { expenseDouble: { financialCalls(): number } }
      ).expenseDouble.financialCalls(),
    ),
  ).toBe(0);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});
