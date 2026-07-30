export type JitterStrategy = 'none' | 'full' | 'equal' | 'decorrelated';

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  maxAttempts?: number;
  jitter?: JitterStrategy;
  randomFn?: () => number;
}

export class BoundedBackoff {
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly maxAttempts: number;
  private readonly jitter: JitterStrategy;
  private readonly randomFn: () => number;
  private attempt = 0;
  private totalReconnects = 0;
  private previousDelay: number;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingReject: ((reason: unknown) => void) | null = null;
  private stopped = false;

  constructor(opts: BackoffOptions = {}) {
    this.baseMs = opts.baseMs ?? 500;
    this.maxMs = opts.maxMs ?? 30_000;
    this.maxAttempts = opts.maxAttempts ?? 0;
    this.jitter = opts.jitter ?? 'full';
    this.randomFn = opts.randomFn ?? Math.random;
    this.previousDelay = this.baseMs;
  }

  private computeDelay(cap: number): number {
    switch (this.jitter) {
      case 'none':
        return Math.floor(cap);
      case 'full':
        return Math.floor(this.randomFn() * cap);
      case 'equal': {
        const half = cap / 2;
        return Math.floor(half + this.randomFn() * half);
      }
      case 'decorrelated': {
        const delay = Math.floor(this.baseMs + this.randomFn() * (this.previousDelay * 3 - this.baseMs));
        return Math.min(cap, delay);
      }
    }
  }

  wait(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.stopped) { reject({ stopped: true }); return; }
      if (this.maxAttempts > 0 && this.attempt >= this.maxAttempts) {
        reject({ exhausted: true }); return;
      }
      const cap = Math.min(this.maxMs, this.baseMs * Math.pow(2, this.attempt));
      const delay = this.computeDelay(cap);
      this.previousDelay = delay >= 0 ? delay : 0;
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

  reset(): void { this.attempt = 0; this.previousDelay = this.baseMs; }

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
