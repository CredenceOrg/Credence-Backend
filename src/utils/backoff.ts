export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  maxAttempts?: number;
}

export class BoundedBackoff {
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly maxAttempts: number;
  private attempt = 0;
  private totalReconnects = 0;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingReject: ((reason: unknown) => void) | null = null;
  private stopped = false;

  constructor(opts: BackoffOptions = {}) {
    this.baseMs = opts.baseMs ?? 500;
    this.maxMs = opts.maxMs ?? 30_000;
    this.maxAttempts = opts.maxAttempts ?? 0;
  }

  wait(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.stopped) { reject({ stopped: true }); return; }
      if (this.maxAttempts > 0 && this.attempt >= this.maxAttempts) {
        reject({ exhausted: true }); return;
      }
      const cap = Math.min(this.maxMs, this.baseMs * Math.pow(2, this.attempt));
      const delay = Math.floor(Math.random() * cap);
      this.attempt += 1;
      this.totalReconnects += 1;
      this.pendingReject = reject;
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = null;
        this.pendingReject = null;
        resolve();
      }, delay);
    });
  }

  reset(): void { this.attempt = 0; }

  stop(): void {
    this.stopped = true;
    if (this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (this.pendingReject !== null) {
      const r = this.pendingReject;
      this.pendingReject = null;
      r({ stopped: true });
    }
  }

  getState() { return { attempt: this.attempt, totalReconnects: this.totalReconnects }; }
}
