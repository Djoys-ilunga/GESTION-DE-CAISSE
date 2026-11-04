import { apiHealthSchema } from '@caissepro/shared';
export type ConnectionSnapshot = {
  state: 'checking' | 'online' | 'offline';
  checkedAt: number | null;
  reason: 'checking' | 'ready' | 'unavailable' | 'identity-mismatch';
};
export class ConnectionService {
  private snapshot: ConnectionSnapshot = { state: 'checking', checkedAt: null, reason: 'checking' };
  private listeners = new Set<() => void>();
  private sequence = 0;
  private timer?: ReturnType<typeof setInterval>;
  private controller?: AbortController;
  readonly getSnapshot = () => this.snapshot;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(snapshot: ConnectionSnapshot) {
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener());
  }
  constructor(
    private readonly baseUrl: string,
    private readonly deploymentId: string,
    private readonly allowDevHttp = false,
    private readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
  ) {}
  isOnline() {
    return this.snapshot.state === 'online' && Date.now() - (this.snapshot.checkedAt ?? 0) < 20000;
  }
  async check() {
    const sequence = ++this.sequence;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
      const url = new URL(this.baseUrl);
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/' ||
        (url.protocol !== 'https:' &&
          !(
            this.allowDevHttp &&
            url.protocol === 'http:' &&
            ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
          ))
      )
        throw new Error('URL_INVALID');
      url.pathname = '/api/v1/health/ready';
      const response = await this.fetcher(url, {
        signal: controller.signal,
        cache: 'no-store',
        redirect: 'error',
        credentials: 'omit',
      });
      if (!response.ok) throw new Error('UNAVAILABLE');
      const health = apiHealthSchema.safeParse(await response.json());
      if (sequence !== this.sequence) return;
      this.publish(
        health.success && health.data.deploymentId === this.deploymentId
          ? { state: 'online', checkedAt: Date.now(), reason: 'ready' }
          : { state: 'offline', checkedAt: Date.now(), reason: 'identity-mismatch' },
      );
    } catch {
      if (sequence === this.sequence)
        this.publish({ state: 'offline', checkedAt: Date.now(), reason: 'unavailable' });
    } finally {
      clearTimeout(timeout);
    }
  }
  private refresh = () => {
    void this.check();
  };
  start() {
    if (this.timer) return;
    this.refresh();
    this.timer = setInterval(this.refresh, 15000);
    window.addEventListener('online', this.refresh);
    window.addEventListener('offline', this.refresh);
    window.addEventListener('focus', this.refresh);
  }
  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    ++this.sequence;
    this.controller?.abort();
    window.removeEventListener('online', this.refresh);
    window.removeEventListener('offline', this.refresh);
    window.removeEventListener('focus', this.refresh);
  }
}
