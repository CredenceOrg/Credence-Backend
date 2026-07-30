import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { BoundedBackoff, type JitterStrategy } from "./backoff.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("BoundedBackoff", () => {
  it("resolves after delay", async () => {
    const b = new BoundedBackoff({ baseMs: 100, maxMs: 1000 });
    const p = b.wait(); vi.runAllTimers(); await expect(p).resolves.toBeUndefined();
  });

  it("increments attempt and totalReconnects", async () => {
    const b = new BoundedBackoff({ baseMs: 10, maxMs: 100 });
    for (let i = 0; i < 3; i++) { const p = b.wait(); vi.runAllTimers(); await p; }
    expect(b.getState()).toMatchObject({ attempt: 3, totalReconnects: 3 });
  });

  it("reset() zeroes attempt but preserves totalReconnects", async () => {
    const b = new BoundedBackoff({ baseMs: 10, maxMs: 100 });
    const p = b.wait(); vi.runAllTimers(); await p;
    b.reset();
    expect(b.getState().attempt).toBe(0);
    expect(b.getState().totalReconnects).toBe(1);
  });

  it("rejects with exhausted after maxAttempts", async () => {
    const b = new BoundedBackoff({ baseMs: 10, maxMs: 100, maxAttempts: 2 });
    const p1 = b.wait(); vi.runAllTimers(); await p1;
    const p2 = b.wait(); vi.runAllTimers(); await p2;
    await expect(b.wait()).rejects.toMatchObject({ exhausted: true });
  });

  it("rejects with stopped when stop() called before wait()", async () => {
    const b = new BoundedBackoff();
    b.stop();
    await expect(b.wait()).rejects.toMatchObject({ stopped: true });
  });

  it("rejects with stopped when stop() called during pending wait", async () => {
    const b = new BoundedBackoff({ baseMs: 5000, maxMs: 10000 });
    const p = b.wait();
    b.stop();
    await expect(p).rejects.toMatchObject({ stopped: true });
  });

  it("clears pending timer on stop() - no timer leak", () => {
    const spy = vi.spyOn(global, "clearTimeout");
    const b = new BoundedBackoff({ baseMs: 5000, maxMs: 10000 });
    b.wait().catch(() => {});
    b.stop();
    expect(spy).toHaveBeenCalled();
  });

  it("delay never exceeds maxMs", async () => {
    const spy = vi.spyOn(global, "setTimeout");
    const b = new BoundedBackoff({ baseMs: 10, maxMs: 200 });
    for (let i = 0; i < 8; i++) { const p = b.wait(); vi.runAllTimers(); await p; }
    const delays = spy.mock.calls.map((c) => c[1] as number);
    expect(delays.every((d) => d <= 200)).toBe(true);
  });

  it("rapid error storm: each wait increments totalReconnects", async () => {
    const b = new BoundedBackoff({ baseMs: 10, maxMs: 50 });
    for (let i = 0; i < 5; i++) { const p = b.wait(); vi.runAllTimers(); await p; }
    expect(b.getState().totalReconnects).toBe(5);
  });

  describe("jitter strategies", () => {
    describe("none", () => {
      it("returns cap for each wait", async () => {
        const spy = vi.spyOn(global, "setTimeout");
        const b = new BoundedBackoff({ baseMs: 100, maxMs: 1000, jitter: "none" });
        for (let i = 0; i < 3; i++) { const p = b.wait(); vi.runAllTimers(); await p; }
        const delays = spy.mock.calls.map((c) => c[1] as number);
        expect(delays).toEqual([100, 200, 400]);
      });
    });

    describe("full", () => {
      it("yields 0 when randomFn returns 0", async () => {
        const spy = vi.spyOn(global, "setTimeout");
        const b = new BoundedBackoff({ baseMs: 100, maxMs: 1000, jitter: "full", randomFn: () => 0 });
        const p = b.wait(); vi.runAllTimers(); await p;
        expect(spy.mock.calls[0][1]).toBe(0);
      });

      it("yields cap - 1 when randomFn returns near 1", async () => {
        const spy = vi.spyOn(global, "setTimeout");
        const b = new BoundedBackoff({ baseMs: 100, maxMs: 1000, jitter: "full", randomFn: () => 0.999 });
        const p = b.wait(); vi.runAllTimers(); await p;
        expect(spy.mock.calls[0][1]).toBe(99);
      });

      it("default randomFn preserves existing behavior", async () => {
        const spy = vi.spyOn(global, "setTimeout");
        const b = new BoundedBackoff({ baseMs: 10, maxMs: 200, jitter: "full" });
        for (let i = 0; i < 8; i++) { const p = b.wait(); vi.runAllTimers(); await p; }
        const delays = spy.mock.calls.map((c) => c[1] as number);
        expect(delays.every((d) => d <= 200)).toBe(true);
      });
    });

    describe("equal", () => {
      it("yields half cap when randomFn returns 0", async () => {
        const spy = vi.spyOn(global, "setTimeout");
        const b = new BoundedBackoff({ baseMs: 100, maxMs: 1000, jitter: "equal", randomFn: () => 0 });
        const p = b.wait(); vi.runAllTimers(); await p;
        expect(spy.mock.calls[0][1]).toBe(50);
      });

      it("yields cap - 1 when randomFn returns near 1", async () => {
        const spy = vi.spyOn(global, "setTimeout");
        const b = new BoundedBackoff({ baseMs: 100, maxMs: 1000, jitter: "equal", randomFn: () => 0.999 });
        const p = b.wait(); vi.runAllTimers(); await p;
        expect(spy.mock.calls[0][1]).toBe(99);
      });
    });

    describe("decorrelated", () => {
      it("uses baseMs as previousDelay on first call", async () => {
        const spy = vi.spyOn(global, "setTimeout");
        const b = new BoundedBackoff({ baseMs: 100, maxMs: 1000, jitter: "decorrelated", randomFn: () => 0 });
        const p = b.wait(); vi.runAllTimers(); await p;
        expect(spy.mock.calls[0][1]).toBe(100);
      });

      it("never exceeds maxMs", async () => {
        const spy = vi.spyOn(global, "setTimeout");
        const b = new BoundedBackoff({ baseMs: 100, maxMs: 500, jitter: "decorrelated", randomFn: () => 0.999 });
        for (let i = 0; i < 10; i++) { const p = b.wait(); vi.runAllTimers(); await p; }
        const delays = spy.mock.calls.map((c) => c[1] as number);
        expect(delays.every((d) => d <= 500)).toBe(true);
      });
    });

    describe("default jitter preserves existing behavior", () => {
      it("defaults to full jitter when no strategy specified", async () => {
        const spy = vi.spyOn(global, "setTimeout");
        const b = new BoundedBackoff({ baseMs: 10, maxMs: 200 });
        for (let i = 0; i < 8; i++) { const p = b.wait(); vi.runAllTimers(); await p; }
        const delays = spy.mock.calls.map((c) => c[1] as number);
        expect(delays.every((d) => d <= 200)).toBe(true);
      });
    });
  });

  describe("fast-check property tests", () => {
    const strategies: JitterStrategy[] = ["none", "full", "equal", "decorrelated"];

    it("all strategies produce delays <= maxMs", () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...strategies),
          fc.integer({ min: 50, max: 500 }),
          fc.integer({ min: 100, max: 1000 }),
          fc.integer({ min: 1, max: 5 }),
          fc.double({ min: 0, max: 1, noDefaultInfinity: true, noNaN: true }),
          (strategy, baseMs, maxMs, calls, rngValue) => {
            fc.pre(baseMs <= maxMs);
            const spy = vi.spyOn(global, "setTimeout");
            const b = new BoundedBackoff({ baseMs, maxMs, jitter: strategy, randomFn: () => rngValue });
            for (let i = 0; i < calls; i++) { b.wait().catch(() => {}); vi.runAllTimers(); }
            const delays = spy.mock.calls.map((c) => c[1] as number);
            expect(delays.every((d) => d <= maxMs)).toBe(true);
            spy.mockRestore();
          },
        ),
      );
    });

    it("full jitter delay ∈ [0, cap]", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 50, max: 500 }),
          fc.integer({ min: 100, max: 2000 }),
          fc.double({ min: 0, max: 1, noDefaultInfinity: true, noNaN: true }),
          (baseMs, maxMs, rngValue) => {
            fc.pre(baseMs <= maxMs);
            const spy = vi.spyOn(global, "setTimeout");
            const b = new BoundedBackoff({ baseMs, maxMs, jitter: "full", randomFn: () => rngValue });
            b.wait().catch(() => {}); vi.runAllTimers();
            const delay = spy.mock.calls[0][1] as number;
            const cap = Math.min(maxMs, baseMs * Math.pow(2, 0));
            expect(delay).toBeGreaterThanOrEqual(0);
            expect(delay).toBeLessThanOrEqual(cap);
            spy.mockRestore();
          },
        ),
      );
    });

    it("equal jitter delay ∈ [cap/2, cap]", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 50, max: 500 }),
          fc.integer({ min: 100, max: 2000 }),
          fc.double({ min: 0, max: 1, noDefaultInfinity: true, noNaN: true }),
          (baseMs, maxMs, rngValue) => {
            fc.pre(baseMs <= maxMs);
            const spy = vi.spyOn(global, "setTimeout");
            const b = new BoundedBackoff({ baseMs, maxMs, jitter: "equal", randomFn: () => rngValue });
            b.wait().catch(() => {}); vi.runAllTimers();
            const delay = spy.mock.calls[0][1] as number;
            const cap = Math.min(maxMs, baseMs * Math.pow(2, 0));
            expect(delay).toBeGreaterThanOrEqual(Math.floor(cap / 2));
            expect(delay).toBeLessThanOrEqual(cap);
            spy.mockRestore();
          },
        ),
      );
    });

    it("decorrelated jitter delay ∈ [baseMs, cap]", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 50, max: 500 }),
          fc.integer({ min: 100, max: 2000 }),
          fc.double({ min: 0, max: 1, noDefaultInfinity: true, noNaN: true }),
          (baseMs, maxMs, rngValue) => {
            fc.pre(baseMs <= maxMs);
            const spy = vi.spyOn(global, "setTimeout");
            const b = new BoundedBackoff({ baseMs, maxMs, jitter: "decorrelated", randomFn: () => rngValue });
            b.wait().catch(() => {}); vi.runAllTimers();
            const delay = spy.mock.calls[0][1] as number;
            const cap = Math.min(maxMs, baseMs * Math.pow(2, 0));
            expect(delay).toBeGreaterThanOrEqual(baseMs);
            expect(delay).toBeLessThanOrEqual(cap);
            spy.mockRestore();
          },
        ),
      );
    });

    it("decorrelated jitter subsequent calls stay bounded", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 50, max: 200 }),
          fc.integer({ min: 300, max: 1000 }),
          fc.double({ min: 0, max: 1, noDefaultInfinity: true, noNaN: true }),
          (baseMs, maxMs, rngValue) => {
            fc.pre(baseMs <= maxMs);
            const spy = vi.spyOn(global, "setTimeout");
            const b = new BoundedBackoff({ baseMs, maxMs, jitter: "decorrelated", randomFn: () => rngValue });
            for (let i = 0; i < 5; i++) { b.wait().catch(() => {}); vi.runAllTimers(); }
            const delays = spy.mock.calls.map((c) => c[1] as number);
            expect(delays.every((d) => d <= maxMs)).toBe(true);
            expect(delays.every((d) => d >= 0)).toBe(true);
            spy.mockRestore();
          },
        ),
      );
    });
  });
});
