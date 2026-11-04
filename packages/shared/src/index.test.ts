import { describe, it, expect } from 'vitest';
import { amountSchema, positiveAmountSchema, draftSchema, draftSyncResultSchema } from './index';
describe('Contrats financiers', () => {
  it('exige des chaînes décimales canoniques exactes', () => {
    expect(amountSchema.parse('9007199254740993.01')).toBe('9007199254740993.01');
    for (const bad of [1.25, '1', '01.00', '1e2', '-1.00', '1.001'])
      expect(amountSchema.safeParse(bad).success).toBe(false);
    expect(positiveAmountSchema.safeParse('0.00').success).toBe(false);
  });
  it('refuse une opération financière dans un brouillon', () => {
    expect(
      draftSchema.safeParse({
        id: crypto.randomUUID(),
        kind: 'transfer',
        amount: '1.00',
        currency: 'USD',
      }).success,
    ).toBe(false);
  });
  it('ne définit aucun résultat de synchronisation confirmant un paiement', () => {
    expect(
      draftSyncResultSchema.safeParse({
        draftId: crypto.randomUUID(),
        outcome: 'payment-confirmed',
        code: 'paid',
      }).success,
    ).toBe(false);
  });
});
