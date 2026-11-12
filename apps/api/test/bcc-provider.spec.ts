import { BccAuthorizationRequiredConnector } from '../src/exchange/bcc.authorization';
import { describe, expect, it, vi } from 'vitest';
import { BccExchangeRateProvider, UnverifiedBccConnector } from '../src/exchange/bcc.provider';
import { BccRefreshCoordinator } from '../src/exchange/bcc.refresh';
import { BccOfficialHttpTransport } from '../src/exchange/bcc.http';
const provider = new BccExchangeRateProvider();
const now = new Date('2026-11-11T12:00:00Z');
const sample = () => ({
  publicationDate: '2026-11-10',
  publishedAt: null,
  sourceReference: 'Publication synthétique — contrat de test, pas document BCC',
  quotes: [
    {
      currency: 'JPY',
      unit: '100',
      unitEvidence: 'Colonne synthétique : 100 JPY',
      buy: '1900',
      mean: '2000',
      sell: '2100',
    },
  ],
});
describe('Normalisation BCC, fixtures déterministes explicitement synthétiques', () => {
  it('normalise 100 unités sans déduire ni inventer un cours', () => {
    const q = provider.normalize(sample(), now).quotes[0]!;
    expect(q.mean).toBe('20.000000000000000000');
    expect(q.rawMean).toBe('2000');
    expect(q.unit).toBe('100');
  });
  it('conserve les cours distincts et accepte une moyenne absente', () => {
    const v = sample();
    v.quotes[0]!.mean = null as never;
    expect(provider.normalize(v, now).quotes[0]!.mean).toBeNull();
  });
  it.each(['0', '-1', 'NaN', 'Infinity', '1e3', '1,5'])('refuse le cours invalide %s', (rate) => {
    const v = sample();
    v.quotes[0]!.mean = rate;
    expect(() => provider.normalize(v, now)).toThrow();
  });
  it.each(['10', '', '1000'])('refuse l’unité non documentée %s', (unit) => {
    const v = sample();
    v.quotes[0]!.unit = unit;
    expect(() => provider.normalize(v, now)).toThrow();
  });
  it('refuse une preuve d’unité manquante, les doublons et un format modifié', () => {
    const v = sample();
    v.quotes[0]!.unitEvidence = '';
    expect(() => provider.normalize(v, now)).toThrow();
    expect(() =>
      provider.normalize({ ...sample(), quotes: [...sample().quotes, ...sample().quotes] }, now),
    ).toThrow();
    expect(() => provider.normalize({ rates: [] }, now)).toThrow();
  });
  it('refuse un spread incohérent et une moyenne hors intervalle', () => {
    const v = sample();
    v.quotes[0]!.buy = '2200';
    expect(() => provider.normalize(v, now)).toThrow();
    v.quotes[0]!.buy = '1900';
    v.quotes[0]!.mean = '2200';
    expect(() => provider.normalize(v, now)).toThrow();
  });
  it('refuse dates impossibles, futures et horodatages contradictoires', () => {
    for (const publicationDate of ['2026-02-30', '2026-11-12'])
      expect(() => provider.normalize({ ...sample(), publicationDate }, now)).toThrow();
    expect(() =>
      provider.normalize({ ...sample(), publishedAt: '2026-11-09T10:00:00Z' }, now),
    ).toThrow();
  });
  it('calcule le croisement EUR/USD via CDF et l’inverse à douze décimales', () => {
    expect(provider.cross('3000', '2500')).toBe('1.200000000000');
    expect(provider.cross('2500', '3000')).toBe('0.833333333333');
  });
  it('reste fermé tant qu’aucun contrat officiel n’a été vérifié', async () => {
    const c = new UnverifiedBccConnector();
    expect(c.descriptor.verified).toBe(false);
    await expect(c.retrieve()).rejects.toThrow('SOURCE_CONTRACT_UNVERIFIED');
  });
  it('refuse les destinations arbitraires sans appel réseau', async () => {
    await expect(
      new BccOfficialHttpTransport().download('https://example.test/rates'),
    ).rejects.toThrow('BCC_SOURCE_NOT_ALLOWED');
  });
});

it('planifie seulement un connecteur vérifié et arrête la minuterie proprement', async () => {
  vi.useFakeTimers();
  try {
    const disabled = new BccRefreshCoordinator({} as never, provider, new UnverifiedBccConnector());
    disabled.onModuleInit();
    expect(vi.getTimerCount()).toBe(0);
    const verified = new BccRefreshCoordinator({} as never, provider, {
      descriptor: {
        sourceUrl: 'https://www.bcc.cd/marche-des-changes/cours-de-change',
        contractVersion: 'SYNTHETIC',
        verified: true,
      },
      retrieve: vi.fn(),
    });
    const run = vi
      .spyOn(verified, 'refresh')
      .mockResolvedValue({ state: 'READY', code: 'TEST', publicationId: null, performed: true });
    verified.onModuleInit();
    await vi.advanceTimersByTimeAsync(60000);
    expect(run).toHaveBeenCalledOnce();
    verified.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(60000);
    expect(run).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it('refuse la collecte BCC même si un ancien agrément en base existe, sans appel réseau ni minuterie', async () => {
  const connector = new BccAuthorizationRequiredConnector();
  const download = vi.spyOn(BccOfficialHttpTransport.prototype, 'download');
  const repo = {
    run: vi.fn(async () => ({
      approved: true,
      sourceUrl: connector.descriptor.sourceUrl,
      contractVersion: connector.descriptor.contractVersion,
    })),
  };
  const coordinator = new BccRefreshCoordinator(repo as never, provider, connector);
  vi.useFakeTimers();
  try {
    coordinator.onModuleInit();
    expect(vi.getTimerCount()).toBe(0);
    await expect(connector.retrieve()).rejects.toThrow('BCC_AUTHORIZATION_REQUIRED');
    expect(await coordinator.refresh()).toEqual({
      state: 'UNVERIFIED',
      code: 'BCC_AUTHORIZATION_REQUIRED',
      publicationId: null,
      performed: false,
    });
    expect(download).not.toHaveBeenCalled();
  } finally {
    coordinator.onModuleDestroy();
    vi.useRealTimers();
    download.mockRestore();
  }
});
