import type { NativeSessionView } from '@caissepro/shared';
import type { AuthGateway } from './gateway';
export const anonymous: NativeSessionView = {
  state: 'anonymous',
  profile: null,
  displayName: null,
  offlineUntil: null,
  reason: null,
  generation: 0,
};
export class AuthController {
  private snapshot = anonymous;
  private listeners = new Set<() => void>();
  private sequence = 0;
  private stopped = false;
  private polling = false;
  constructor(readonly gateway: AuthGateway) {}
  readonly getSnapshot = () => this.snapshot;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(view: NativeSessionView) {
    if (this.stopped || view.generation < this.snapshot.generation) return;
    if (JSON.stringify(view) === JSON.stringify(this.snapshot)) return;
    this.snapshot = view;
    this.listeners.forEach((listener) => listener());
  }
  async action(action: () => Promise<NativeSessionView>) {
    const sequence = ++this.sequence;
    try {
      const result = await action();
      if (sequence === this.sequence) this.publish(result);
      return result;
    } catch (error) {
      if (sequence === this.sequence) await this.refresh();
      throw error;
    }
  }
  async refresh() {
    if (this.polling || !this.gateway.available || this.stopped) return;
    this.polling = true;
    const sequence = this.sequence;
    try {
      const result = await this.gateway.status();
      if (sequence === this.sequence) this.publish(result);
    } finally {
      this.polling = false;
    }
  }
  async logout() {
    this.sequence++;
    this.publish({ ...anonymous, generation: this.snapshot.generation + 1, reason: 'LOGGED_OUT' });
    return this.action(() => this.gateway.logout());
  }
  stop() {
    this.snapshot = anonymous;
    this.stopped = true;
    this.sequence++;
    this.listeners.clear();
  }
  start() {
    this.stopped = false;
    void this.refresh();
  }
}
