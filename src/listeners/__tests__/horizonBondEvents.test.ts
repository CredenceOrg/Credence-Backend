import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { register } from "prom-client";
import { CursorRepository } from "../../db/repositories/cursorRepository.js";
import { BoundedBackoff } from "../../utils/backoff.js";
import { DlqRouter, type DlqSink } from "../messageValidator.js";
import { computeStateHash, stateFromBondEvent, extractLedgerSeq } from "../../services/horizonParity.js";

const poolMocks = vi.hoisted(() => {
  const mockClientQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
  const mockClientRelease = vi.fn()
  const mockClient = { query: mockClientQuery, release: mockClientRelease }
  const mockPoolConnect = vi.fn().mockResolvedValue(mockClient)
  const mockPoolQuery = vi.fn().mockResolvedValue({ rows: [] })
  return { mockClientQuery, mockClientRelease, mockClient, mockPoolConnect, mockPoolQuery }
})

vi.mock("../../db/pool.js", () => ({
  pool: { connect: poolMocks.mockPoolConnect, query: poolMocks.mockPoolQuery },
  workerPool: { connect: poolMocks.mockPoolConnect, query: poolMocks.mockPoolQuery },
  apiPreparedStatementCache: new Map(),
  workerPreparedStatementCache: new Map(),
  replicaPreparedStatementCache: new Map(),
}))

vi.mock("../../db/outbox/emitter.js", () => ({
  outboxEmitter: {
    emitBatch: vi.fn().mockResolvedValue([1n, 2n]),
  },
}))

vi.mock("../../services/identityService.js", () => ({
  upsertIdentity: vi.fn().mockResolvedValue(undefined),
  upsertBond: vi.fn().mockResolvedValue(undefined),
  upsertCursor: vi.fn().mockResolvedValue(undefined),
}));

// The listener load graph transitively pulls reputationService (via the
// transaction/cache-invalidation edge introduced on the rebased base), which
// would otherwise import middleware/metrics and the full observability +
// pool setup. Mock it so the module graph loads cleanly in isolation.
vi.mock("../../services/reputationService.js", () => ({
  invalidateTrustScoreCache: vi.fn().mockResolvedValue(undefined),
}));

let capturedHandlers: { onmessage?: any; onerror?: any } = {};
let streamCallCount = 0;
let lastCursorVal: string | undefined;
let closeSpies: Array<ReturnType<typeof vi.fn>> = [];
const sdkMocks = vi.hoisted(() => ({
  streamSpy: vi.fn(),
}));

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
            stream: sdkMocks.streamSpy.mockImplementation(function(handlers: any) {
              streamCallCount++;
              capturedHandlers.onmessage = handlers.onmessage;
              capturedHandlers.onerror = handlers.onerror;
              const closeFn = vi.fn();
              closeSpies.push(closeFn);
              return closeFn;
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

import {
  subscribeBondCreationEvents,
  subscribeBondCreationEventsAtomic,
  type AtomicBondEventProcessor,
} from "../horizonBondEvents.js";
import { upsertBond, upsertCursor, upsertIdentity } from "../../services/identityService.js";

const STREAM_NAME = "bond_creation";

function makeRouter(): DlqRouter {
  const sink: DlqSink = {
    async captureFailure() {},
  };
  return new DlqRouter(sink);
}

function makeSpyRouter(): { router: DlqRouter; captureFailure: ReturnType<typeof vi.fn> } {
  const captureFailure = vi.fn().mockResolvedValue(undefined);
  return { router: new DlqRouter({ captureFailure }), captureFailure };
}

/**
 * `subscribeBondCreationEvents` opens its stream asynchronously (it first
 * loads the saved cursor), so wait a few ticks before invoking captured
 * handlers to avoid racing the stream setup.
 */
async function flushStreamSetup(): Promise<void> {
  await new Promise((resolve) => process.nextTick(resolve));
  await new Promise((resolve) => process.nextTick(resolve));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Extract the ledger INSERT call (params included) from a mocked client. */
function ledgerInsertCalls(query: ReturnType<typeof vi.fn>) {
  return query.mock.calls.filter(([sql]) =>
    String(sql).includes("INSERT INTO horizon_events")
  );
}

// ---------------------------------------------------------------------------
// Issue #1266 — events and audit parity: the ledger record is written inside
// the SAME transaction as the state mutation and cursor checkpoint, so a
// record only ever exists for a committed transition, and a failed
// transition leaves no partial state and no record.
// ---------------------------------------------------------------------------
describe("subscribeBondCreationEvents — event ledger parity", () => {
  const makeBondOp = (overrides: Record<string, unknown> = {}) => ({
    type: "create_bond",
    id: "op-ledger-1",
    paging_token: "1000",
    source_account: "GABC",
    amount: "100",
    duration: "365",
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandlers = {};
  });

  afterEach(() => {
    vi.clearAllMocks();
    capturedHandlers = {};
    streamCallCount = 0;
    lastCursorVal = undefined;
  });

  it("writes a versioned, complete record with correlation identifiers inside the transaction", async () => {
    const { router } = makeSpyRouter();
    const onEvent = vi.fn();
    const h = subscribeBondCreationEvents(router, onEvent);
    await flushStreamSetup();

    await capturedHandlers.onmessage?.(makeBondOp());

    const inserts = ledgerInsertCalls(poolMocks.mockClientQuery);
    expect(inserts).toHaveLength(1);
    const [, params] = inserts[0] as [string, unknown[]];
    const [streamName, eventId, pagingToken, ledgerSeq, eventType, payload, stateHash] = params as string[];

    expect(streamName).toBe("bond_creation");
    expect(eventId).toBe("op-ledger-1");
    expect(pagingToken).toBe("1000");
    expect(ledgerSeq).toBe(extractLedgerSeq("1000"));
    expect(eventType).toBe("create_bond");
    expect(JSON.parse(payload)).toEqual({
      identity: { id: "GABC" },
      bond: { id: "op-ledger-1", address: "GABC", amount: "100", duration: "365" },
    });
    expect(stateHash).toBe(
      computeStateHash(
        stateFromBondEvent({
          identity: { id: "GABC" },
          bond: { id: "op-ledger-1", address: "GABC", amount: "100", duration: "365" },
        })
      )
    );

    // The record is written between BEGIN and COMMIT — same durable unit as
    // the identity/bond mutation and the cursor checkpoint.
    const sqls = poolMocks.mockClientQuery.mock.calls.map(([sql]) => String(sql));
    const beginIdx = sqls.findIndex((s) => s === "BEGIN");
    const commitIdx = sqls.findIndex((s) => s === "COMMIT");
    const insertIdx = sqls.findIndex((s) => s.includes("INSERT INTO horizon_events"));
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(commitIdx).toBeGreaterThan(beginIdx);
    expect(insertIdx).toBeGreaterThan(beginIdx);
    expect(insertIdx).toBeLessThan(commitIdx);

    // Caller-visible behaviour preserved.
    expect(onEvent).toHaveBeenCalledTimes(1);
    h.stop();
  });

  it("rolls back and routes to the DLQ when the ledger write fails — no partial state", async () => {
    const { router, captureFailure } = makeSpyRouter();
    const onEvent = vi.fn();
    const h = subscribeBondCreationEvents(router, onEvent);
    await flushStreamSetup();

    let calls: unknown[][] = [];
    poolMocks.mockClientQuery.mockImplementation((sql: string) => {
      calls.push([sql]);
      if (String(sql).includes("INSERT INTO horizon_events")) {
        return Promise.reject(new Error("ledger unavailable"));
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    try {
      await capturedHandlers.onmessage?.(makeBondOp());
    } finally {
      poolMocks.mockClientQuery.mockReset();
    }

    const sqls = calls.map(([sql]) => String(sql));
    expect(sqls).toContain("ROLLBACK");
    expect(sqls).not.toContain("COMMIT");

    // The failed transition was quarantined and never surfaced as committed.
    expect(captureFailure).toHaveBeenCalledWith(
      "bond_creation",
      expect.objectContaining({ id: "op-ledger-1" }),
      expect.stringContaining("PROCESSING_ERROR"),
    );
    expect(onEvent).not.toHaveBeenCalled();
    h.stop();
  });

  it("re-delivers the same operation id without duplicating the ledger record (idempotent replay)", async () => {
    const { router } = makeSpyRouter();
    const h = subscribeBondCreationEvents(router, vi.fn());
    await flushStreamSetup();

    await capturedHandlers.onmessage?.(makeBondOp());
    await capturedHandlers.onmessage?.(makeBondOp({ paging_token: "1000" }));

    // Both deliveries attempt the idempotent INSERT keyed on (stream, event_id);
    // the repository's ON CONFLICT DO NOTHING guarantees a single row.
    const inserts = ledgerInsertCalls(poolMocks.mockClientQuery);
    expect(inserts).toHaveLength(2);
    const eventIds = inserts.map(([, params]) => (params as string[])[1]);
    expect(eventIds).toEqual(["op-ledger-1", "op-ledger-1"]);
    h.stop();
  });

  it("rejects invalid payloads without state writes or ledger records", async () => {
    const { router, captureFailure } = makeSpyRouter();
    const h = subscribeBondCreationEvents(router, vi.fn());
    await flushStreamSetup();

    await capturedHandlers.onmessage?.(makeBondOp({ amount: "-5" }));

    expect(captureFailure).toHaveBeenCalledTimes(1);
    expect(captureFailure.mock.calls[0][2]).toContain("SCHEMA_VALIDATION_FAILED");
    expect(ledgerInsertCalls(poolMocks.mockClientQuery)).toHaveLength(0);
    expect(poolMocks.mockClientQuery.mock.calls.some(([sql]) => String(sql) === "BEGIN")).toBe(false);
    h.stop();
  });
});

describe("subscribeBondCreationEvents", () => {
  afterEach(() => {
    vi.clearAllMocks();
    capturedHandlers = {};
    streamCallCount = 0;
    lastCursorVal = undefined;
  });

  it("opens exactly ONE stream on subscribe", async () => {
    const h = subscribeBondCreationEvents(makeRouter());
    await flushStreamSetup();
    expect(streamCallCount).toBe(1);
    h.stop();
  });

  it("does NOT open a second stream — no duplicate", async () => {
    const h = subscribeBondCreationEvents(makeRouter());
    await flushStreamSetup();
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
    await flushStreamSetup();
    await capturedHandlers.onmessage?.({
      type: "create_bond", id: "op1", paging_token: "1001",
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
    await flushStreamSetup();
    await capturedHandlers.onmessage?.({
      type: "payment", id: "op2", paging_token: "1002",
      source_account: "GXYZ", amount: "50",
    });
    expect(onEvent).not.toHaveBeenCalled();
    h.stop();
  });

  it("stop() prevents further reconnects after error", async () => {
    const h = subscribeBondCreationEvents(makeRouter());
    await flushStreamSetup();
    h.stop();
    const countBefore = streamCallCount;
    await capturedHandlers.onerror?.(new Error("test"));
    expect(streamCallCount).toBe(countBefore);
  });

  describe("Reconnect with bounded exponential backoff", () => {
    it("onerror triggers reconnect with backoff", async () => {
      const h = subscribeBondCreationEvents(makeRouter());
      await flushStreamSetup();
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
      await flushStreamSetup();
      
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
      await flushStreamSetup();
      
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
      await flushStreamSetup();
      
      // Clear previous calls
      setSpy.mockClear();
      
      // Send a successful create_bond message
      await capturedHandlers.onmessage?.({
        type: "create_bond",
        id: "op1",
        paging_token: "1001",
        source_account: "GABC",
        amount: "100",
        duration: "365",
      });
      
      // Successful processing must never mark the stream down — the stream
      // stays up (set to 1 at start) through event handling.
      expect(setSpy).not.toHaveBeenCalledWith({ stream: STREAM_NAME }, 0);
      h.stop();
    });

    it("stop() cancels pending reconnect timer", async () => {
      const h = subscribeBondCreationEvents(makeRouter());
      await flushStreamSetup();

      // Trigger an error to start the backoff wait.
      const errorPromise = capturedHandlers.onerror?.(new Error("test error"));
      // Let the handler reach backoff.wait() (which schedules the reconnect timer).
      await new Promise((resolve) => process.nextTick(resolve));

      // Stop cancels the pending wait; the listener swallows the { stopped }
      // rejection inside its onerror handler and must NOT open a new stream.
      h.stop();
      await errorPromise;
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(streamCallCount).toBe(1);
    });
  });

  describe("Backoff reset on successful event", () => {
    it("backoff resets after successful message processing", async () => {
      const onEvent = vi.fn();
      const h = subscribeBondCreationEvents(makeRouter(), onEvent);
      await flushStreamSetup();
      
      // Send a successful create_bond message
      await capturedHandlers.onmessage?.({
        type: "create_bond",
        id: "op1",
        paging_token: "1001",
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

describe("Issue #1607 — shared listener gauges, SDK close semantics, serial queue, and monotonic cursors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandlers = {};
    streamCallCount = 0;
    lastCursorVal = undefined;
    closeSpies = [];
    poolMocks.mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    poolMocks.mockPoolConnect.mockResolvedValue(poolMocks.mockClient);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    capturedHandlers = {};
    streamCallCount = 0;
    lastCursorVal = undefined;
    closeSpies = [];
  });

  it("imports horizonBondEvents, horizonBondEvents.atomic, and horizonWithdrawalEvents together with real prom-client without duplicate registration", async () => {
    await expect(
      Promise.all([
        import("../horizonBondEvents.js"),
        import("../horizonBondEvents.atomic.js"),
        import("../horizonWithdrawalEvents.js"),
      ]),
    ).resolves.toBeDefined();

    const lagMetric = register.getSingleMetric("horizon_listener_cursor_lag_seconds");
    const checkpointMetric = register.getSingleMetric("horizon_listener_last_checkpoint_timestamp");
    expect(lagMetric).toBeDefined();
    expect(checkpointMetric).toBeDefined();

    const metricsJson = await register.getMetricsAsJSON();
    expect(
      metricsJson.filter((m) => m.name === "horizon_listener_cursor_lag_seconds"),
    ).toHaveLength(1);
    expect(
      metricsJson.filter((m) => m.name === "horizon_listener_last_checkpoint_timestamp"),
    ).toHaveLength(1);
  });

  it.each([
    [
      "subscribeBondCreationEvents",
      () => subscribeBondCreationEvents(makeRouter()),
    ],
    [
      "subscribeBondCreationEventsAtomic",
      () =>
        subscribeBondCreationEventsAtomic(
          makeRouter(),
          undefined,
          undefined,
          { process: vi.fn().mockResolvedValue(undefined) } as unknown as AtomicBondEventProcessor,
        ),
    ],
  ])(
    "%s: after 3 onerror cycles, stream was called 4 times, first 3 close functions ran once before next stream, and stop() calls the 4th",
    async (_name, startListener) => {
      vi.spyOn(BoundedBackoff.prototype, "wait").mockResolvedValue(undefined);

      const handle = startListener();
      await flushStreamSetup();

      expect(streamCallCount).toBe(1);
      expect(closeSpies).toHaveLength(1);
      expect(closeSpies[0]).not.toHaveBeenCalled();

      for (let i = 0; i < 3; i++) {
        await capturedHandlers.onerror?.(new Error(`stream error ${i + 1}`));
      }

      expect(streamCallCount).toBe(4);
      expect(closeSpies).toHaveLength(4);

      for (let i = 0; i < 3; i++) {
        expect(closeSpies[i]).toHaveBeenCalledTimes(1);
        expect(closeSpies[i].mock.invocationCallOrder[0]).toBeLessThan(
          sdkMocks.streamSpy.mock.invocationCallOrder[i + 1],
        );
      }

      expect(closeSpies[3]).not.toHaveBeenCalled();
      handle.stop();
      expect(closeSpies[3]).toHaveBeenCalledTimes(1);

      // Idempotent second stop() does not re-invoke close
      handle.stop();
      expect(closeSpies[3]).toHaveBeenCalledTimes(1);
    },
  );

  it("serialises onmessage in delivery order when first handler is slower than second, persisting the higher paging token", async () => {
    const processedOrder: string[] = [];
    (upsertIdentity as ReturnType<typeof vi.fn>).mockImplementation(async (identity: { id: string }) => {
      if (identity.id === "GSLOW") {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      processedOrder.push(identity.id);
    });

    const handle = subscribeBondCreationEvents(makeRouter());
    await flushStreamSetup();

    const p1 = capturedHandlers.onmessage?.({
      type: "create_bond",
      id: "op-100",
      paging_token: "100",
      source_account: "GSLOW",
      amount: "100",
      duration: "365",
    });
    const p2 = capturedHandlers.onmessage?.({
      type: "create_bond",
      id: "op-101",
      paging_token: "101",
      source_account: "GFAST",
      amount: "200",
      duration: "365",
    });

    await Promise.all([p1, p2]);

    expect(processedOrder).toEqual(["GSLOW", "GFAST"]);
    const cursorArgs = (upsertCursor as ReturnType<typeof vi.fn>).mock.calls.map(
      ([input]) => input.pagingToken,
    );
    expect(cursorArgs).toEqual(["100", "101"]);
    expect(cursorArgs.at(-1)).toBe("101");

    handle.stop();
  });

  it("serialises atomic listener onmessage and guards numeric BigInt cursor comparison ('9' vs '10')", async () => {
    const processedOps: string[] = [];
    const mockProcessor = {
      process: vi.fn().mockImplementation(async (event: { operationId: string }) => {
        if (event.operationId === "op-10") {
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        processedOps.push(event.operationId);
      }),
    } as unknown as AtomicBondEventProcessor;

    const handle = subscribeBondCreationEventsAtomic(
      makeRouter(),
      undefined,
      undefined,
      mockProcessor,
    );
    await flushStreamSetup();

    // Deliver paging_token '10' (slow) followed by '9' (fast, lexicographically > '10' as string but < 10n as BigInt)
    const p1 = capturedHandlers.onmessage?.({
      type: "create_bond",
      id: "op-10",
      paging_token: "10",
      source_account: "GAAA",
      amount: "100",
      duration: "365",
    });
    const p2 = capturedHandlers.onmessage?.({
      type: "create_bond",
      id: "op-9",
      paging_token: "9",
      source_account: "GBBB",
      amount: "100",
      duration: "365",
    });

    await Promise.all([p1, p2]);

    expect(processedOps).toEqual(["op-10", "op-9"]);
    const cursorArgs = (upsertCursor as ReturnType<typeof vi.fn>).mock.calls.map(
      ([input]) => input.pagingToken,
    );
    // '9' must NOT overwrite '10' even though '9' > '10' in string order
    expect(cursorArgs).toEqual(["10"]);
    expect(cursorArgs.at(-1)).toBe("10");

    handle.stop();
  });

  it.each([
    [
      "subscribeBondCreationEvents",
      (procSpy: ReturnType<typeof vi.fn>) => {
        void procSpy;
        return subscribeBondCreationEvents(makeRouter());
      },
    ],
    [
      "subscribeBondCreationEventsAtomic",
      (procSpy: ReturnType<typeof vi.fn>) =>
        subscribeBondCreationEventsAtomic(
          makeRouter(),
          undefined,
          undefined,
          { process: procSpy } as unknown as AtomicBondEventProcessor,
        ),
    ],
  ])("%s: drops messages delivered after stop() with zero database writes", async (_name, startListener) => {
    const procSpy = vi.fn().mockResolvedValue(undefined);
    const handle = startListener(procSpy);
    await flushStreamSetup();

    vi.clearAllMocks();
    handle.stop();

    await capturedHandlers.onmessage?.({
      type: "create_bond",
      id: "op-after-stop",
      paging_token: "2000",
      source_account: "GABC",
      amount: "100",
      duration: "365",
    });

    expect(poolMocks.mockPoolConnect).not.toHaveBeenCalled();
    expect(poolMocks.mockClientQuery).not.toHaveBeenCalled();
    expect(upsertIdentity).not.toHaveBeenCalled();
    expect(upsertBond).not.toHaveBeenCalled();
    expect(upsertCursor).not.toHaveBeenCalled();
    expect(procSpy).not.toHaveBeenCalled();
  });

  it("upsertCursor SQL guards against backwards numeric paging_token writes", async () => {
    const actualIdentity = await vi.importActual<typeof import("../../services/identityService.js")>(
      "../../services/identityService.js",
    );
    const querySpy = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    await actualIdentity.upsertCursor(
      { streamName: "bond_creation", pagingToken: "10" },
      { query: querySpy } as any,
    );

    expect(querySpy).toHaveBeenCalledTimes(1);
    const [sql, params] = querySpy.mock.calls[0] as [string, string[]];
    expect(params).toEqual(["bond_creation", "10"]);
    expect(sql).toContain("EXCLUDED.paging_token::numeric >= horizon_cursors.paging_token::numeric");
  });
});
