import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from "vitest";
import { GracefulShutdownManager } from "./gracefulShutdown.js";
import type {
  GracefulShutdownOptions,
  DrainableScheduler,
  CloseablePool,
  CloseableRedis,
} from "./gracefulShutdown.js";
import type { ShutdownMetrics } from "./observability/shutdownMetrics.js";
import { EventEmitter } from "events";
import { WebSocketServer, WebSocket } from "ws";

// ---------------------------------------------------------------------------
// Helpers
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

/** Minimal http.Server stub that records close() calls */
function makeServer() {
  const emitter = new EventEmitter() as any;
  emitter.close = vi.fn((cb?: (err?: Error) => void) => {
    cb?.();
  });
  return emitter;
}

/** Minimal Pool stub */
function makePool(): CloseablePool & { end: MockInstance } {
  return { end: vi.fn().mockResolvedValue(undefined) };
}

/** Minimal Redis stub */
function makeRedis(): CloseableRedis & { disconnect: MockInstance } {
  return { disconnect: vi.fn().mockResolvedValue(undefined) };
}

/** A simple drainable scheduler stub */
function makeScheduler(opts: { running?: boolean } = {}): DrainableScheduler & {
  stop: MockInstance;
  isJobRunning: () => boolean;
} {
  let running = opts.running ?? false;
  return {
    stop: vi.fn(() => { running = false; }),
    isJobRunning: () => running,
  };
}

/** A scheduler whose job finishes after a delay */
function makeSlowScheduler(jobDurationMs: number): DrainableScheduler & {
  stop: MockInstance;
  isJobRunning: () => boolean;
} {
  let running = true;
  // Simulate job completing after jobDurationMs
  setTimeout(() => { running = false; }, jobDurationMs);
  return {
    stop: vi.fn(() => { /* don't reset running; job is in flight */ }),
    isJobRunning: () => running,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GracefulShutdownManager", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Basic shutdown flow
  // -------------------------------------------------------------------------

  describe("shutdown sequence", () => {
    it("calls forceExit(0) after clean shutdown", async () => {
      const opts = makeOptions();
      const mgr = new GracefulShutdownManager(opts);

      await mgr.shutdown("SIGTERM");

      expect(opts.forceExit).toHaveBeenCalledWith(0);
    });

    it("marks service not-ready immediately on signal", async () => {
      const { setReady } = await import("./lifecycle.js");
      const opts = makeOptions();
      const mgr = new GracefulShutdownManager(opts);

      // setReady is called with false inside shutdown before any await
      let readyAtCall: boolean | undefined;
      vi.spyOn(await import("./lifecycle.js"), "setReady").mockImplementation(
        (v) => { readyAtCall = v; },
      );

      await mgr.shutdown("SIGTERM");

      expect(readyAtCall).toBe(false);
    });

    it("increments shutdown metric with the signal name", async () => {
      const metrics = makeMetrics();
      const mgr = new GracefulShutdownManager(makeOptions({ metrics }));

      await mgr.shutdown("SIGINT");

      expect(metrics.incShutdown).toHaveBeenCalledWith("SIGINT");
    });

    it("records phase durations for all phases", async () => {
      const metrics = makeMetrics();
      const mgr = new GracefulShutdownManager(makeOptions({ metrics }));

      await mgr.shutdown("SIGTERM");

      const phases = (metrics.observePhase as MockInstance).mock.calls.map(
        (c) => c[0] as string,
      );
      expect(phases).toContain("server_close");
      expect(phases).toContain("ws_drain");
      expect(phases).toContain("listener_stop");
      expect(phases).toContain("scheduler_drain");
      expect(phases).toContain("outbox_stop");
      expect(phases).toContain("invalidation_bus_stop");
      expect(phases).toContain("pool_close");
      expect(phases).toContain("redis_close");
    });
  });

  // -------------------------------------------------------------------------
  // HTTP server
  // -------------------------------------------------------------------------

  describe("HTTP server close", () => {
    it("closes the HTTP server", async () => {
      const server = makeServer();
      const opts = makeOptions({ server });
      const mgr = new GracefulShutdownManager(opts);

      await mgr.shutdown("SIGTERM");

      expect(server.close).toHaveBeenCalled();
    });

    it("works when no server is provided", async () => {
      const opts = makeOptions({ server: null });
      const mgr = new GracefulShutdownManager(opts);

      await expect(mgr.shutdown("SIGTERM")).resolves.toBeUndefined();
      expect(opts.forceExit).toHaveBeenCalledWith(0);
    });

    it("calls forceExit(1) when server.close() fails", async () => {
      const server = makeServer();
      server.close = vi.fn((cb?: (err?: Error) => void) =>
        cb?.(new Error("server close failed")),
      );
      const opts = makeOptions({ server });
      const mgr = new GracefulShutdownManager(opts);

      await mgr.shutdown("SIGTERM");

      expect(opts.forceExit).toHaveBeenCalledWith(1);
    });
  });

  // -------------------------------------------------------------------------
  // WebSocket drain
  // -------------------------------------------------------------------------

  describe("WebSocket drain", () => {
    it("sends close(1000) to open clients", async () => {
      vi.useRealTimers();

      const wss = new WebSocketServer({ port: 0 });
      const { port } = wss.address() as { port: number };

      const client = new WebSocket(`ws://localhost:${port}`);
      await new Promise<void>((res) => wss.once("connection", () => res()));

      const opts = makeOptions({ gracePeriodMs: 5000 });
      const mgr = new GracefulShutdownManager(opts);
      mgr.setWss(wss);

      const closeCodes: number[] = [];
      client.on("close", (code) => closeCodes.push(code));

      await mgr.shutdown("SIGTERM");

      expect(closeCodes).toContain(1000);

      wss.close();
    });

    it("resolves immediately when there are no WS clients", async () => {
      const wss = new WebSocketServer({ noServer: true });
      const opts = makeOptions();
      const mgr = new GracefulShutdownManager(opts);
      mgr.setWss(wss);

      await expect(mgr.shutdown("SIGTERM")).resolves.toBeUndefined();
      expect(opts.forceExit).toHaveBeenCalledWith(0);

      wss.close();
    });

    it("terminates clients that do not close within the drain window", async () => {
      vi.useRealTimers();

      // Build a minimal mock wss where the server-side ws ignores close()
      const terminateSpy = vi.fn();
      const mockWs = {
        readyState: 1 /* OPEN */,
        close: vi.fn(), // deliberately does nothing — simulates a stalled client
        terminate: terminateSpy,
        once: vi.fn(),
      };

      const mockWss = {
        clients: new Set([mockWs]),
        close: vi.fn(),
      } as unknown as WebSocketServer;

      const opts = makeOptions({ gracePeriodMs: 10000 });
      const mgr = new GracefulShutdownManager(opts);
      mgr.setWss(mockWss);

      // The WS drain timeout inside drainWebSockets is 5 000 ms — wait for it
      await mgr.shutdown("SIGTERM");

      expect(terminateSpy).toHaveBeenCalled();
    }, 8000);
  });

  // -------------------------------------------------------------------------
  // Scheduler drain (in-flight job)
  // -------------------------------------------------------------------------

  describe("scheduler drain", () => {
    it("waits for an in-flight job to complete before exiting", async () => {
      vi.useRealTimers();

      const jobDurationMs = 200;
      const scheduler = makeSlowScheduler(jobDurationMs);
      const opts = makeOptions({
        scheduler,
        gracePeriodMs: 5000,
        jobDrainTimeoutMs: 2000,
      });
      const mgr = new GracefulShutdownManager(opts);

      const start = Date.now();
      await mgr.shutdown("SIGTERM");
      const elapsed = Date.now() - start;

      // We waited for the job (at least jobDurationMs)
      expect(elapsed).toBeGreaterThanOrEqual(jobDurationMs - 20);
      // scheduler.stop() was called
      expect(scheduler.stop).toHaveBeenCalled();
      expect(opts.forceExit).toHaveBeenCalledWith(0);
    });

    it("stops scheduling new jobs immediately on drain start", async () => {
      const scheduler = makeScheduler({ running: false });
      const opts = makeOptions({ scheduler });
      const mgr = new GracefulShutdownManager(opts);

      await mgr.shutdown("SIGTERM");

      expect(scheduler.stop).toHaveBeenCalled();
    });

    it("proceeds after jobDrainTimeoutMs even if job is still running", async () => {
      vi.useRealTimers();

      // Job never finishes within the drain window
      let running = true;
      const scheduler: DrainableScheduler = {
        stop: vi.fn(),
        isJobRunning: () => running,
      };

      const opts = makeOptions({
        scheduler,
        gracePeriodMs: 5000,
        jobDrainTimeoutMs: 150,
      });
      const mgr = new GracefulShutdownManager(opts);

      const start = Date.now();
      await mgr.shutdown("SIGTERM");
      const elapsed = Date.now() - start;

      // Drained for approximately jobDrainTimeoutMs then moved on
      expect(elapsed).toBeGreaterThanOrEqual(150 - 20);
      // Still exited cleanly
      expect(opts.forceExit).toHaveBeenCalledWith(0);

      running = false;
    });

    it("skips job-running poll when scheduler has no isJobRunning()", async () => {
      const scheduler: DrainableScheduler = { stop: vi.fn() };
      const opts = makeOptions({ scheduler });
      const mgr = new GracefulShutdownManager(opts);

      await mgr.shutdown("SIGTERM");

      expect(scheduler.stop).toHaveBeenCalled();
      expect(opts.forceExit).toHaveBeenCalledWith(0);
    });

    it("works when no scheduler is set", async () => {
      const opts = makeOptions({ scheduler: undefined });
      const mgr = new GracefulShutdownManager(opts);

      await expect(mgr.shutdown("SIGTERM")).resolves.toBeUndefined();
      expect(opts.forceExit).toHaveBeenCalledWith(0);
    });
  });

  // -------------------------------------------------------------------------
  // Distributed lock release (outbox / invalidation bus)
  // -------------------------------------------------------------------------

  describe("outbox and invalidation bus", () => {
    it("calls outboxJob.stop() during shutdown", async () => {
      const outboxJob = { stop: vi.fn().mockResolvedValue(undefined) };
      const opts = makeOptions({ outboxJob });
      const mgr = new GracefulShutdownManager(opts);

      await mgr.shutdown("SIGTERM");

      expect(outboxJob.stop).toHaveBeenCalled();
    });

    it("calls invalidationBus.stop() during shutdown", async () => {
      const invalidationBus = { stop: vi.fn().mockResolvedValue(undefined) };
      const opts = makeOptions({ invalidationBus });
      const mgr = new GracefulShutdownManager(opts);

      await mgr.shutdown("SIGTERM");

      expect(invalidationBus.stop).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // DB pool and Redis close
  // -------------------------------------------------------------------------

  describe("connection pool shutdown", () => {
    it("calls end() on every DB pool", async () => {
      const pool1 = makePool();
      const pool2 = makePool();
      const opts = makeOptions({ dbPools: [pool1, pool2] });
      const mgr = new GracefulShutdownManager(opts);

      await mgr.shutdown("SIGTERM");

      expect(pool1.end).toHaveBeenCalled();
      expect(pool2.end).toHaveBeenCalled();
    });

    it("calls redis.disconnect()", async () => {
      const redis = makeRedis();
      const opts = makeOptions({ redis });
      const mgr = new GracefulShutdownManager(opts);

      await mgr.shutdown("SIGTERM");

      expect(redis.disconnect).toHaveBeenCalled();
    });

    it("continues shutdown if a pool.end() rejects", async () => {
      const badPool = { end: vi.fn().mockRejectedValue(new Error("pg gone")) };
      const goodPool = makePool();
      const opts = makeOptions({ dbPools: [badPool, goodPool] });
      const mgr = new GracefulShutdownManager(opts);

      await mgr.shutdown("SIGTERM");

      expect(goodPool.end).toHaveBeenCalled();
      // Logged error but still exited cleanly
      expect(opts.forceExit).toHaveBeenCalledWith(0);
    });

    it("continues shutdown if redis.disconnect() rejects", async () => {
      const redis: CloseableRedis = {
        disconnect: vi.fn().mockRejectedValue(new Error("redis gone")),
      };
      const opts = makeOptions({ redis });
      const mgr = new GracefulShutdownManager(opts);

      await mgr.shutdown("SIGTERM");

      expect(opts.forceExit).toHaveBeenCalledWith(0);
    });

    it("works when no pools or redis are provided", async () => {
      const opts = makeOptions({ dbPools: [], redis: undefined });
      const mgr = new GracefulShutdownManager(opts);

      await expect(mgr.shutdown("SIGTERM")).resolves.toBeUndefined();
      expect(opts.forceExit).toHaveBeenCalledWith(0);
    });
  });

  // -------------------------------------------------------------------------
  // Force-exit after grace timeout
  // -------------------------------------------------------------------------

  describe("force-exit after grace timeout", () => {
    it("calls forceExit(1) when grace period expires mid-shutdown", async () => {
      vi.useRealTimers();

      const forceExit = vi.fn();
      // Outbox job that hangs longer than grace period
      const outboxJob = {
        stop: vi.fn(
          () => new Promise<void>((r) => setTimeout(r, 5000)),
        ),
      };
      const mgr = new GracefulShutdownManager({
        logger: vi.fn(),
        forceExit,
        metrics: makeMetrics(),
        gracePeriodMs: 100,
        outboxJob,
      });

      // Don't await — the force-exit fires before shutdown resolves
      void mgr.shutdown("SIGTERM");

      // Let the grace period fire
      await new Promise<void>((r) => setTimeout(r, 300));

      expect(forceExit).toHaveBeenCalledWith(1);
    });

    it("increments the force_exit metric when grace period expires", async () => {
      vi.useRealTimers();

      const metrics = makeMetrics();
      const outboxJob = {
        stop: vi.fn(() => new Promise<void>((r) => setTimeout(r, 5000))),
      };
      const mgr = new GracefulShutdownManager({
        logger: vi.fn(),
        forceExit: vi.fn(),
        metrics,
        gracePeriodMs: 100,
        outboxJob,
      });

      void mgr.shutdown("SIGTERM");
      await new Promise<void>((r) => setTimeout(r, 300));

      expect(metrics.incForceExit).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Double-signal (idempotency)
  // -------------------------------------------------------------------------

  describe("double signal", () => {
    it("calls forceExit(1) on the second signal", async () => {
      const forceExit = vi.fn();
      const mgr = new GracefulShutdownManager(
        makeOptions({ forceExit }),
      );

      // First shutdown — resolves normally
      const first = mgr.shutdown("SIGTERM");
      // Second signal fires before first completes
      void mgr.shutdown("SIGTERM");

      await first;

      expect(forceExit).toHaveBeenCalledWith(1);
    });

    it("logs the second signal", async () => {
      const logger = vi.fn();
      const mgr = new GracefulShutdownManager(makeOptions({ logger }));

      void mgr.shutdown("SIGTERM");
      await mgr.shutdown("SIGTERM");

      const secondSignalLog = (logger as MockInstance).mock.calls.some((c) =>
        (c[0] as string).includes("second signal"),
      );
      expect(secondSignalLog).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Setter API
  // -------------------------------------------------------------------------

  describe("setter API", () => {
    it("setScheduler / setOutboxJob / setInvalidationBus / setWss / setDbPools / setRedis work", async () => {
      const mgr = new GracefulShutdownManager(
        makeOptions({ gracePeriodMs: 2000 }),
      );

      const pool = makePool();
      const redis = makeRedis();
      const outboxJob = { stop: vi.fn().mockResolvedValue(undefined) };
      const scheduler = makeScheduler();
      const invalidationBus = { stop: vi.fn().mockResolvedValue(undefined) };

      mgr.setOutboxJob(outboxJob);
      mgr.setScheduler(scheduler);
      mgr.setInvalidationBus(invalidationBus);
      mgr.setDbPools([pool]);
      mgr.setRedis(redis);

      await mgr.shutdown("SIGTERM");

      expect(outboxJob.stop).toHaveBeenCalled();
      expect(scheduler.stop).toHaveBeenCalled();
      expect(invalidationBus.stop).toHaveBeenCalled();
      expect(pool.end).toHaveBeenCalled();
      expect(redis.disconnect).toHaveBeenCalled();
    });

    it("trackConnection destroys socket on shutdown", async () => {
      const { Socket } = await import("net");
      const socket = new Socket();
      const destroySpy = vi.spyOn(socket, "destroy");

      // Force closeServer to throw so we reach the catch+destroyConnections path
      const server = makeServer();
      server.close = vi.fn((cb?: (err?: Error) => void) =>
        cb?.(new Error("forced")),
      );

      const mgr = new GracefulShutdownManager(
        makeOptions({ server, gracePeriodMs: 2000 }),
      );
      mgr.trackConnection(socket);

      await mgr.shutdown("SIGTERM");

      expect(destroySpy).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // SIGTERM during startup (no server registered)
  // -------------------------------------------------------------------------

  describe("SIGTERM during startup", () => {
    it("shuts down cleanly even before server is set", async () => {
      // Manager created with no server, simulating a signal that arrives
      // before app.listen() completes.
      const opts = makeOptions({ server: undefined });
      const mgr = new GracefulShutdownManager(opts);

      await mgr.shutdown("SIGTERM");

      expect(opts.forceExit).toHaveBeenCalledWith(0);
    });
  });
});
