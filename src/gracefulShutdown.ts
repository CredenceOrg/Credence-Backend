import type http from "http";
import type { Socket } from "net";
import type { WebSocketServer } from "ws";
import { setReady } from "./lifecycle.js";
import { stop as stopListeners } from "./listeners/index.js";
import {
  createNoopShutdownMetrics,
  type ShutdownMetrics,
} from "./observability/shutdownMetrics.js";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface DrainableScheduler {
  stop(): void | Promise<void>;
  /** Optional: exposes whether a job invocation is currently executing. */
  isJobRunning?(): boolean;
}

export interface CloseablePool {
  end(): Promise<void>;
}

export interface CloseableRedis {
  disconnect(): Promise<void>;
}

export interface GracefulShutdownOptions {
  server?: http.Server | null;
  outboxJob?: { stop(): Promise<void> };
  scheduler?: DrainableScheduler;
  invalidationBus?: { stop(): Promise<void> };
  dbPools?: CloseablePool[];
  redis?: CloseableRedis;
  /**
   * Maximum time (ms) to wait for in-flight scheduler jobs to finish before
   * moving on.  Defaults to 70% of gracePeriodMs, capped at 10 s.
   */
  jobDrainTimeoutMs?: number;
  gracePeriodMs?: number;
  forceExit?: (code: number) => void;
  logger?: (message: string) => void;
  metrics?: ShutdownMetrics;
}

// ---------------------------------------------------------------------------
// GracefulShutdownManager
// ---------------------------------------------------------------------------

export class GracefulShutdownManager {
  private shuttingDown = false;
  private forceExitTimer: NodeJS.Timeout | null = null;
  private readonly connections = new Set<Socket>();
  private wss: WebSocketServer | null = null;
  private readonly metrics: ShutdownMetrics;

  constructor(private readonly options: GracefulShutdownOptions = {}) {
    this.metrics = options.metrics ?? createNoopShutdownMetrics();
  }

  trackConnection(socket: Socket): void {
    this.connections.add(socket);
    socket.once("close", () => this.connections.delete(socket));
  }

  setServer(server: http.Server | null): void {
    this.options.server = server;
  }

  setOutboxJob(outboxJob: { stop(): Promise<void> } | null | undefined): void {
    this.options.outboxJob = outboxJob ?? undefined;
  }

  setScheduler(scheduler: DrainableScheduler | null | undefined): void {
    this.options.scheduler = scheduler ?? undefined;
  }

  setWss(wss: WebSocketServer | null): void {
    this.wss = wss;
  }

  setInvalidationBus(invalidationBus: { stop(): Promise<void> } | null | undefined): void {
    this.options.invalidationBus = invalidationBus ?? undefined;
  }

  setDbPools(pools: CloseablePool[]): void {
    this.options.dbPools = pools;
  }

  setRedis(redis: CloseableRedis | null | undefined): void {
    this.options.redis = redis ?? undefined;
  }

  async shutdown(signal: string): Promise<void> {
    if (this.shuttingDown) {
      this.log(
        `[Shutdown] Received second signal ${signal} during shutdown — forcing exit.`,
      );
      this.metrics.incForceExit();
      this.options.forceExit?.(1);
      return;
    }

    this.shuttingDown = true;
    setReady(false);
    this.metrics.incShutdown(signal);

    this.log(
      `[Shutdown] ${signal} received — starting graceful drain (grace=${this.gracePeriodMs}ms).`,
    );

    this.forceExitTimer = setTimeout(() => {
      this.log("[Shutdown] Grace period expired — forcing exit.");
      this.metrics.incForceExit();
      this.destroyConnections();
      this.options.forceExit?.(1);
    }, this.gracePeriodMs);

    try {
      await this.runPhase("server_close", () => this.closeServer());
      await this.runPhase("ws_drain", () => this.drainWebSockets());
      await this.runPhase("listener_stop", () => stopListeners());
      await this.runPhase("scheduler_drain", () => this.drainScheduler());
      await this.runPhase("outbox_stop", () =>
        Promise.resolve(this.options.outboxJob?.stop()),
      );
      await this.runPhase("invalidation_bus_stop", () =>
        Promise.resolve(this.options.invalidationBus?.stop()),
      );
      await this.runPhase("pool_close", () => this.closePools());
      await this.runPhase("redis_close", () => this.closeRedis());

      this.log("[Shutdown] Graceful shutdown complete.");
      this.clearForceExitTimer();
      this.options.forceExit?.(0);
    } catch (error) {
      this.log(
        `[Shutdown] Error during shutdown: ${error instanceof Error ? error.message : error}`,
      );
      this.destroyConnections();
      this.clearForceExitTimer();
      this.options.forceExit?.(1);
    }
  }

  // ---------------------------------------------------------------------------
  // Phase helpers
  // ---------------------------------------------------------------------------

  private async runPhase(phase: string, fn: () => Promise<void> | void): Promise<void> {
    const start = Date.now();
    this.log(`[Shutdown:${phase}] starting`);
    try {
      await fn();
    } finally {
      const durationSeconds = (Date.now() - start) / 1000;
      this.metrics.observePhase(phase, durationSeconds);
      this.log(`[Shutdown:${phase}] done (${(durationSeconds * 1000).toFixed(0)}ms)`);
    }
  }

  private drainWebSockets(): Promise<void> {
    if (!this.wss) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const timeoutHandle = setTimeout(() => {
        for (const ws of this.wss!.clients) {
          ws.terminate();
        }
        resolve();
      }, 5000);

      for (const ws of this.wss!.clients) {
        if (ws.readyState === 1 /* WebSocket.OPEN */) {
          ws.close(1000, "Server shutting down gracefully");
        }
      }

      if (this.wss!.clients.size === 0) {
        clearTimeout(timeoutHandle);
        resolve();
        return;
      }

      let closed = 0;
      const checkAllClosed = () => {
        if (closed >= this.wss!.clients.size) {
          clearTimeout(timeoutHandle);
          resolve();
        }
      };

      for (const ws of this.wss!.clients) {
        ws.once("close", () => {
          closed++;
          checkAllClosed();
        });
      }
    });
  }

  private async drainScheduler(): Promise<void> {
    const scheduler = this.options.scheduler;
    if (!scheduler) return;

    // Stop new fires before waiting for the current one.
    await Promise.resolve(scheduler.stop());

    if (typeof scheduler.isJobRunning !== "function") return;

    const maxWaitMs = Math.min(
      this.options.jobDrainTimeoutMs ?? this.gracePeriodMs * 0.7,
      10_000,
    );
    const deadline = Date.now() + maxWaitMs;

    while (scheduler.isJobRunning() && Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 100));
    }

    if (scheduler.isJobRunning()) {
      this.log(
        `[Shutdown:scheduler_drain] Job still running after ${maxWaitMs}ms drain window — proceeding.`,
      );
    }
  }

  private closeServer(): Promise<void> {
    const server = this.options.server;
    if (!server) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  private async closePools(): Promise<void> {
    const pools = this.options.dbPools;
    if (!pools?.length) return;
    await Promise.allSettled(
      pools.map((p) =>
        p.end().catch((err: unknown) =>
          this.log(
            `[Shutdown:pool_close] pool.end() error: ${err instanceof Error ? err.message : err}`,
          ),
        ),
      ),
    );
  }

  private async closeRedis(): Promise<void> {
    const redis = this.options.redis;
    if (!redis) return;
    try {
      await redis.disconnect();
    } catch (err) {
      this.log(
        `[Shutdown:redis_close] disconnect error: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private destroyConnections(): void {
    for (const socket of this.connections) {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }
    this.connections.clear();
  }

  private clearForceExitTimer(): void {
    if (this.forceExitTimer) {
      clearTimeout(this.forceExitTimer);
      this.forceExitTimer = null;
    }
  }

  private get gracePeriodMs(): number {
    return this.options.gracePeriodMs ?? 30_000;
  }

  private log(message: string): void {
    this.options.logger?.(message);
  }
}
