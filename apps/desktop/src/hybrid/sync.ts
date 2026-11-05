import { draftSyncResultSchema, type Draft, type DraftSyncResult } from '@caissepro/shared';
import type { LocalStore } from './local-store';
export interface DraftTransport {
  sendDraft(
    draft: Draft,
    idempotencyKey: string,
    version: number,
    expectedServerVersion: number | null,
  ): Promise<unknown>;
}
export class SyncCoordinator {
  private running: Promise<DraftSyncResult[]> | null = null;
  constructor(
    private readonly store: LocalStore,
    private readonly connection: { isOnline(): boolean },
    private readonly transport?: DraftTransport,
  ) {}
  synchronize() {
    if (this.running) return this.running;
    this.running = this.execute().finally(() => {
      this.running = null;
    });
    return this.running;
  }
  private async execute() {
    const generation = this.store.generation;
    const records = this.store.listDrafts().filter((r) => r.state === 'local');
    const results: DraftSyncResult[] = [];
    for (const record of records) {
      const deferred = (
        code: Extract<DraftSyncResult, { outcome: 'deferred' }>['code'],
      ): DraftSyncResult => ({ draftId: record.draft.id, outcome: 'deferred', code });
      let result: DraftSyncResult;
      if (generation !== this.store.generation) {
        results.push(deferred('session-changed'));
        break;
      }
      if (Date.parse(record.draft.expiresAt) <= Date.now()) result = deferred('draft-expired');
      else if (!this.connection.isOnline()) result = deferred('offline');
      else if (!this.transport) result = deferred('not-configured');
      else {
        try {
          result = draftSyncResultSchema.parse(
            await this.transport.sendDraft(
              record.draft,
              record.draft.id,
              record.version,
              record.serverVersion,
            ),
          );
          if (result.draftId !== record.draft.id) throw new Error('INVALID_RESULT');
        } catch {
          result = deferred('transport-error');
        }
      }
      if (generation !== this.store.generation) {
        results.push(deferred('session-changed'));
        break;
      }
      if (!this.store.recordSyncResult(record.draft.id, record.version, result))
        result = deferred('local-version-conflict');
      results.push(result);
    }
    return results;
  }
}
