import { describe, it, expect } from 'vitest';
import {
  companySettingsInputSchema,
  categoryInputSchema,
  referenceRateInputSchema,
  auditQuerySchema,
} from './management.js';
describe('Contrats de supervision et d’administration', () => {
  it('borne les durées et exige la confirmation sans accepter une identité affirmée', () => {
    const x = {
      expectedVersion: 1,
      name: 'Entreprise test',
      address: '',
      phone: '',
      email: '',
      taxId: '',
      sessionMinutes: 480,
      idleMinutes: 15,
      offlineMinutes: 15,
      confirmed: true,
    };
    expect(companySettingsInputSchema.safeParse(x).success).toBe(true);
    for (const patch of [
      { confirmed: false },
      { companyId: crypto.randomUUID() },
      { sessionMinutes: 481 },
      { idleMinutes: 0 },
      { offlineMinutes: 16 },
      { idleMinutes: 3, offlineMinutes: 4 },
      { expectedVersion: 0 },
    ])
      expect(companySettingsInputSchema.safeParse({ ...x, ...patch }).success).toBe(false);
  });
  it('valide les taux décimaux exacts et interdit une conversion sans changement de devise', () => {
    const x = {
      id: crypto.randomUUID(),
      fromCurrency: 'USD',
      toCurrency: 'CDF',
      rate: '2800.123456789123',
      source: 'Banque de test',
      validFrom: new Date().toISOString(),
      confirmed: true,
    };
    expect(referenceRateInputSchema.safeParse(x).success).toBe(true);
    for (const patch of [
      { rate: 2800 },
      { rate: '0.000000000000' },
      { rate: '1.0000000000001' },
      { toCurrency: 'USD' },
      { confirmed: false },
      { companyId: crypto.randomUUID() },
    ])
      expect(referenceRateInputSchema.safeParse({ ...x, ...patch }).success).toBe(false);
  });
  it('valide les catégories versionnées et refuse les chemins et types arbitraires', () => {
    const x = {
      id: crypto.randomUUID(),
      expectedVersion: null,
      code: 'LOYER',
      name: 'Loyer',
      kind: 'EXPENSE',
      active: true,
      confirmed: true,
    };
    expect(categoryInputSchema.safeParse(x).success).toBe(true);
    for (const patch of [
      { code: '../etc' },
      { kind: 'TRANSFER' },
      { name: '' },
      { expectedVersion: 0 },
      { actorId: crypto.randomUUID() },
    ])
      expect(categoryInputSchema.safeParse({ ...x, ...patch }).success).toBe(false);
  });
  it('borne et filtre le journal d’audit sans périmètre libre', () => {
    expect(
      auditQuerySchema.safeParse({ page: 1, cashRegisterId: crypto.randomUUID() }).success,
    ).toBe(true);
    for (const x of [
      { page: 0 },
      { companyId: crypto.randomUUID() },
      { action: 'x;DROP TABLE' },
      { from: '2026-11-09T00:00:00Z', to: '2026-11-08T00:00:00Z' },
    ])
      expect(auditQuerySchema.safeParse(x).success).toBe(false);
  });
});
