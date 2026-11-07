import { describe, it, expect } from 'vitest';
import { transferDraftSchema, handoverTransferSchema, receiveTransferSchema } from './transfers';
const input = {
  id: crypto.randomUUID(),
  sourceCashRegisterId: crypto.randomUUID(),
  destinationCashRegisterId: crypto.randomUUID(),
  sourceCurrency: 'USD',
  destinationCurrency: 'USD',
  amount: '25.00',
  rate: null,
  rateSource: '',
  description: 'Approvisionnement',
};
describe('Contrats de transfert', () => {
  it('accepte les deux transferts de même devise et les deux sens de conversion', () => {
    for (const c of ['USD', 'CDF'])
      expect(
        transferDraftSchema.safeParse({ ...input, sourceCurrency: c, destinationCurrency: c })
          .success,
      ).toBe(true);
    for (const [sourceCurrency, destinationCurrency] of [
      ['USD', 'CDF'],
      ['CDF', 'USD'],
    ])
      expect(
        transferDraftSchema.safeParse({
          ...input,
          sourceCurrency,
          destinationCurrency,
          rate: '0.000357142857',
          rateSource: 'Taux du guichet',
        }).success,
      ).toBe(true);
  });
  it('exige un taux positif explicite et sa source uniquement pour une conversion', () => {
    for (const rate of [null, '0', '-1', 'NaN', '1e-3', '1.1234567891234'])
      expect(
        transferDraftSchema.safeParse({
          ...input,
          destinationCurrency: 'CDF',
          rate,
          rateSource: 'Guichet',
        }).success,
      ).toBe(false);
    expect(transferDraftSchema.safeParse({ ...input, rate: '1' }).success).toBe(false);
    expect(
      transferDraftSchema.safeParse({
        ...input,
        destinationCurrency: 'CDF',
        rate: '1',
        rateSource: '',
      }).success,
    ).toBe(false);
  });
  it('interdit les faux résultats financiers et les montants flottants', () => {
    for (const extra of [
      { targetAmount: '1.00' },
      { state: 'RECEIVED' },
      { operationId: crypto.randomUUID() },
      { amount: 25 },
      { amount: '0.00' },
    ])
      expect(transferDraftSchema.safeParse({ ...input, ...extra }).success).toBe(false);
  });
  it('autorise une conversion dans une même caisse sans confondre caisse et devise', () => {
    expect(
      transferDraftSchema.safeParse({
        ...input,
        destinationCashRegisterId: input.sourceCashRegisterId,
      }).success,
    ).toBe(false);
    expect(
      transferDraftSchema.safeParse({
        ...input,
        destinationCashRegisterId: input.sourceCashRegisterId,
        destinationCurrency: 'CDF',
        rate: '2800',
        rateSource: 'Guichet',
      }).success,
    ).toBe(true);
  });
  it('ne confond jamais transmission, remise et réception', () => {
    expect(
      handoverTransferSchema.safeParse({
        expectedVersion: 1,
        handedOver: false,
        rateValidated: true,
      }).success,
    ).toBe(false);
    expect(receiveTransferSchema.safeParse({ expectedVersion: 2, received: false }).success).toBe(
      false,
    );
    expect(
      receiveTransferSchema.safeParse({ expectedVersion: 2, received: true, handedOver: true })
        .success,
    ).toBe(false);
  });
});
