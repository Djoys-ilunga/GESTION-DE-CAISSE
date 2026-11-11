import { test, expect, type Page } from '@playwright/test';
import type {
  SessionProfile,
  NativeSessionView,
  TransferView,
  FormBuffer,
} from '@caissepro/shared';
async function installDouble(page: Page, offline = false) {
  await page.addInitScript(
    ({ offline }) => {
      const now = new Date().toISOString(),
        agency = crypto.randomUUID(),
        source = crypto.randomUUID(),
        destination = crypto.randomUUID();
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
          'draft:write_own',
          'draft:read_own',
          'draft:receive',
          'transfer:post',
          'fx:post',
          'offline:access',
        ],
        agencies: [{ id: agency, code: 'A', name: 'Agence' }],
        cashRegisters: [
          { id: source, agencyId: agency, code: 'A', name: 'Caisse source' },
          { id: destination, agencyId: agency, code: 'B', name: 'Caisse destination' },
        ],
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        idleExpiresAt: new Date(Date.now() + 900000).toISOString(),
        offlineUntil: new Date(Date.now() + 900000).toISOString(),
        validatedAt: now,
        locked: false,
        authorizationVersion: 1,
      };
      let logged = false,
        financial = 0;
      const buffers: FormBuffer[] = [];
      const row: TransferView = {
        id: crypto.randomUUID(),
        authorId: crypto.randomUUID(),
        sourceCashRegisterId: source,
        destinationCashRegisterId: destination,
        sourceCurrency: 'USD',
        destinationCurrency: 'CDF',
        amount: '20.00',
        targetAmount: '56000.00',
        rate: '2800.000000000000',
        rateSource: 'Guichet synthétique',
        description: 'Transfert synthétique vers agence',
        state: 'HANDED_OVER',
        version: 2,
        createdAt: now,
        handedOverAt: now,
        receivedAt: null,
        handedOverById: crypto.randomUUID(),
        receivedById: null,
        operationId: null,
        slip: null,
      };
      const status = (): NativeSessionView => ({
        state: logged ? (offline ? 'offline' : 'online') : 'anonymous',
        profile: logged ? p : null,
        displayName: logged ? 'Alice' : null,
        offlineUntil: logged ? p.offlineUntil : null,
        reason: null,
        generation: logged ? 1 : 0,
      });
      const host = window as unknown as {
        isTauri: boolean;
        transferDouble: { financial(): number; buffers(): number };
        __TAURI_INTERNALS__: {
          invoke(command: string, args: Record<string, unknown>): Promise<unknown>;
        };
      };
      host.isTauri = true;
      host.transferDouble = { financial: () => financial, buffers: () => buffers.length };
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
            return { status: 'ready' };
          }
          if (command === 'auth_login') {
            logged = true;
            return status();
          }
          if (['auth_status', 'auth_revalidate', 'auth_activity'].includes(command))
            return status();
          if (command === 'workspace_balances')
            return {
              data: { synchronizedAt: now, expiresAt: p.offlineUntil, balances: [] },
              stale: offline,
            };
          if (command === 'workspace_drafts' || command === 'workspace_sync') return [];
          if (command === 'cash_catalog')
            return {
              stale: offline,
              data: {
                synchronizedAt: now,
                expiresAt: p.offlineUntil,
                items: p.cashRegisters.map((r) => ({
                  id: r.id,
                  code: r.code,
                  name: r.name,
                  active: true,
                  version: 1,
                  agency: p.agencies[0],
                  session: null,
                  funds: [
                    { currency: 'USD', balance: '100.00', reserved: '20.00', available: '80.00' },
                    { currency: 'CDF', balance: '0.00', reserved: '0.00', available: '0.00' },
                  ],
                })),
              },
            };
          const payload = args.payload as Record<string, unknown>;
          if (command === 'workspace_sync_action') {
            if (args.action === 'buffers') return structuredClone(buffers);
            if (args.action === 'buffer-save') {
              const b = {
                ...payload,
                createdAt: now,
                updatedAt: now,
                expiresAt: p.offlineUntil,
              } as FormBuffer;
              buffers.push(b);
              return b;
            }
          }
          if (command === 'transfer_action') {
            if (offline) throw new Error('ONLINE_REQUIRED');
            if (args.action === 'list') return { items: [row], total: 1, page: 1, pageSize: 25 };
            if (args.action === 'detail') return structuredClone(row);
            if (args.action === 'receive') {
              if (payload.received !== true) throw new Error('REQUEST_INVALID');
              financial++;
              Object.assign(row, {
                state: 'RECEIVED',
                version: 3,
                receivedAt: now,
                receivedById: p.user.id,
                operationId: crypto.randomUUID(),
                slip: {
                  number: 'TRF-TEST-SYNTHETIQUE',
                  companyName: p.company.name,
                  companyCode: 'TEST',
                  sourceCashName: 'Caisse source',
                  destinationCashName: 'Caisse destination',
                  sourceAgencyName: 'Agence',
                  destinationAgencyName: 'Agence',
                  handedOverByName: 'Bob',
                  receivedByName: 'Alice',
                  handedOverAt: now,
                  receivedAt: now,
                  rounding: 'HALF_UP_2',
                },
              });
              return structuredClone(row);
            }
          }
          throw new Error('IPC_DOUBLE_UNHANDLED');
        },
      };
    },
    { offline },
  );
}
async function open(page: Page) {
  await page.goto('/');
  await page.getByLabel('Code entreprise').fill('TEST');
  await page.getByLabel('Adresse e-mail').fill('alice@example.test');
  await page.getByLabel('Mot de passe', { exact: true }).fill('Synthétique-test!');
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await page.getByRole('button', { name: 'Transferts et conversions', exact: true }).click();
}
test('préparation de transfert hors connexion sans appel financier (IPC simulé)', async ({
  page,
}) => {
  await installDouble(page, true);
  await open(page);
  await page
    .getByRole('combobox', { name: 'Caisse source', exact: true })
    .selectOption({ label: 'Agence · Caisse source' });
  await page
    .getByRole('combobox', { name: 'Caisse destination', exact: true })
    .selectOption({ label: 'Agence · Caisse destination' });
  await page.getByLabel('Montant à remettre').fill('20.00');
  await page.getByLabel('Motif', { exact: true }).fill('Préparation locale');
  await page.getByRole('button', { name: 'Conserver le brouillon' }).click();
  await expect(page.getByRole('button', { name: 'Transmettre ou retrouver' })).toBeDisabled();
  const result = await page.evaluate(() => {
    const d = (window as unknown as { transferDouble: { financial(): number; buffers(): number } })
      .transferDouble;
    return { financial: d.financial(), buffers: d.buffers() };
  });
  expect(result).toEqual({ financial: 0, buffers: 1 });
});
test('réception et bordereau imprimable dans Chromium (IPC simulé)', async ({ page }) => {
  await installDouble(page);
  await open(page);
  await page.getByRole('button', { name: /Transfert synthétique vers agence/ }).click();
  const confirm = page.getByRole('button', { name: 'Confirmer la réception et comptabiliser' });
  await expect(confirm).toBeDisabled();
  await page.getByLabel(/Je confirme la réception effective/).check();
  await confirm.click();
  await page.getByRole('button', { name: 'Voir le bordereau' }).click();
  await expect(page.getByRole('dialog')).toContainText('TRF-TEST-SYNTHETIQUE');
  await expect(page.getByRole('dialog')).toContainText('56\u202f000,00');
  await page.screenshot({ path: 'test-results/transfert-bordereau.png', fullPage: true });
  await page.pdf({
    path: 'test-results/transfert-bordereau.pdf',
    format: 'A4',
    printBackground: true,
  });
  expect(
    await page.evaluate(() =>
      (window as unknown as { transferDouble: { financial(): number } }).transferDouble.financial(),
    ),
  ).toBe(1);
});
