import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BoundedBackoff } from "./backoff.js";

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
});
