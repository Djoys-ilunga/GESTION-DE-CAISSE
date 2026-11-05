import { describe, it, expect } from 'vitest';
import { formBufferInputSchema, syncManifestSchema, syncStatusSchema } from './synchronization';
import { draftSyncResultSchema } from './index';
const id = '12345678-1234-4234-8234-123456789012';
describe('Contrats de synchronisation', () => {
  it('refuse une action financière présentée comme un résultat de synchronisation', () => {
    for (const outcome of ['confirmed', 'approved', 'paid'])
      expect(
        draftSyncResultSchema.safeParse({ draftId: id, outcome, code: 'draft-received' }).success,
      ).toBe(false);
  });
  it('borne les champs incomplets sans permettre un secret ou un fichier dans la capture', () => {
    const value = {
      id,
      kind: 'expense-request',
      agencyId: id,
      cashRegisterId: null,
      expectedLocalVersion: null,
      fields: { amount: '12,' },
    };
    expect(formBufferInputSchema.safeParse(value).success).toBe(true);
    for (const fields of [
      { accessToken: 'secret' },
      { description: 'x'.repeat(501) },
      { dataBase64: 'secret' },
    ])
      expect(formBufferInputSchema.safeParse({ ...value, fields }).success).toBe(false);
  });
  it('refuse les métadonnées étrangères dans le manifeste', () => {
    expect(
      syncManifestSchema.safeParse({
        items: [],
        total: 0,
        page: 1,
        pageSize: 50,
        password: 'secret',
      }).success,
    ).toBe(false);
  });
  it('interdit de prétendre que le disque sensible est qualifié', () => {
    const value = {
      running: false,
      apiOnline: false,
      lastSuccessfulAt: null,
      cacheUpdatedAt: null,
      counts: { local: 0, queued: 1, syncing: 0, synced: 0, conflict: 0, error: 0 },
      events: [],
      persistence: 'memory-only',
    };
    expect(syncStatusSchema.safeParse(value).success).toBe(true);
    expect(syncStatusSchema.safeParse({ ...value, persistence: 'disk' }).success).toBe(false);
  });
});
