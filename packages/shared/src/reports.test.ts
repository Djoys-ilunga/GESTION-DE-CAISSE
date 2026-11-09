import { describe, it, expect } from 'vitest';
import { reportQuerySchema, closeCashSchema, reportFileSchema } from './reports.js';
describe('Contrats des rapports', () => {
  it('valide les calendriers et refuse les identités affirmées', () => {
    expect(reportQuerySchema.safeParse({ date: '2024-02-29' }).success).toBe(true);
    for (const date of ['2025-02-29', '2026-02-30', '2026-13-01', 'NaN'])
      expect(reportQuerySchema.safeParse({ date }).success).toBe(false);
    expect(reportQuerySchema.safeParse({ companyId: crypto.randomUUID() }).success).toBe(false);
  });
  it('exige un comptage explicite dans les deux devises', () => {
    const x = {
      cashRegisterId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      confirmed: true,
      countedUSD: '0.00',
      countedCDF: '12.00',
    };
    expect(closeCashSchema.safeParse(x).success).toBe(true);
    for (const extra of [
      { confirmed: false },
      { countedUSD: 12 },
      { countedCDF: '-1.00' },
      { balance: '99.00' },
    ])
      expect(closeCashSchema.safeParse({ ...x, ...extra }).success).toBe(false);
  });
  it('borne les fichiers et refuse les chemins arbitraires', () => {
    expect(
      reportFileSchema.safeParse({
        fileName: '../../test.pdf',
        mimeType: 'application/pdf',
        dataBase64: 'test',
      }).success,
    ).toBe(false);
  });
});
