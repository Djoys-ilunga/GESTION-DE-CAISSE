import { describe, it, expect } from 'vitest';
import {
  receiptDetailsSchema,
  cashSnapshotSchema,
  confirmReceiptSchema,
  supportingDocumentSchema,
} from './receipts';
describe('Contrats d’encaissement', () => {
  it('exige l’attestation explicite sans accepter un contexte utilisateur client', () => {
    expect(confirmReceiptSchema.safeParse({ expectedVersion: 1, received: true }).success).toBe(
      true,
    );
    expect(confirmReceiptSchema.safeParse({ expectedVersion: 1, received: false }).success).toBe(
      false,
    );
    expect(
      confirmReceiptSchema.safeParse({
        expectedVersion: 1,
        received: true,
        userId: crypto.randomUUID(),
      }).success,
    ).toBe(false);
  });
  it('exige la provenance et la catégorie et refuse les champs comptables dans un brouillon', () => {
    const details = {
      provenance: 'Client',
      category: 'Ventes',
      reference: '',
      supportingDocument: null,
    };
    expect(receiptDetailsSchema.safeParse(details).success).toBe(true);
    expect(receiptDetailsSchema.safeParse({ ...details, provenance: ' ' }).success).toBe(false);
    expect(receiptDetailsSchema.safeParse({ ...details, receiptNumber: 'FAUX' }).success).toBe(
      false,
    );
  });
  it('refuse les chemins et types de fichiers actifs', () => {
    const file = { fileName: 'preuve.pdf', mimeType: 'application/pdf', dataBase64: 'JVBERi0=' };
    expect(supportingDocumentSchema.safeParse(file).success).toBe(true);
    expect(supportingDocumentSchema.safeParse({ ...file, fileName: '../preuve.pdf' }).success).toBe(
      false,
    );
    expect(supportingDocumentSchema.safeParse({ ...file, mimeType: 'text/html' }).success).toBe(
      false,
    );
  });
  it('préserve les grands soldes agrégés sans les limiter à un montant de mouvement', () => {
    const data = {
      data: {
        items: [
          {
            id: crypto.randomUUID(),
            code: 'C',
            name: 'Caisse',
            version: 1,
            active: true,
            agency: { id: crypto.randomUUID(), code: 'A', name: 'Agence' },
            session: null,
            funds: [
              {
                currency: 'USD',
                balance: '19999999999999999.98',
                reserved: '0.00',
                available: '19999999999999999.98',
              },
            ],
          },
        ],
        synchronizedAt: new Date().toISOString(),
        expiresAt: null,
      },
      stale: false,
    };
    expect(cashSnapshotSchema.parse(data).data.items[0]?.funds[0]?.balance).toBe(
      '19999999999999999.98',
    );
  });
});
