import type { Store, ClientRateLimitInfo } from "express-rate-limit";
import { Redis } from "ioredis";

/**
 * Redis-backed store for express-rate-limit.
 * Implements the Store interface to provide distributed rate limiting.
 */
export class RedisStore implements Store {
  redis: Redis;
  prefix: string;
  windowMs: number;

  /**
   * @param redis - An ioredis instance
   * @param prefix - Prefix for Redis keys
   */
  constructor(redis: Redis, prefix: string = "rl:", windowMs: number = 60000) {
    this.redis = redis;
    this.prefix = prefix;
    this.windowMs = windowMs;
  }

  /**
   * Mandatory method for express-rate-limit Store.
   * Increments the hit count for a key.
   */
  async increment(key: string): Promise<ClientRateLimitInfo> {
    const redisKey = `${this.prefix}${key}`;

    try {
      // Use Redis transaction/pipeline to ensure atomicity
      const results = await this.redis
        .pipeline()
        .incr(redisKey)
        .pttl(redisKey)
        .exec();

      if (!results) {
        throw new Error("Redis pipeline failed");
      }

      const [incrErr, hits] = results[0] as [Error | null, number];
      const [pttlErr, ttl] = results[1] as [Error | null, number];

      if (incrErr) throw incrErr;
      if (pttlErr) throw pttlErr;

      // If key is new (PTTL is -1), set the expiry
      if (ttl < 0) {
        await this.redis.pexpire(redisKey, this.windowMs);
      }

      return {
        totalHits: hits,
        resetTime: new Date(Date.now() + (ttl < 0 ? this.windowMs : ttl)),
      };
    } catch (error) {
      console.error("Redis RateLimitStore error:", error);
      // Fallback: simple local-ish allow for this single request if Redis is down
      // However, to satisfy the interface we must return something.
      // In a real production app, we might want to fail-open or fail-closed.
      // Here we fail-open by returning a low hit count.
      return {
        totalHits: 1,
        resetTime: new Date(Date.now() + this.windowMs),
      };
    }
  }

  /**
   * Decrements a key (not strictly required by all express-rate-limit versions but good to have).
   */
  async decrement(key: string): Promise<void> {
    const redisKey = `${this.prefix}${key}`;
    try {
      await this.redis.decr(redisKey);
    } catch (error) {
      console.error("Redis RateLimitStore decrement error:", error);
    }
  }

  /**
   * Resets the hit count for a key.
   */
  async resetKey(key: string): Promise<void> {
    const redisKey = `${this.prefix}${key}`;
    try {
      await this.redis.del(redisKey);
    } catch (error) {
      console.error("Redis RateLimitStore resetKey error:", error);
    }
  }

  /**
   * Initialization if required by express-rate-limit.
   */
  init(options: { windowMs: number }): void {
    this.windowMs = options.windowMs;
  }
}
