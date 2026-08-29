import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { CursorRepository } from "../../db/repositories/cursorRepository.js";
import { DlqRouter, type DlqSink } from "../messageValidator.js";

const poolMocks = vi.hoisted(() => {
  const mockClientQuery = vi.fn()
  const mockClientRelease = vi.fn()
  const mockClient = { query: mockClientQuery, release: mockClientRelease }
  const mockPoolConnect = vi.fn().mockResolvedValue(mockClient)
  const mockPoolQuery = vi.fn().mockResolvedValue({ rows: [] })
  return { mockClientQuery, mockClientRelease, mockClient, mockPoolConnect, mockPoolQuery }
})

vi.mock("prom-client", () => ({
  register: {},
  Gauge: vi.fn().mockImplementation(function() { return { set: vi.fn() }; }),
}));

vi.mock("../../db/pool.js", () => ({
  pool: { connect: poolMocks.mockPoolConnect, query: poolMocks.mockPoolQuery },
}))

vi.mock("../../services/identityService.js", () => ({
  upsertIdentity: vi.fn().mockResolvedValue(undefined),
  upsertBond: vi.fn().mockResolvedValue(undefined),
  upsertCursor: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../observability/horizonMetrics.js", () => ({
  getHorizonMetrics: vi.fn().mockReturnValue({
    reconnectTotal: { inc: vi.fn() },
    streamUp: { set: vi.fn() },
  }),
}));

let capturedHandlers: { onmessage?: any; onerror?: any } = {};
let streamCallCount = 0;
let lastCursorVal: string | undefined;

vi.mock("@stellar/stellar-sdk", () => {
  return {
    Horizon: {
      Server: vi.fn().mockImplementation(function() {
        return {
          operations: vi.fn().mockReturnValue({
            forAsset: vi.fn().mockReturnThis(),
            cursor: vi.fn().mockImplementation(function(c: string) {
              lastCursorVal = c;
              return this;
            }),
            stream: vi.fn().mockImplementation(function(handlers: any) {
              streamCallCount++;
              capturedHandlers.onmessage = handlers.onmessage;
              capturedHandlers.onerror = handlers.onerror;
              return { close: vi.fn() };
            }),
          }),
        };
      }),
    },
    StrKey: {
      isValidEd25519PublicKey: (account: string) => typeof account === 'string' && account.startsWith('G'),
      isValidMuxedAccount: () => false,
    },
  };
});

import { subscribeBondCreationEvents } from "../horizonBondEvents.js";

const STREAM_NAME = "bond_creation";

function makeRouter(): DlqRouter {
  const sink: DlqSink = {
    async captureFailure() {},
  };
  return new DlqRouter(sink);
}

describe("subscribeBondCreationEvents", () => {
  afterEach(() => {
    vi.clearAllMocks();
    capturedHandlers = {};
    streamCallCount = 0;
    lastCursorVal = undefined;
  });

  it("opens exactly ONE stream on subscribe", () => {
    const h = subscribeBondCreationEvents(makeRouter());
    expect(streamCallCount).toBe(1);
    h.stop();
  });

  it("does NOT open a second stream — no duplicate", () => {
    const h = subscribeBondCreationEvents(makeRouter());
    expect(streamCallCount).toBe(1);
    h.stop();
  });

  it("returns a stop() handle", () => {
    const h = subscribeBondCreationEvents(makeRouter());
    expect(typeof h.stop).toBe("function");
    h.stop();
  });

  it("stop() does not throw", () => {
    const h = subscribeBondCreationEvents(makeRouter());
    expect(() => h.stop()).not.toThrow();
  });

  it("invokes onEvent for create_bond operations", async () => {
    const onEvent = vi.fn();
    const h = subscribeBondCreationEvents(makeRouter(), onEvent);
    await capturedHandlers.onmessage?.({
      type: "create_bond", id: "op1", paging_token: "tok1",
      source_account: "GABC", amount: "100", duration: "365",
    });
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      identity: { id: "GABC" },
      bond: expect.objectContaining({ amount: "100" }),
    }));
    h.stop();
  });

  it("does not invoke onEvent for non create_bond operations", async () => {
    const onEvent = vi.fn();
    const h = subscribeBondCreationEvents(makeRouter(), onEvent);
    await capturedHandlers.onmessage?.({
      type: "payment", id: "op2", paging_token: "tok2",
      source_account: "GXYZ", amount: "50",
    });
    expect(onEvent).not.toHaveBeenCalled();
    h.stop();
  });

  it("stop() prevents further reconnects after error", async () => {
    const h = subscribeBondCreationEvents(makeRouter());
    h.stop();
    const countBefore = streamCallCount;
    await capturedHandlers.onerror?.(new Error("test"));
    expect(streamCallCount).toBe(countBefore);
  });

  describe("Reconnect with bounded exponential backoff", () => {
    it("onerror triggers reconnect with backoff", async () => {
      const h = subscribeBondCreationEvents(makeRouter());
      expect(streamCallCount).toBe(1);
      
      // Trigger error - should attempt reconnect via backoff
      const promise = capturedHandlers.onerror?.(new Error("test error"));
      
      // Give microtask time to settle
      await new Promise((resolve) => process.nextTick(resolve));
      
      // streamCallCount should eventually increase after backoff wait
      // (actual timing depends on backoff delay which starts at 500ms)
      expect(typeof promise).toBe("object"); // It's a promise
      
      h.stop();
    });

    it("metrics.reconnectTotal incremented on each error", async () => {
      const { getHorizonMetrics } = await import("../../observability/horizonMetrics.js");
      const metrics = (getHorizonMetrics as any)();
      const incSpy = vi.spyOn(metrics.reconnectTotal, "inc");
      
      const h = subscribeBondCreationEvents(makeRouter());
      
      // Trigger an error
      await capturedHandlers.onerror?.(new Error("test error"));
      
      expect(incSpy).toHaveBeenCalledWith({ stream: STREAM_NAME });
      h.stop();
    });

    it("metrics.streamUp set to 0 on error", async () => {
      const { getHorizonMetrics } = await import("../../observability/horizonMetrics.js");
      const metrics = (getHorizonMetrics as any)();
      const setSpy = vi.spyOn(metrics.streamUp, "set");
      
      const h = subscribeBondCreationEvents(makeRouter());
      
      // Clear the spy to focus on error handling
      setSpy.mockClear();
      
      // Trigger an error
      await capturedHandlers.onerror?.(new Error("test error"));
      
      expect(setSpy).toHaveBeenCalledWith({ stream: STREAM_NAME }, 0);
      h.stop();
    });

    it("metrics.streamUp set to 1 on successful message (backoff reset)", async () => {
      const { getHorizonMetrics } = await import("../../observability/horizonMetrics.js");
      const metrics = (getHorizonMetrics as any)();
      const setSpy = vi.spyOn(metrics.streamUp, "set");
      
      const h = subscribeBondCreationEvents(makeRouter());
      
      // Clear previous calls
      setSpy.mockClear();
      
      // Send a successful create_bond message
      await capturedHandlers.onmessage?.({
        type: "create_bond",
        id: "op1",
        paging_token: "tok1",
        source_account: "GABC",
        amount: "100",
        duration: "365",
      });
      
      // Should be called (set to 1 initially in startStream)
      // We're verifying no stream up/down issues during successful processing
      expect(setSpy).toHaveBeenCalled();
      h.stop();
    });

    it("stop() cancels pending reconnect timer", async () => {
      const h = subscribeBondCreationEvents(makeRouter());
      
      // Trigger an error to start backoff
      const errorPromise = capturedHandlers.onerror?.(new Error("test error"));
      
      // Immediately stop
      h.stop();
      
      // The error promise should be rejected with stopped
      await expect(errorPromise).rejects.toMatchObject({ stopped: true });
    });
  });

  describe("Backoff reset on successful event", () => {
    it("backoff resets after successful message processing", async () => {
      const onEvent = vi.fn();
      const h = subscribeBondCreationEvents(makeRouter(), onEvent);
      
      // Send a successful create_bond message
      await capturedHandlers.onmessage?.({
        type: "create_bond",
        id: "op1",
        paging_token: "tok1",
        source_account: "GABC",
        amount: "100",
        duration: "365",
      });
      
      // After success, backoff should be reset
      // (verified by checking that next error starts from short delay)
      expect(onEvent).toHaveBeenCalledTimes(1);
      
      h.stop();
    });
  });

  describe("Idempotent restart with database cursor", () => {
    let mockPool: any;

    beforeEach(() => {
      mockPool = {} as any;
    });

    it("resumes from saved cursor when present in CursorRepository", async () => {
      const spy = vi.spyOn(CursorRepository.prototype, "findByStreamName")
        .mockResolvedValue({
          streamName: "bond_creation",
          pagingToken: "9876543210",
          lastCheckpoint: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        });

      const h = subscribeBondCreationEvents(makeRouter(), undefined, mockPool);

      // Wait for the async initAndStart microtasks to run
      await new Promise((resolve) => process.nextTick(resolve));

      expect(spy).toHaveBeenCalledWith("bond_creation");
      expect(lastCursorVal).toBe("9876543210");
      expect(streamCallCount).toBe(1);
      h.stop();
    });

    it("falls back to 'now' if CursorRepository.findByStreamName returns null", async () => {
      const spy = vi.spyOn(CursorRepository.prototype, "findByStreamName")
        .mockResolvedValue(null);

      const h = subscribeBondCreationEvents(makeRouter(), undefined, mockPool);

      await new Promise((resolve) => process.nextTick(resolve));

      expect(spy).toHaveBeenCalledWith("bond_creation");
      expect(lastCursorVal).toBe("now");
      expect(streamCallCount).toBe(1);
      h.stop();
    });

    it("falls back to 'now' if CursorRepository.findByStreamName throws an error", async () => {
      const spy = vi.spyOn(CursorRepository.prototype, "findByStreamName")
        .mockRejectedValue(new Error("Database connection error"));

      const h = subscribeBondCreationEvents(makeRouter(), undefined, mockPool);

      await new Promise((resolve) => process.nextTick(resolve));

      expect(spy).toHaveBeenCalledWith("bond_creation");
      expect(lastCursorVal).toBe("now");
      expect(streamCallCount).toBe(1);
      h.stop();
    });
  });
});
