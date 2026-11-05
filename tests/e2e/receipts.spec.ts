import { test, expect, type Page } from '@playwright/test';
import type { SessionProfile, NativeSessionView, ConfirmedReceipt } from '@caissepro/shared';
import type { DraftInput, SessionDraft } from '../../apps/desktop/src/auth/gateway';

// Double explicite du transport IPC. Les véritables finances sont testées séparément sur PostgreSQL.
async function installNativeDouble(page: Page) {
  await page.addInitScript(() => {
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
      roles: ['CASHIER'],
      permissions: [
        'directory:read',
        'ledger:read',
        'receipt:read',
        'receipt:post',
        'draft:write_own',
        'draft:read_own',
        'offline:access',
        'session:manage',
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
      offline = false,
      locked = false,
      generation = 0,
      financialCalls = 0,
      snapshotTime = now;
    const records: { row: SessionDraft; sourceId: string }[] = [],
      receipts: ConfirmedReceipt[] = [];
    const status = (): NativeSessionView => ({
      state: !logged ? 'anonymous' : locked ? 'locked' : offline ? 'offline' : 'online',
      profile: logged && !locked ? p : null,
      displayName: logged ? 'Alice' : null,
      offlineUntil: logged ? p.offlineUntil : null,
      reason: null,
      generation,
    });
    const host = window as unknown as {
      isTauri: boolean;
      __TAURI_INTERNALS__: {
        invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
      };
      receiptDouble: { offline(): void; financialCalls(): number };
    };
    host.isTauri = true;
    host.receiptDouble = {
      offline: () => {
        offline = true;
      },
      financialCalls: () => financialCalls,
    };
    host.__TAURI_INTERNALS__ = {
      invoke: async (command, args) => {
        if (command === 'auth_health') {
          if (offline) throw new Error('SERVER_UNAVAILABLE');
          return {
            service: 'caissepro-api',
            protocolVersion: 1,
            deploymentId: 'caissepro-development',
            status: 'ready',
          };
        }
        if (command === 'auth_status') return status();
        if (command === 'auth_login') {
          logged = true;
          generation++;
          return status();
        }
        if (command === 'auth_logout') {
          logged = false;
          generation++;
          records.length = 0;
          return status();
        }
        if (command === 'auth_lock') {
          locked = true;
          return status();
        }
        if (command === 'auth_unlock') {
          locked = false;
          return status();
        }
        if (command === 'auth_revalidate' || command === 'auth_activity') return status();
        if (command === 'cash_catalog') {
          if (!offline) snapshotTime = new Date().toISOString();
          const usd = receipts[0]?.amount ?? '0.00';
          return {
            data: {
              items: [
                {
                  id: cash,
                  agency: p.agencies[0],
                  code: 'C1',
                  name: 'Caisse principale',
                  version: 1,
                  active: true,
                  session: { id: crypto.randomUUID(), openedAt: now },
                  funds: [
                    { currency: 'CDF', balance: '0.00', reserved: '0.00', available: '0.00' },
                    { currency: 'USD', balance: usd, reserved: '0.00', available: usd },
                  ],
                },
              ],
              synchronizedAt: snapshotTime,
              expiresAt: p.offlineUntil,
            },
            stale: offline,
          };
        }
        if (command === 'workspace_balances')
          return {
            data: { synchronizedAt: snapshotTime, expiresAt: p.offlineUntil, balances: [] },
            stale: offline,
          };
        if (command === 'workspace_drafts') return structuredClone(records.map((r) => r.row));
        if (command === 'workspace_save_draft') {
          const input = args.input as DraftInput;
          const previous = records.find((r) => r.row.draft.id === input.draft.id);
          const row: SessionDraft = {
            draft: input.draft,
            agencyId: input.agencyId,
            cashRegisterId: input.cashRegisterId,
            version: (previous?.row.version ?? 0) + 1,
            serverVersion: previous?.row.serverVersion ?? null,
            state: 'local',
            result: null,
            updatedAt: new Date().toISOString(),
          };
          if (previous) previous.row = row;
          else records.push({ row, sourceId: crypto.randomUUID() });
          return structuredClone(row);
        }
        if (command === 'workspace_sync') {
          if (offline) throw new Error('ONLINE_REQUIRED');
          return records
            .filter((r) => r.row.state === 'local')
            .map((r) => {
              r.row.state = 'synced';
              r.row.serverVersion = r.row.version;
              return {
                draftId: r.row.draft.id,
                outcome: 'accepted-as-draft',
                code: 'draft-received',
              };
            });
        }
        if (command === 'cash_action') {
          if (offline) throw new Error('ONLINE_REQUIRED');
          const payload = (args.payload ?? {}) as Record<string, unknown>;
          if (args.action === 'pending')
            return {
              items: records
                .filter((r) => r.row.serverVersion !== null)
                .map(({ row, sourceId }) => ({
                  id: sourceId,
                  clientDraftId: row.draft.id,
                  agencyId: agency,
                  cashRegisterId: cash,
                  version: row.version,
                  currency: row.draft.currency,
                  amount: row.draft.amount,
                  description: row.draft.description,
                  provenance: row.draft.receiptDetails?.provenance ?? null,
                  category: row.draft.receiptDetails?.category ?? null,
                  reference: row.draft.receiptDetails?.reference ?? null,
                  hasEvidence: false,
                  receivedAt: row.updatedAt,
                  receiptId: row.confirmedReceiptId ?? null,
                  receiptNumber: row.receiptNumber ?? null,
                })),
              total: records.length,
              page: 1,
              pageSize: 25,
            };
          if (args.action === 'confirm') {
            financialCalls++;
            const source = records.find((r) => r.sourceId === payload.id);
            if (!source || payload.received !== true) throw new Error('REQUEST_INVALID');
            const existing = receipts.find((r) => r.sourceDraftId === source.sourceId);
            if (existing) return existing;
            const d = source.row.draft,
              details = d.receiptDetails!;
            const r: ConfirmedReceipt = {
              id: crypto.randomUUID(),
              number: 'REC-TEST-2026-000001',
              operationId: crypto.randomUUID(),
              clientDraftId: d.id,
              sourceDraftId: source.sourceId,
              version: source.row.version,
              cashRegisterId: cash,
              agencyId: agency,
              currency: d.currency,
              amount: d.amount,
              provenance: details.provenance,
              category: details.category,
              description: d.description,
              reference: details.reference,
              companyName: p.company.name,
              companyCode: p.company.code,
              agencyName: p.agencies[0]!.name,
              agencyCode: 'A',
              cashName: 'Caisse principale',
              cashCode: 'C1',
              cashierName: 'Alice',
              postedAt: new Date().toISOString(),
              evidence: null,
            };
            receipts.push(r);
            source.row.state = 'confirmed';
            source.row.confirmedReceiptId = r.id;
            source.row.receiptNumber = r.number;
            return r;
          }
          if (args.action === 'history')
            return {
              items: receipts,
              total: receipts.length,
              page: 1,
              pageSize: 25,
              synchronizedAt: new Date().toISOString(),
            };
          if (args.action === 'receipt') return receipts.find((r) => r.id === payload.id);
          if (args.action === 'open') return { id: crypto.randomUUID() };
        }
        throw new Error('REQUEST_INVALID');
      },
    };
  });
}
async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('Code entreprise').fill('TEST');
  await page.getByLabel('Adresse e-mail').fill('alice@example.test');
  await page.getByLabel('Mot de passe', { exact: true }).fill('Mot-de-passe-test-2026');
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Bienvenue, Alice/ })).toBeVisible();
  await page.getByRole('button', { name: 'Encaissements', exact: true }).click();
}
async function prepare(page: Page) {
  await page.getByRole('button', { name: 'Nouveau brouillon d’encaissement' }).click();
  await expect(page.getByRole('group', { name: 'Caisse d’encaissement' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Caisse', exact: true })).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Devise', exact: true }).selectOption('USD');
  await page.getByLabel('Montant', { exact: true }).fill('12,34');
  await page.getByLabel('Provenance / payeur').fill('Client synthétique');
  await page.getByLabel('Catégorie', { exact: true }).fill('Ventes');
  await page.getByLabel('Motif', { exact: true }).fill('Recette synthétique de contrôle');
  await page.getByRole('button', { name: 'Enregistrer le brouillon' }).click();
}
test('workflow desktop dans Chromium avec double IPC explicite : confirmation et reçu', async ({
  page,
}) => {
  await installNativeDouble(page);
  await login(page);
  await prepare(page);
  await expect(page.getByText('Brouillon non comptabilisé', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Transmettre les brouillons' }).click();
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { receiptDouble: { financialCalls(): number } }
      ).receiptDouble.financialCalls(),
    ),
  ).toBe(0);
  await page.getByRole('tab', { name: 'Suivi serveur' }).click();
  await page.getByRole('button', { name: 'Vérifier et confirmer' }).click();
  await expect(page.getByRole('button', { name: 'Confirmer et comptabiliser' })).toBeDisabled();
  await page.getByLabel(/J’atteste avoir effectivement reçu/).check();
  await page.getByRole('button', { name: 'Confirmer et comptabiliser' }).click();
  await expect(page.getByRole('heading', { name: 'Reçu d’encaissement' })).toBeVisible();
  await expect(page.locator('.official-receipt')).toContainText('12,34 USD');
  await expect(page.locator('.official-receipt')).toContainText('REC-TEST-2026-000001');
  await page.screenshot({ path: 'test-results/caissepro-recu-synthetique.png', fullPage: true });
  await page.emulateMedia({ media: 'print' });
  const pdf = await page.pdf({
    path: 'test-results/caissepro-recu-synthetique.pdf',
    format: 'A4',
    printBackground: true,
  });
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  expect(pdf.toString('latin1').match(/\/Type\s*\/Page\b/g)).toHaveLength(1);
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { receiptDouble: { financialCalls(): number } }
      ).receiptDouble.financialCalls(),
    ),
  ).toBe(1);
});
test('préparation hors connexion sans appel de confirmation avec double IPC explicite', async ({
  page,
}) => {
  await installNativeDouble(page);
  await login(page);
  await page.evaluate(() =>
    (window as unknown as { receiptDouble: { offline(): void } }).receiptDouble.offline(),
  );
  await expect(page.getByText(/Accès hors connexion limité jusqu’à/)).toBeVisible();
  await prepare(page);
  await expect(page.getByRole('button', { name: 'Transmettre les brouillons' })).toBeDisabled();
  await expect(page.getByText('Brouillon non comptabilisé', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Suivi serveur' }).click();
  await expect(
    page.getByText(/La consultation des transmissions et la confirmation exigent/),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { receiptDouble: { financialCalls(): number } }
      ).receiptDouble.financialCalls(),
    ),
  ).toBe(0);
});
