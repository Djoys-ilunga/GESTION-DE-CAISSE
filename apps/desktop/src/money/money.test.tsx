import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import type { MoneyContext as Context, CashView } from '@caissepro/shared';
import { fakeGateway, view } from '../auth/test-fixture';
import { MoneyProvider, useMoney } from './MoneyContext';
import { ReceiptForm } from '../cash/ReceiptForm';
import { MoneyPage } from './MoneyPage';
async function setup() {
  const v = view(),
    g = fakeGateway(v).gateway;
  const context = await g.moneyContext();
  context.companyCurrencies = ['EUR', 'JPY', 'KWD'].map((code) => ({
    code,
    active: true,
    version: 1,
  }));
  context.preferences = {
    displayCurrency: 'EUR',
    favoriteCurrency: 'JPY',
    locale: 'en-US',
    version: 1,
  };
  vi.mocked(g.moneyContext).mockResolvedValue(context);
  vi.mocked(g.moneyPreferences).mockImplementation(async (input) => ({
    ...context,
    preferences: {
      displayCurrency: input.displayCurrency,
      favoriteCurrency: input.favoriteCurrency,
      locale: input.locale,
      version: input.expectedVersion + 1,
    },
  }));
  const cash: CashView = {
    id: crypto.randomUUID(),
    agency: v.profile!.agencies[0]!,
    code: 'C1',
    name: 'Caisse',
    active: true,
    version: 1,
    session: { id: crypto.randomUUID(), openedAt: new Date().toISOString() },
    funds: context.companyCurrencies.map((c) => ({
      currency: c.code,
      balance: c.code === 'KWD' ? '12.345' : '0',
      reserved: '0',
      available: '0',
    })),
  };
  return { g, context, v, cash };
}
function Probe() {
  const money = useMoney();
  return (
    <>
      <p>{money.format('9007199254740993.001')}</p>
      <button
        onClick={() =>
          void money.save({
            expectedVersion: money.data.preferences.version,
            favoriteCurrency: 'KWD',
            displayCurrency: 'KWD',
            locale: 'fr-FR',
          })
        }
      >
        Changer mes préférences
      </button>
    </>
  );
}
describe('Devises et préférences desktop avec passerelle simulée', () => {
  it('choisit la favorite uniquement pour le nouveau formulaire et conserve une saisie en cours', async () => {
    const s = await setup();
    render(
      <MoneyProvider gateway={s.g} online>
        <Probe />
        <ReceiptForm
          gateway={s.g}
          online
          cashes={[s.cash]}
          editing={null}
          onSaved={vi.fn()}
          onCancel={vi.fn()}
        />
      </MoneyProvider>,
    );
    const currency = await screen.findByLabelText('Devise');
    expect(currency).toHaveValue('JPY');
    expect(screen.getByLabelText('Montant')).toHaveAttribute('placeholder', '0');
    await userEvent.type(screen.getByLabelText('Montant'), '123');
    await userEvent.click(screen.getByRole('button', { name: 'Changer mes préférences' }));
    await screen.findByText('9 007 199 254 740 993,001');
    expect(currency).toHaveValue('JPY');
    expect(screen.getByLabelText('Montant')).toHaveValue('123');
    expect(s.g.confirmReceipt).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });
  it('préserve la devise réelle d’un brouillon restauré malgré une favorite différente', async () => {
    const s = await setup();
    render(
      <MoneyProvider gateway={s.g} online>
        <ReceiptForm
          gateway={s.g}
          cashes={[s.cash]}
          editing={{
            draft: {
              id: crypto.randomUUID(),
              kind: 'receipt',
              currency: 'KWD',
              amount: '12.345',
              description: 'Historique',
              createdAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 60000).toISOString(),
            },
            agencyId: s.cash.agency.id,
            cashRegisterId: s.cash.id,
            version: 1,
            serverVersion: null,
            state: 'local',
            result: null,
            updatedAt: new Date().toISOString(),
          }}
          onSaved={vi.fn()}
          onCancel={vi.fn()}
        />
      </MoneyProvider>,
    );
    expect(await screen.findByLabelText('Devise')).toHaveValue('KWD');
    expect(screen.getByLabelText('Montant')).toHaveValue('12.345');
  });
  it('propose une seule devise autorisée sans reconstruire les formulaires', async () => {
    const s = await setup();
    const context: Context = {
      ...s.context,
      companyCurrencies: [{ code: 'JPY', active: true, version: 1 }],
    };
    vi.mocked(s.g.moneyContext).mockResolvedValue(context);
    render(
      <MoneyProvider gateway={s.g} online>
        <ReceiptForm
          gateway={s.g}
          cashes={[s.cash]}
          editing={null}
          onSaved={vi.fn()}
          onCancel={vi.fn()}
        />
      </MoneyProvider>,
    );
    expect(await screen.findByLabelText('Devise')).toHaveValue('JPY');
    expect(
      screen
        .getAllByRole('option')
        .filter((o) => o.closest('select') === screen.getByLabelText('Devise')),
    ).toHaveLength(1);
  });
  it('désactive les changements hors connexion et ne stocke pas les préférences dans le navigateur', async () => {
    const s = await setup();
    render(
      <MoneyProvider gateway={s.g} online={false}>
        <MoneyPage gateway={s.g} profile={s.v.profile!} online={false} />
      </MoneyProvider>,
    );
    expect(
      await screen.findByRole('button', { name: 'Enregistrer mes préférences' }),
    ).toBeDisabled();
    await waitFor(() => expect(screen.getByText(/Hors connexion — paramètres/)).toBeVisible());
    expect(s.g.moneyPreferences).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });
});
