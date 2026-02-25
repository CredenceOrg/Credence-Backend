import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import rateLimit from "express-rate-limit";
import request from "supertest";
import RedisMock from "ioredis-mock";
import { RedisStore } from "./rateLimitStore.js";

describe("Rate Limit Middleware Integration", () => {
  let app: express.Application;
  let redis: any;

  beforeEach(() => {
    redis = new RedisMock();
    app = express();

    const limiter = rateLimit({
      windowMs: 1000,
      max: 100, // High limit for general tests
      store: new RedisStore(redis, "limit:", 1000),
      handler: (_req, res) => {
        res.status(429).json({ error: "Too many requests" });
      },
    });

    app.use(limiter);
    app.get("/test", (_req, res) => {
      res.status(200).json({ ok: true });
    });
  });

  it("should allow requests within limit", async () => {
    const res1 = await request(app).get("/test");
    expect(res1.status).toBe(200);

    const res2 = await request(app).get("/test");
    expect(res2.status).toBe(200);
  });

  it("should block requests exceeding limit", async () => {
    const isolatedRedis = new RedisMock();
    const isolatedApp = express();
    const isolatedLimiter = rateLimit({
      windowMs: 1000,
      max: 2,
      store: new RedisStore(isolatedRedis, "block:", 1000),
      handler: (_req, res) => {
        res.status(429).json({ error: "Too many requests" });
      },
    });
    isolatedApp.use(isolatedLimiter);
    isolatedApp.get("/block", (_req, res) => res.send("ok"));

    await request(isolatedApp).get("/block");
    await request(isolatedApp).get("/block");
    const res3 = await request(isolatedApp).get("/block");

    expect(res3.status).toBe(429);
    expect(res3.body.error).toBe("Too many requests");
  });

  it("should use Redis to track hits", async () => {
    const isolatedRedis = new RedisMock();
    const isolatedApp = express();
    const isolatedLimiter = rateLimit({
      windowMs: 1000,
      max: 10,
      store: new RedisStore(isolatedRedis, "track:", 1000),
    });
    isolatedApp.use(isolatedLimiter);
    isolatedApp.get("/track", (_req, res) => res.send("ok"));

    await request(isolatedApp).get("/track");

    const keys = await isolatedRedis.keys("track:*");
    expect(keys.length).toBeGreaterThan(0);

    const val = await isolatedRedis.get(keys[0]);
    expect(parseInt(val!)).toBe(1);
  });
});
