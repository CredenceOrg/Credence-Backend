import { describe, it, expect, vi } from "vitest";
import type { Pool } from "pg";
import { LRUCache } from "lru-cache";
import { instrumentPreparedStatementCache } from "./pool.js";

function makeFakePool() {
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  const fakePool = { query } as unknown as Pool;
  return { fakePool, query };
}

describe("instrumentPreparedStatementCache", () => {
  it("assigns a name on first use and caches it", async () => {
    const { fakePool, query } = makeFakePool();
    const cache = new LRUCache<string, string>({ max: 10 });
    instrumentPreparedStatementCache(fakePool, cache);

    await fakePool.query("SELECT * FROM users WHERE id = $1", [1]);

    expect(query).toHaveBeenCalledTimes(1);
    const sent = query.mock.calls[0][0] as { name: string; text: string; values: unknown[] };
    expect(sent.text).toBe("SELECT * FROM users WHERE id = $1");
    expect(sent.values).toEqual([1]);
    expect(sent.name).toMatch(/^qs_[a-f0-9]{16}$/);
    expect(cache.size).toBe(1);
  });

  it("reuses the same name for repeat executions of identical text", async () => {
    const { fakePool, query } = makeFakePool();
    const cache = new LRUCache<string, string>({ max: 10 });
    instrumentPreparedStatementCache(fakePool, cache);

    await fakePool.query("SELECT * FROM users WHERE id = $1", [1]);
    await fakePool.query("SELECT * FROM users WHERE id = $1", [2]);

    const firstName = (query.mock.calls[0][0] as { name: string }).name;
    const secondName = (query.mock.calls[1][0] as { name: string }).name;
    expect(secondName).toBe(firstName);
    expect(cache.size).toBe(1);
  });

  it("assigns different names to different query text", async () => {
    const { fakePool, query } = makeFakePool();
    const cache = new LRUCache<string, string>({ max: 10 });
    instrumentPreparedStatementCache(fakePool, cache);

    await fakePool.query("SELECT * FROM users WHERE id = $1", [1]);
    await fakePool.query("SELECT * FROM orgs WHERE id = $1", [1]);

    const nameA = (query.mock.calls[0][0] as { name: string }).name;
    const nameB = (query.mock.calls[1][0] as { name: string }).name;
    expect(nameA).not.toBe(nameB);
    expect(cache.size).toBe(2);
  });

  it("re-derives the identical name after eviction and reuse (never remaps a name to different text)", async () => {
    const { fakePool, query } = makeFakePool();
    const cache = new LRUCache<string, string>({ max: 1 });
    instrumentPreparedStatementCache(fakePool, cache);

    await fakePool.query("SELECT 1", []);
    const nameBeforeEviction = (query.mock.calls[0][0] as { name: string }).name;

    // A second distinct query evicts "SELECT 1" from the max=1 cache.
    await fakePool.query("SELECT 2", []);
    expect(cache.size).toBe(1);
    expect(cache.get("SELECT 1")).toBeUndefined();

    // Re-querying the evicted text must get back the *same* name, never a
    // fresh/different one, since the name is a pure function of the text.
    await fakePool.query("SELECT 1", []);
    const nameAfterEviction = (query.mock.calls[2][0] as { name: string }).name;
    expect(nameAfterEviction).toBe(nameBeforeEviction);
  });

  it("caps cache size at the configured max under sustained distinct query pressure", async () => {
    const { fakePool } = makeFakePool();
    const cache = new LRUCache<string, string>({ max: 5 });
    instrumentPreparedStatementCache(fakePool, cache);

    for (let i = 0; i < 50; i++) {
      await fakePool.query(`SELECT ${i}`, []);
    }

    expect(cache.size).toBe(5);
  });

  it("passes through unmodified when an explicit name is already set", async () => {
    const { fakePool, query } = makeFakePool();
    const cache = new LRUCache<string, string>({ max: 10 });
    instrumentPreparedStatementCache(fakePool, cache);

    await fakePool.query({ name: "caller_chosen", text: "SELECT 1", values: [] });

    expect(query).toHaveBeenCalledWith({ name: "caller_chosen", text: "SELECT 1", values: [] });
    expect(cache.size).toBe(0);
  });

  it("passes through unmodified for callback-style calls", async () => {
    const { fakePool, query } = makeFakePool();
    const cache = new LRUCache<string, string>({ max: 10 });
    instrumentPreparedStatementCache(fakePool, cache);

    const callback = vi.fn();
    fakePool.query("SELECT 1", callback as unknown as never);

    expect(query).toHaveBeenCalledWith("SELECT 1", callback);
    expect(cache.size).toBe(0);
  });

  it("does not cache multi-statement text (Postgres cannot PREPARE more than one command)", async () => {
    const { fakePool, query } = makeFakePool();
    const cache = new LRUCache<string, string>({ max: 10 });
    instrumentPreparedStatementCache(fakePool, cache);

    await fakePool.query("SELECT 1; SELECT 2", []);

    expect(query).toHaveBeenCalledWith("SELECT 1; SELECT 2", []);
    expect(cache.size).toBe(0);
  });

  it("does not cache a single statement with a harmless trailing semicolon", async () => {
    const { fakePool, query } = makeFakePool();
    const cache = new LRUCache<string, string>({ max: 10 });
    instrumentPreparedStatementCache(fakePool, cache);

    await fakePool.query("SELECT 1;", []);

    const sent = query.mock.calls[0][0] as { name: string; text: string };
    expect(sent.name).toMatch(/^qs_[a-f0-9]{16}$/);
    expect(cache.size).toBe(1);
  });

  it("preserves other QueryConfig fields when caching an object-form call", async () => {
    const { fakePool, query } = makeFakePool();
    const cache = new LRUCache<string, string>({ max: 10 });
    instrumentPreparedStatementCache(fakePool, cache);

    await fakePool.query({ text: "SELECT 1", values: [], rowMode: "array" } as never);

    const sent = query.mock.calls[0][0] as { rowMode: string; name: string };
    expect(sent.rowMode).toBe("array");
    expect(sent.name).toMatch(/^qs_[a-f0-9]{16}$/);
  });
});
