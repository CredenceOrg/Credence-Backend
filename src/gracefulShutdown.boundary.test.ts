import {
  describe,
  it,
  expect,
  vi,
  afterEach,
  type MockInstance,
} from "vitest";
import type { Socket } from "net";
import type { WebSocketServer } from "ws";
import { EventEmitter } from "events";
import { GracefulShutdownManager } from "./gracefulShutdown.js";
import type {
  DrainableScheduler,
  CloseablePool,
  CloseableRedis,
  GracefulShutdownOptions,
} from "./gracefulShutdown.js";
import type { ShutdownMetrics } from "./observability/shutdownMetrics.js";
import { setReady } from "./lifecycle.js";

// ---------------------------------------------------------------------------
// This suite complements src/gracefulShutdown.test.ts and
// src/gracefulShutdown.realServer.test.ts by pinning the *boundary* and
// *recovery* behaviour of GracefulShutdownManager:
//
//   • defaulted / omitted options (no logger, no metrics, default grace)
//   • setters clearing a previously registered resource via null | undefined
//   • a socket that disconnects on its own is not re-destroyed at shutdown
//   • late-phase failure (after server_close) force-exits 1 and destroys
//     tracked sockets — no phase left half-applied
//   • non-Error failures are tolerated/logged instead of throwing
//   • scheduler drain window boundary (0 ms budget → no wait)
//   • WebSocket clients that are not OPEN and partial-drain boundaries
//   • duplicate signals during an in-flight shutdown are idempotent
//
// Every invariant asserted here is a production contract documented in
// docs/graceful-shutdown.md.
// ---------------------------------------------------------------------------

function makeMetrics(): ShutdownMetrics & {
  observePhase: MockInstance;
  incShutdown: MockInstance;
  incForceExit: MockInstance;
} {
  return {
    observePhase: vi.fn(),
    incShutdown: vi.fn(),
    incForceExit: vi.fn(),
  };
}

function makeOptions(
  overrides: Partial<GracefulShutdownOptions> = {},
): GracefulShutdownOptions {
  return {
    logger: vi.fn(),
    forceExit: vi.fn(),
    metrics: makeMetrics(),
    gracePeriodMs: 1000,
    ...overrides,
  };
}

/** Minimal http.Server stub that records close() calls. */
function makeServer() {
  const emitter = new EventEmitter() as any;
  emitter.close = vi.fn((cb?: (err?: Error) => void) => {
    cb?.();
  });
  return emitter;
}

function makePool(): CloseablePool & { end: MockInstance } {
  return { end: vi.fn().mockResolvedValue(undefined) };
}

function makeRedis(): CloseableRedis & { disconnect: MockInstance } {
  return { disconnect: vi.fn().mockResolvedValue(undefined) };
}

function makeScheduler(opts: { running?: boolean } = {}): DrainableScheduler & {
  stop: MockInstance;
  isJobRunning: () => boolean;
} {
  let running = opts.running ?? false;
  return {
    stop: vi.fn(() => {
      running = false;
    }),
    isJobRunning: () => running,
  };
}

interface FakeSocket {
  handlers: Record<string, () => void>;
  destroy: MockInstance;
  once: MockInstance;
}

/** Socket stub that lets a test fire the `close` listener manually. */
function makeSocket(): FakeSocket {
  const handlers: Record<string, () => void> = {};
  return {
    handlers,
    destroy: vi.fn(),
    once: vi.fn((event: string, cb: () => void) => {
      handlers[event] = cb;
    }),
  };
}

interface FakeWsClient {
  readyState: number;
  close: MockInstance;
  terminate: MockInstance;
  handlers: Record<string, () => void>;
  once: (event: string, cb: () => void) => void;
}

function makeWsClient(readyState: number): FakeWsClient {
  const handlers: Record<string, () => void> = {};
  return {
    readyState,
    close: vi.fn(),
    terminate: vi.fn(),
    handlers,
    once: (event, cb) => {
      handlers[event] = cb;
    },
  };
}

function makeWss(clients: FakeWsClient[]): WebSocketServer {
  return { clients: new Set(clients), close: vi.fn() } as unknown as WebSocketServer;
}

/** Flush pending microtasks without touching the (possibly faked) timer queue. */
async function flushMicrotasks(times = 25): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** Poll until `fn` is true — deterministic, avoids fixed sleeps. */
async function waitFor(fn: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((r) => setTimeout(r, 1));
  }
}

function joinLogs(logger: MockInstance): string {
  return logger.mock.calls.map((c) => String(c[0])).join("\n");
}

describe("GracefulShutdownManager boundary and recovery", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    setReady(true);
  });

  // -------------------------------------------------------------------------
  // Defaulted / omitted options
  // -------------------------------------------------------------------------

  describe("defaulted options", () => {
    it("constructs with no options and shuts down without a logger or metrics", async () => {
      const mgr = new GracefulShutdownManager();

      await expect(mgr.shutdown("SIGTERM")).resolves.toBeUndefined();
    });

    it("uses the documented 30,000 ms default grace period", async () => {
      const logger = vi.fn();
      const mgr = new GracefulShutdownManager({ logger });

      await mgr.shutdown("SIGTERM");

      expect(joinLogs(logger)).toContain("grace=30000ms");
    });
  });

  // -------------------------------------------------------------------------
  // Setters clearing resources
  // -------------------------------------------------------------------------

  describe("setter null/undefined boundary", () => {
    it("clears previously registered resources when given null/undefined", async () => {
      const outboxJob = { stop: vi.fn().mockResolvedValue(undefined) };
      const scheduler = makeScheduler();
      const invalidationBus = { stop: vi.fn().mockResolvedValue(undefined) };
      const pool = makePool();
      const redis = makeRedis();
      const opts = makeOptions();
      const mgr = new GracefulShutdownManager(opts);

      // Register, then clear — a cleared resource must not be touched at shutdown.
      mgr.setOutboxJob(outboxJob);
      mgr.setScheduler(scheduler);
      mgr.setInvalidationBus(invalidationBus);
      mgr.setDbPools([pool]);
      mgr.setRedis(redis);
      mgr.setServer(null);

      mgr.setOutboxJob(undefined);
      mgr.setScheduler(null);
      mgr.setInvalidationBus(undefined);
      mgr.setRedis(null);
      mgr.setDbPools([]);

      await mgr.shutdown("SIGTERM");

      expect(outboxJob.stop).not.toHaveBeenCalled();
      expect(scheduler.stop).not.toHaveBeenCalled();
      expect(invalidationBus.stop).not.toHaveBeenCalled();
      expect(pool.end).not.toHaveBeenCalled();
      expect(redis.disconnect).not.toHaveBeenCalled();
      expect(opts.forceExit).toHaveBeenCalledWith(0);
    });
  });

  // -------------------------------------------------------------------------
  // Connection tracking lifecycle
  // -------------------------------------------------------------------------

  describe("connection tracking", () => {
    it("does not re-destroy a tracked socket that already disconnected", async () => {
      const closedSocket = makeSocket();
      const openSocket = makeSocket();

      // Force the error path so destroyConnections() runs to completion.
      const server = makeServer();
      server.close = vi.fn((cb?: (err?: Error) => void) =>
        cb?.(new Error("forced")),
      );
      const opts = makeOptions({ server });
      const mgr = new GracefulShutdownManager(opts);

      mgr.trackConnection(closedSocket as unknown as Socket);
      mgr.trackConnection(openSocket as unknown as Socket);

      // Client disconnected well before the signal arrived.
      closedSocket.handlers.close?.();

      await mgr.shutdown("SIGTERM");

      expect(closedSocket.destroy).not.toHaveBeenCalled();
      expect(openSocket.destroy).toHaveBeenCalledTimes(1);
      expect(opts.forceExit).toHaveBeenCalledWith(1);
    });
  });

  // -------------------------------------------------------------------------
  // Recovery: late-phase failure
  // -------------------------------------------------------------------------

  describe("late-phase failure recovery", () => {
    it("force-exits 1 and destroys tracked sockets when a phase rejects", async () => {
      const socket = makeSocket();
      const scheduler: DrainableScheduler = {
        stop: vi.fn().mockRejectedValue(new Error("scheduler stop failed")),
      };
      const opts = makeOptions({ scheduler });
      const mgr = new GracefulShutdownManager(opts);
      mgr.trackConnection(socket as unknown as Socket);

      // Failing at scheduler_drain (after server/ws/listener phases) must not
      // leave the process hanging or the sockets open.
      await expect(mgr.shutdown("SIGTERM")).resolves.toBeUndefined();

      expect(opts.forceExit).toHaveBeenCalledWith(1);
      expect(socket.destroy).toHaveBeenCalledTimes(1);
    });

    it("logs a non-Error rejection without throwing and force-exits 1", async () => {
      const logger = vi.fn();
      const scheduler: DrainableScheduler = {
        stop: vi.fn().mockRejectedValue("boom"),
      };
      const opts = makeOptions({ scheduler, logger });
      const mgr = new GracefulShutdownManager(opts);

      await expect(mgr.shutdown("SIGTERM")).resolves.toBeUndefined();

      expect(opts.forceExit).toHaveBeenCalledWith(1);
      expect(joinLogs(logger)).toContain("Error during shutdown: boom");
    });

    it("force-exits 1 when outboxJob.stop() rejects", async () => {
      const outboxJob = {
        stop: vi.fn().mockRejectedValue(new Error("outbox stop failed")),
      };
      const opts = makeOptions({ outboxJob });
      const mgr = new GracefulShutdownManager(opts);

      await mgr.shutdown("SIGTERM");

      expect(opts.forceExit).toHaveBeenCalledWith(1);
    });
  });

  // -------------------------------------------------------------------------
  // Recovery: non-Error failures in best-effort cleanup
  // -------------------------------------------------------------------------

  describe("best-effort cleanup with non-Error failures", () => {
    it("tolerates a non-Error pool rejection and still exits cleanly", async () => {
      const logger = vi.fn();
      const badPool = { end: vi.fn().mockRejectedValue("pg gone") };
      const goodPool = makePool();
      const opts = makeOptions({ dbPools: [badPool, goodPool], logger });
      const mgr = new GracefulShutdownManager(opts);

      await mgr.shutdown("SIGTERM");

      expect(goodPool.end).toHaveBeenCalledTimes(1);
      expect(opts.forceExit).toHaveBeenCalledWith(0);
      expect(joinLogs(logger)).toContain("pool.end() error: pg gone");
    });

    it("tolerates a non-Error redis disconnect failure and still exits cleanly", async () => {
      const logger = vi.fn();
      const redis: CloseableRedis = {
        disconnect: vi.fn().mockRejectedValue({ code: "ECONNRESET" }),
      };
      const opts = makeOptions({ redis, logger });
      const mgr = new GracefulShutdownManager(opts);

      await mgr.shutdown("SIGTERM");

      expect(opts.forceExit).toHaveBeenCalledWith(0);
      expect(joinLogs(logger)).toContain("disconnect error:");
    });
  });

  // -------------------------------------------------------------------------
  // Scheduler drain window boundary
  // -------------------------------------------------------------------------

  describe("scheduler drain window", () => {
    it("does not wait for an in-flight job when jobDrainTimeoutMs is 0", async () => {
      const logger = vi.fn();
      const scheduler: DrainableScheduler = {
        stop: vi.fn(),
        isJobRunning: () => true,
      };
      const opts = makeOptions({
        scheduler,
        logger,
        gracePeriodMs: 5000,
        jobDrainTimeoutMs: 0,
      });
      const mgr = new GracefulShutdownManager(opts);

      const start = Date.now();
      await mgr.shutdown("SIGTERM");

      // A zero drain window means "never poll" — the job is abandoned
      // immediately and the shutdown still completes cleanly.
      expect(Date.now() - start).toBeLessThan(500);
      expect(joinLogs(logger)).toContain("still running after 0ms");
      expect(opts.forceExit).toHaveBeenCalledWith(0);
    });
  });

  // -------------------------------------------------------------------------
  // WebSocket drain boundaries
  // -------------------------------------------------------------------------

  describe("WebSocket drain boundaries", () => {
    it("does not close() a non-OPEN client and terminates it after the drain window", async () => {
      vi.useFakeTimers();

      const client = makeWsClient(2 /* CLOSING */);
      const opts = makeOptions({ gracePeriodMs: 30_000 });
      const mgr = new GracefulShutdownManager(opts);
      mgr.setWss(makeWss([client]));

      const shutdown = mgr.shutdown("SIGTERM");
      // Let server_close finish and ws_drain arm its 5 s hard-terminate timer.
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(5000);
      await shutdown;

      expect(client.close).not.toHaveBeenCalled();
      expect(client.terminate).toHaveBeenCalledTimes(1);
      expect(opts.forceExit).toHaveBeenCalledWith(0);
    });

    it("waits for every WS client to close instead of resolving on the first", async () => {
      const first = makeWsClient(1 /* OPEN */);
      const second = makeWsClient(1 /* OPEN */);
      const opts = makeOptions({ gracePeriodMs: 30_000 });
      const mgr = new GracefulShutdownManager(opts);
      mgr.setWss(makeWss([first, second]));

      let resolved = false;
      const shutdown = mgr.shutdown("SIGTERM").then(() => {
        resolved = true;
      });

      // Both OPEN clients receive close(1000).
      await waitFor(() => first.close.mock.calls.length > 0);
      expect(second.close).toHaveBeenCalled();

      // One of two has closed — the drain must not resolve yet.
      first.handlers.close?.();
      await new Promise((r) => setTimeout(r, 20));
      expect(resolved).toBe(false);

      // Last client closes — now the drain resolves and shutdown completes.
      second.handlers.close?.();
      await shutdown;

      expect(resolved).toBe(true);
      expect(opts.forceExit).toHaveBeenCalledWith(0);
    });
  });

  // -------------------------------------------------------------------------
  // Concurrency / duplicate signals
  // -------------------------------------------------------------------------

  describe("concurrent duplicate signals", () => {
    it("runs phases once and forces exit on a signal received mid-drain", async () => {
      const metrics = makeMetrics();
      const server = makeServer();
      server.close = vi.fn((cb?: (err?: Error) => void) =>
        setTimeout(() => cb?.(), 50),
      );
      const opts = makeOptions({ server, metrics });
      const mgr = new GracefulShutdownManager(opts);

      const first = mgr.shutdown("SIGTERM");
      // Second signal arrives while the first shutdown is still draining.
      await mgr.shutdown("SIGINT");
      await first;

      expect(server.close).toHaveBeenCalledTimes(1);
      expect(metrics.incShutdown).toHaveBeenCalledTimes(1);
      expect(opts.forceExit).toHaveBeenCalledWith(1);
    });
  });
});
