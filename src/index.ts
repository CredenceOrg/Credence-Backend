import express from "express";
import rateLimit from "express-rate-limit";
import { Redis } from "ioredis";
import { RedisStore } from "./middleware/rateLimitStore.js";

const app = express();
const PORT = process.env.PORT ?? 3000;

// Redis Configuration
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
});

redis.on("error", (err) => {
  console.error("Redis connection error:", err);
});

// Rate Limit Configuration
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per `window`
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  store: new RedisStore(redis, "rate-limit:", 15 * 60 * 1000),
  handler: (req, res, _next, options) => {
    res.status(options.statusCode).json({
      error: "Too many requests",
      message: options.message,
      retryAfter: res.getHeader("Retry-After"),
    });
  },
});

app.use(express.json());
app.use("/api/", limiter);

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "credence-backend", redis: redis.status });
});

app.get("/api/trust/:address", (req, res) => {
  const { address } = req.params;
  // Placeholder: in production, fetch from DB / reputation engine
  res.json({
    address,
    score: 0,
    bondedAmount: "0",
    bondStart: null,
    attestationCount: 0,
  });
});

app.get("/api/bond/:address", (req, res) => {
  const { address } = req.params;
  res.json({
    address,
    bondedAmount: "0",
    bondStart: null,
    bondDuration: null,
    active: false,
  });
});

app.listen(PORT, () => {
  console.log(`Credence API listening on http://localhost:${PORT}`);
});
