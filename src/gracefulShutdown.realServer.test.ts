import { describe, it, expect, vi, afterEach } from "vitest";
import http from "http";
import type { AddressInfo } from "net";
import { GracefulShutdownManager } from "./gracefulShutdown.js";
import type { CloseablePool, CloseableRedis } from "./gracefulShutdown.js";

// ---------------------------------------------------------------------------
// These tests exercise GracefulShutdownManager against a *real* http.Server
// and real TCP sockets (no fakes for server.close()/connection tracking).
// The existing gracefulShutdown.test.ts / __tests__/gracefulShutdown.test.ts
// suites assert phase ordering with a stubbed `server.close`, but never prove
// that an in-flight HTTP request is actually allowed to finish, nor that the
// overall SIGTERM -> pool closed -> exit(0) flow completes within a bounded
// time. That is exactly the contract issue #728 asks to lock in:
// "SIGTERM drains, closes pool, exits with 0 within N seconds."
//
// Synchronization is done via the request-handler callback firing (proof the
// connection was accepted and is in flight) rather than fixed sleeps, so
// these tests don't race against scheduling jitter.
// ---------------------------------------------------------------------------

function makePool(): CloseablePool & { end: ReturnType<typeof vi.fn> } {
  return { end: vi.fn().mockResolvedValue(undefined) };
}

function makeRedis(): CloseableRedis & { disconnect: ReturnType<typeof vi.fn> } {
  return { disconnect: vi.fn().mockResolvedValue(undefined) };
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function get(port: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/" }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
  });
}

describe("GracefulShutdownManager against a real HTTP server", () => {
  let server: http.Server | undefined;

  afterEach(() => {
    server?.closeAllConnections?.();
    server?.close();
    vi.useRealTimers();
  });

  it("drains the in-flight request, closes the pool and redis, and exits 0 well within the grace period", async () => {
    let signalRequestReceived: () => void;
    const requestReceived = new Promise<void>((resolve) => {
      signalRequestReceived = resolve;
    });

    server = http.createServer((_req, res) => {
      signalRequestReceived();
      setTimeout(() => {
        res.writeHead(200);
        res.end("ok");
      }, 150);
    });
    const port = await listen(server);

    const pool = makePool();
    const redis = makeRedis();
    const forceExit = vi.fn();
    const gracePeriodMs = 5000;

    const mgr = new GracefulShutdownManager({
      server,
      dbPools: [pool],
      redis,
      gracePeriodMs,
      forceExit,
      logger: vi.fn(),
    });
    server.on("connection", (socket) => mgr.trackConnection(socket));

    // Fire a request and wait until the server has actually started handling
    // it before the signal arrives, so the request is genuinely in flight.
    const inFlight = get(port);
    await requestReceived;

    const start = Date.now();
    await mgr.shutdown("SIGTERM");
    const elapsed = Date.now() - start;

    const response = await inFlight;
    expect(response.status).toBe(200);
    expect(response.body).toBe("ok");

    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(redis.disconnect).toHaveBeenCalledTimes(1);
    expect(forceExit).toHaveBeenCalledWith(0);
    expect(forceExit).toHaveBeenCalledTimes(1);

    // The happy path must not ride the grace-period timer to its limit.
    expect(elapsed).toBeLessThan(gracePeriodMs);
    // ...but it did wait for the 150ms handler to actually finish first.
    expect(elapsed).toBeGreaterThanOrEqual(140);

    expect(server.listening).toBe(false);
  });

  it("force-exits with code 1 when an in-flight request does not finish within the grace period", async () => {
    let releaseHandler: (() => void) | undefined;
    let signalRequestReceived: () => void;
    const requestReceived = new Promise<void>((resolve) => {
      signalRequestReceived = resolve;
    });

    server = http.createServer((_req, res) => {
      releaseHandler = () => {
        res.writeHead(200);
        res.end("late");
      };
      signalRequestReceived();
    });
    const port = await listen(server);

    const pool = makePool();
    const forceExit = vi.fn();
    const gracePeriodMs = 150;

    const mgr = new GracefulShutdownManager({
      server,
      dbPools: [pool],
      gracePeriodMs,
      forceExit,
      logger: vi.fn(),
    });
    server.on("connection", (socket) => mgr.trackConnection(socket));

    const stuckRequest = get(port).catch(() => undefined);
    await requestReceived;

    const start = Date.now();
    void mgr.shutdown("SIGTERM");

    await new Promise((r) => setTimeout(r, gracePeriodMs + 200));
    const elapsed = Date.now() - start;

    expect(forceExit).toHaveBeenCalledWith(1);
    expect(elapsed).toBeGreaterThanOrEqual(gracePeriodMs - 20);

    releaseHandler?.();
    await stuckRequest;
  });
});
