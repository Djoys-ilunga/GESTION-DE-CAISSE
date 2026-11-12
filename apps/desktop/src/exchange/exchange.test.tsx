import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ROLE_PERMISSIONS, type BccRates, type ExchangeQuote } from '@caissepro/shared';
import { fakeGateway, profile, view } from '../auth/test-fixture';
import { ExchangePage } from './ExchangePage';
function setup(approved = false) {
  const p = profile('Test', 'FINANCE_MANAGER');
  p.permissions = [...ROLE_PERMISSIONS.FINANCE_MANAGER];
  const { gateway } = fakeGateway(view(p)),
    now = new Date().toISOString();
  const publication = {
    id: crypto.randomUUID(),
    sourceUrl: 'https://www.bcc.cd/marche-des-changes/cours-de-change',
    sourceReference: 'Publication synthétique pour test',
    publicationDate: '2026-11-11',
    publishedAt: null,
    retrievedAt: now,
    contentSha256: 'a'.repeat(64),
    connectorVersion: 'SYNTHETIC-TEST-ONLY',
  };
  const quote = {
    currency: 'USD',
    unit: '100' as const,
    unitEvidence: 'Fixture : cent USD',
    rawBuy: '240000.000000000000',
    rawMean: '250000.000000000000',
    rawSell: '260000.000000000000',
    buy: '2400.000000000000000000',
    mean: '2500.000000000000000000',
    sell: '2600.000000000000000000',
  };
  const data: BccRates = {
    generatedAt: now,
    source: {
      state: approved ? 'READY' : 'UNVERIFIED',
      code: 'TEST',
      approved,
      checkedAt: null,
      lastSuccessAt: null,
      nextAllowedAt: null,
      sourceUrl: publication.sourceUrl,
    },
    policy: {
      allowManual: true,
      quoteKind: 'MEAN',
      maxAgeHours: 96,
      quoteTtlMinutes: 15,
      version: 1,
    },
    publication: approved ? publication : null,
    quotes: approved ? [quote] : [],
    currencies: [
      { code: 'USD', name: 'Dollar américain', activeForCompany: true, covered: approved },
      { code: 'JPY', name: 'Yen', activeForCompany: false, covered: false },
    ],
    stale: !approved,
    freshUntil: approved ? new Date(Date.now() + 3600000).toISOString() : null,
  };
  vi.mocked(gateway.exchangeRates).mockResolvedValue(data);
  vi.mocked(gateway.exchangeHistory).mockResolvedValue({
    items: approved ? [{ ...publication, quotes: [quote] }] : [],
    total: approved ? 1 : 0,
    page: 1,
    pageSize: 25,
  });
  const proposed: ExchangeQuote = {
    id: crypto.randomUUID(),
    fromCurrency: 'USD',
    toCurrency: 'CDF',
    amount: '2.00',
    targetAmount: '5000.00',
    mode: 'MANUAL',
    quoteKind: 'MEAN',
    referenceRate: null,
    appliedRate: '2500.000000000000',
    source: 'Guichet synthétique',
    justification: 'Accord de test',
    effectiveAt: now,
    createdAt: now,
    expiresAt: new Date(Date.now() + 900000).toISOString(),
    publicationId: null,
    policyVersion: 1,
    snapshot: { kind: 'MANUAL' },
  };
  vi.mocked(gateway.exchangeQuote).mockResolvedValue(proposed);
  return { p, gateway, data, proposed };
}
describe('Taux de change desktop, passerelle simulée', () => {
  it('signale la source non vérifiée et bloque la simulation officielle sans inventer de cours', async () => {
    const s = setup();
    render(<ExchangePage profile={s.p} gateway={s.gateway} online />);
    await screen.findByText(/Source BCC non vérifiée/);
    expect(screen.getByRole('button', { name: 'Simuler avec le serveur' })).toBeDisabled();
    expect(screen.queryByText('2500.000000000000000000')).not.toBeInTheDocument();
    expect(s.gateway.exchangeQuote).not.toHaveBeenCalled();
  });
  it('présente les trois cours normalisés, la date et les unités de l’historique', async () => {
    const s = setup(true);
    render(<ExchangePage profile={s.p} gateway={s.gateway} online />);
    expect(await screen.findByText('2500.000000000000000000')).toBeInTheDocument();
    expect(screen.getByText('2026-11-11')).toBeInTheDocument();
    expect(screen.getByText(/250000.000000000000 \/ 2500/)).toBeInTheDocument();
    expect(screen.getByText('Taux BCC indisponible')).toBeInTheDocument();
  });
  it('retire toutes les cotations au passage hors connexion et ne transmet aucune demande', async () => {
    const s = setup(true),
      r = render(<ExchangePage profile={s.p} gateway={s.gateway} online />);
    await screen.findByText('2500.000000000000000000');
    r.rerender(<ExchangePage profile={s.p} gateway={s.gateway} online={false} />);
    expect(screen.queryByText('2500.000000000000000000')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Hors connexion');
    expect(s.gateway.exchangeQuote).not.toHaveBeenCalled();
    expect(s.gateway.refreshExchange).not.toHaveBeenCalled();
  });
  it('simule un taux manuel explicitement justifié sans appeler un paiement ou un transfert', async () => {
    const s = setup();
    render(<ExchangePage profile={s.p} gateway={s.gateway} online />);
    await screen.findByRole('heading', { name: 'Simulateur de conversion' });
    await userEvent.selectOptions(screen.getByLabelText('Origine du taux'), 'MANUAL');
    await userEvent.type(screen.getByLabelText('Montant à simuler'), '2.00');
    await userEvent.type(screen.getByLabelText('Taux manuel'), '2500');
    await userEvent.type(screen.getByLabelText('Source manuelle'), 'Guichet synthétique');
    await userEvent.type(screen.getByLabelText('Justification'), 'Accord de test');
    await userEvent.click(screen.getByRole('button', { name: 'Simuler avec le serveur' }));
    await waitFor(() => expect(s.gateway.exchangeQuote).toHaveBeenCalledOnce());
    expect(s.gateway.exchangeQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'MANUAL',
        manualRate: '2500',
        justification: 'Accord de test',
      }),
    );
    expect(s.gateway.sendTransfer).not.toHaveBeenCalled();
    expect(s.gateway.payExpense).not.toHaveBeenCalled();
    expect(await screen.findByText(/Taux appliqué : 2500/)).toBeInTheDocument();
  });
  it('réserve l’actualisation et la politique aux permissions de configuration', async () => {
    const s = setup();
    s.p.permissions = ['ledger:read'];
    render(<ExchangePage profile={s.p} gateway={s.gateway} online />);
    await screen.findByText(/Source BCC non vérifiée/);
    expect(
      screen.queryByRole('button', { name: 'Actualiser la source BCC' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Politique de change de l’entreprise' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Taux manuel justifié' })).not.toBeInTheDocument();
  });
  it('exige la confirmation de la politique et transmet sa version', async () => {
    const s = setup();
    s.p.permissions.push('cash:configure');
    render(<ExchangePage profile={s.p} gateway={s.gateway} online />);
    const save = await screen.findByRole('button', { name: 'Enregistrer la politique de change' });
    expect(save).toBeDisabled();
    await userEvent.click(screen.getByLabelText(/Je confirme cette politique/));
    await userEvent.click(save);
    await waitFor(() =>
      expect(s.gateway.exchangePolicy).toHaveBeenCalledWith(
        expect.objectContaining({ expectedVersion: 1, confirmed: true, quoteKind: 'MEAN' }),
      ),
    );
  });
});

it('explique la restriction de collecte BCC et désactive son actualisation sans bloquer le choix manuel autorisé', async () => {
  const s = setup();
  s.p.permissions.push('cash:configure');
  s.data.source.code = 'BCC_AUTHORIZATION_REQUIRED';
  render(<ExchangePage profile={s.p} gateway={s.gateway} online />);
  await screen.findByText(
    'Collecte automatique BCC non autorisée : un accord de la BCC est nécessaire.',
  );
  expect(screen.getByRole('link', { name: 'mentions légales de la BCC' })).toHaveAttribute(
    'href',
    'https://www.bcc.cd/mentions-legales',
  );
  const refresh = screen.getByRole('button', { name: 'Actualiser la source BCC' });
  expect(refresh).toBeDisabled();
  await userEvent.click(refresh);
  expect(s.gateway.refreshExchange).not.toHaveBeenCalled();
  await userEvent.selectOptions(screen.getByLabelText('Origine du taux'), 'MANUAL');
  expect(screen.getByLabelText('Justification')).toBeInTheDocument();
});
