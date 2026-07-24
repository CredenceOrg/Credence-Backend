import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { CursorRepository } from "../../db/repositories/cursorRepository.js";

vi.mock("prom-client", () => ({
  register: {},
  Gauge: vi.fn().mockImplementation(function() { return { set: vi.fn() }; }),
}));

vi.mock("../../services/identityService.js", () => ({
  upsertIdentity: vi.fn().mockResolvedValue(undefined),
  upsertBond: vi.fn().mockResolvedValue(undefined),
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

describe("subscribeBondCreationEvents", () => {
  afterEach(() => {
    vi.clearAllMocks();
    capturedHandlers = {};
    streamCallCount = 0;
    lastCursorVal = undefined;
  });

  it("opens exactly ONE stream on subscribe", () => {
    const h = subscribeBondCreationEvents({ captureFailure: vi.fn() });
    expect(streamCallCount).toBe(1);
    h.stop();
  });

  it("does NOT open a second stream — no duplicate", () => {
    const h = subscribeBondCreationEvents({ captureFailure: vi.fn() });
    expect(streamCallCount).toBe(1);
    h.stop();
  });

  it("returns a stop() handle", () => {
    const h = subscribeBondCreationEvents({ captureFailure: vi.fn() });
    expect(typeof h.stop).toBe("function");
    h.stop();
  });

  it("stop() does not throw", () => {
    const h = subscribeBondCreationEvents({ captureFailure: vi.fn() });
    expect(() => h.stop()).not.toThrow();
  });

  it("invokes onEvent for create_bond operations", async () => {
    const onEvent = vi.fn();
    const h = subscribeBondCreationEvents({ captureFailure: vi.fn() }, onEvent);
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
    const h = subscribeBondCreationEvents({ captureFailure: vi.fn() }, onEvent);
    await capturedHandlers.onmessage?.({
      type: "payment", id: "op2", paging_token: "tok2",
      source_account: "GXYZ", amount: "50",
    });
    expect(onEvent).not.toHaveBeenCalled();
    h.stop();
  });

  it("stop() prevents further reconnects after error", async () => {
    const h = subscribeBondCreationEvents({ captureFailure: vi.fn() });
    h.stop();
    const countBefore = streamCallCount;
    await capturedHandlers.onerror?.(new Error("test"));
    expect(streamCallCount).toBe(countBefore);
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

      const h = subscribeBondCreationEvents({ captureFailure: vi.fn() }, undefined, mockPool);

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

      const h = subscribeBondCreationEvents({ captureFailure: vi.fn() }, undefined, mockPool);

      await new Promise((resolve) => process.nextTick(resolve));

      expect(spy).toHaveBeenCalledWith("bond_creation");
      expect(lastCursorVal).toBe("now");
      expect(streamCallCount).toBe(1);
      h.stop();
    });

    it("falls back to 'now' if CursorRepository.findByStreamName throws an error", async () => {
      const spy = vi.spyOn(CursorRepository.prototype, "findByStreamName")
        .mockRejectedValue(new Error("Database connection error"));

      const h = subscribeBondCreationEvents({ captureFailure: vi.fn() }, undefined, mockPool);

      await new Promise((resolve) => process.nextTick(resolve));

      expect(spy).toHaveBeenCalledWith("bond_creation");
      expect(lastCursorVal).toBe("now");
      expect(streamCallCount).toBe(1);
      h.stop();
    });
  });
});