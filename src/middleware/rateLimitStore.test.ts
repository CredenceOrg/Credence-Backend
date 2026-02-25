import { describe, it, expect, beforeEach, vi } from "vitest";
import { RedisStore } from "./rateLimitStore.js";
import RedisMock from "ioredis-mock";

describe("RedisStore", () => {
  let redis: any;
  let store: RedisStore;
  const windowMs = 1000;

  beforeEach(() => {
    redis = new RedisMock();
    store = new RedisStore(redis, "test:", windowMs);
  });

  it("should increment a key and return hit count", async () => {
    const key = "user1";
    const result1 = await store.increment(key);
    expect(result1.totalHits).toBe(1);

    const result2 = await store.increment(key);
    expect(result2.totalHits).toBe(2);
  });

  it("should set expiry on the first increment", async () => {
    const key = "user2";
    await store.increment(key);
    const ttl = await redis.pttl(`test:${key}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(windowMs);
  });

  it("should reset a key", async () => {
    const key = "user3";
    await store.increment(key);
    await store.resetKey(key);
    const result = await store.increment(key);
    expect(result.totalHits).toBe(1);
  });

  it("should handle redis connection errors gracefully (fallback)", async () => {
    const key = "user4";
    // Force an error by mocking pipeline to fail
    vi.spyOn(redis, "pipeline").mockImplementation(() => {
      throw new Error("Connection lost");
    });

    const result = await store.increment(key);
    expect(result.totalHits).toBe(1); // Fallback behavior
    expect(result.resetTime).toBeInstanceOf(Date);
  });

  it("should decrement a key", async () => {
    const key = "user5";
    await store.increment(key);
    await store.increment(key);
    await store.decrement(key);

    const val = await redis.get(`test:${key}`);
    expect(parseInt(val)).toBe(1);
  });
});
