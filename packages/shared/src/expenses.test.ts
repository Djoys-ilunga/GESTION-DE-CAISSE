import { describe, it, expect } from 'vitest';
import { draftSchema } from './index.js';
import {
  decideExpenseSchema,
  payExpenseSchema,
  submitExpenseSchema,
  expensePolicyInputSchema,
} from './expenses.js';
describe('Contrats du circuit de dépenses', () => {
  it('sépare préparation, soumission, décision et confirmation du paiement', () => {
    const draft = {
      id: crypto.randomUUID(),
      kind: 'expense-request',
      currency: 'CDF',
      amount: '123.45',
      description: 'Achat',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      expenseDetails: { beneficiary: 'Fournisseur', reference: '', documents: [] },
    };
    expect(draftSchema.safeParse(draft).success).toBe(true);
    expect(draftSchema.safeParse({ ...draft, kind: 'receipt' }).success).toBe(false);
    expect(submitExpenseSchema.safeParse({ expectedVersion: 1, submitted: true }).success).toBe(
      true,
    );
    expect(submitExpenseSchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(payExpenseSchema.safeParse({ expectedVersion: 2, paid: false }).success).toBe(false);
    expect(
      payExpenseSchema.safeParse({ expectedVersion: 2, paid: true, accountId: crypto.randomUUID() })
        .success,
    ).toBe(false);
  });
  it('exige un motif de rejet et des plafonds exacts sans doublon', () => {
    expect(
      decideExpenseSchema.safeParse({ expectedVersion: 1, decision: 'REJECT', reason: '  ' })
        .success,
    ).toBe(false);
    expect(
      decideExpenseSchema.safeParse({
        expectedVersion: 1,
        decision: 'REJECT',
        reason: 'Facture manquante',
      }).success,
    ).toBe(true);
    const limit = { role: 'DIRECTOR', action: 'APPROVE', maximum: '100.00' };
    const policy = { expectedVersion: null, requireEvidence: true, limits: [limit] };
    expect(expensePolicyInputSchema.safeParse(policy).success).toBe(true);
    expect(expensePolicyInputSchema.safeParse({ ...policy, limits: [limit, limit] }).success).toBe(
      false,
    );
    expect(
      expensePolicyInputSchema.safeParse({ ...policy, limits: [{ ...limit, maximum: 100 }] })
        .success,
    ).toBe(false);
  });
});
