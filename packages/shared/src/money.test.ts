import { describe, it, expect } from 'vitest';
import {
  currencyPrecision,
  validCurrencyAmount,
  formatMonetary,
  INITIAL_CURRENCY_CATALOG,
  moneyPreferenceInputSchema,
} from './money.js';
import { draftSchema } from './index.js';
import { closeCashSchema } from './reports.js';
describe('Contrats multidevises', () => {
  it('utilise la précision ISO, y compris MGA et CLF, sans valeur implicite', () => {
    expect(INITIAL_CURRENCY_CATALOG.length).toBe(166);
    for (const [code, precision] of [
      ['CDF', 2],
      ['USD', 2],
      ['JPY', 0],
      ['KWD', 3],
      ['CLF', 4],
      ['MGA', 2],
    ] as const)
      expect(currencyPrecision(code)).toBe(precision);
    expect(() => currencyPrecision('ZZZ')).toThrow('CURRENCY_METADATA_REQUIRED');
  });
  it('valide les unités propres à chaque monnaie', () => {
    for (const [amount, precision] of [
      ['0', 0],
      ['123', 0],
      ['12.34', 2],
      ['0.001', 3],
      ['0.0001', 4],
    ] as const)
      expect(validCurrencyAmount(amount, precision, false)).toBe(true);
    for (const [amount, precision] of [
      ['0', 0],
      ['1.00', 0],
      ['1.234', 2],
      ['1.00', 3],
      ['0.00001', 4],
    ] as const)
      expect(validCurrencyAmount(amount, precision)).toBe(false);
  });
  it('formate sans convertir en Number ou perdre de décimales', () => {
    expect(formatMonetary('9007199254740993.001', 'en-US')).toBe('9,007,199,254,740,993.001');
    expect(formatMonetary('-0.001', 'fr-FR')).toBe('-0,001');
    expect(formatMonetary('123', 'fr-FR')).toBe('123');
  });
  it('conserve la devise du brouillon et refuse la précision USD invalide', () => {
    const base = {
      id: crypto.randomUUID(),
      kind: 'receipt',
      currency: 'JPY',
      amount: '123',
      description: 'Brouillon',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };
    expect(draftSchema.parse(base).currency).toBe('JPY');
    expect(draftSchema.safeParse({ ...base, currency: 'USD', amount: '1.001' }).success).toBe(
      false,
    );
    expect(
      moneyPreferenceInputSchema.safeParse({
        expectedVersion: 0,
        displayCurrency: 'EUR',
        favoriteCurrency: 'JPY',
        locale: 'en-US',
        amount: '123',
      }).success,
    ).toBe(false);
  });
  it('refuse des devises dupliquées dans le comptage', () => {
    expect(
      closeCashSchema.safeParse({
        cashRegisterId: crypto.randomUUID(),
        sessionId: crypto.randomUUID(),
        confirmed: true,
        counts: [
          { currency: 'JPY', amount: '1' },
          { currency: 'JPY', amount: '2' },
        ],
      }).success,
    ).toBe(false);
  });
});
