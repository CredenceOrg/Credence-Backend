import express from 'express'
import { createJwksRouter } from './routes/jwks.js'
import { createHealthRouter } from './routes/health.js'
import { createDefaultProbes } from './services/health/probes.js'
import { RedisConnection } from './cache/redis.js'
import trustRouter from './routes/trust.js'
import bulkRouter from './routes/bulk.js'
import importsRouter from './routes/imports.js'
import { createAdminRouter } from './routes/admin/index.js'
import { createPolicyRouter } from './routes/policy.js'
import { createAnalyticsRouter } from './routes/analytics.js'
import { AnalyticsService } from './services/analytics/service.js'
import { pool } from './db/pool.js'
import { validate } from './middleware/validate.js'
import { requestIdMiddleware } from './middleware/requestId.js'
import express from "express";
import { createJwksRouter } from "./routes/jwks.js";
import { createHealthRouter } from "./routes/health.js";
import { createDefaultProbes } from "./services/health/probes.js";
import { isReady } from "./lifecycle.js";
import trustRouter from "./routes/trust.js";
import bulkRouter from "./routes/bulk.js";
import { createImportsRouter } from "./routes/imports.js";
import { createAdminRouter } from "./routes/admin/index.js";
import { createWebhookAdminRouter } from "./routes/admin/webhooks.js";
import { createFeatureFlagAdminRouter } from "./routes/admin/featureFlags.js";
import { createPolicyRouter } from "./routes/policy.js";
import { createAnalyticsRouter } from "./routes/analytics.js";
import { createPayoutsRouter } from "./routes/payouts.js";
import { AnalyticsService } from "./services/analytics/service.js";
import { BondService, BondStore } from "./services/bond/index.js";
import { createBondRouter } from "./routes/bond.js";
import { pool } from "./db/pool.js";
import { requestIdMiddleware } from "./middleware/requestId.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { createRateLimitMiddleware } from "./middleware/rateLimit.js";
import { createCostMeterMiddleware } from "./middleware/costMeter.js";
import { validateConfig } from "./config/index.js";
import { createAttestationRouter } from "./routes/attestations.js";
import { tenantContextMiddleware } from './middleware/tenantContext.js'
import {
  compressionMiddleware,
  compressionMetricsMiddleware,
} from "./middleware/compression.js";
import { metricsMiddleware, register } from "./middleware/metrics.js";
import { createCidrWhitelistMiddleware } from "./middleware/cidrWhitelist.js";
import {
  bondPathParamsSchema,
  attestationsPathParamsSchema,
  createAttestationBodySchema,
} from './schemas/index.js'
import { compressionMiddleware, compressionMetricsMiddleware } from './middleware/compression.js'
import { metricsMiddleware, register } from './middleware/metrics.js'
import { createMembersRouter } from './routes/admin/member.ts'

const app = express()

// Request context and correlation IDs
app.use(requestIdMiddleware)

// Metrics endpoint for Prometheus
app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType)
  res.end(await register.metrics())
})

app.use(metricsMiddleware)
app.use(compressionMetricsMiddleware)
app.use(compressionMiddleware)
app.use(express.json())

// JWT public key set — unauthenticated, per RFC 8414 / OIDC Discovery conventions
app.use('/.well-known/jwks.json', createJwksRouter())

// Health – full readiness check with per-dependency status
const healthProbes = createDefaultProbes()

// If Redis is configured, wire up a client for the worker-health endpoint
let redisClient: import('./cache/redis.js').RedisClient | undefined
if (process.env.REDIS_URL) {
  try {
    const conn = RedisConnection.getInstance()
    // Best-effort connect — the endpoint degrades gracefully if Redis is down
    conn.connect().catch(() => {})
    redisClient = conn.getClient()
  } catch {
    // Redis may not be reachable at startup; worker-health will degrade gracefully
  }
}

app.use('/api/health', createHealthRouter({ ...healthProbes, redisClient }))

// Trust score
app.use('/api/trust', trustRouter)

// Bond status (stub – to be wired to Horizon in a future milestone)
app.get(
  '/api/bond/:address',
  validate({ params: bondPathParamsSchema }),
  (req, res) => {
    const { address } = req.validated!.params! as { address: string }
    res.json({
      address,
      bondedAmount: '0',
      bondStart: null,
      bondDuration: null,
      active: false,
    })
  },
)

// Attestations – list
app.get(
  '/api/attestations/:address',
  validate({ params: attestationsPathParamsSchema }),
  (req, res, next) => {
    const { address } = req.validated!.params! as { address: string }
    try {
      const { page, limit, offset } = parsePaginationParams(req.query as Record<string, unknown>)
      res.json({
        address,
        attestations: [],
        offset,
        ...buildPaginationMeta(0, page, limit),
      })
    } catch (error) {
      next(error)
    }
  },
)

// Attestations – create
app.post(
  '/api/attestations',
  validate({ body: createAttestationBodySchema }),
  (req, res) => {
    const body = req.validated!.body! as { subject: string; value: string; key?: string }
    res.status(201).json({
      subject: body.subject,
      value: body.value,
      key: body.key ?? null,
    })
  },
)

// Bulk verification (enterprise)
app.use('/api/bulk', bulkRouter)

// Import preview (enterprise)
app.use('/api/imports', importsRouter)

// Admin API
app.use('/api/admin', createAdminRouter())
app.use('/api/admin/webhooks', createWebhookAdminRouter())

// Policy engine – fine-grained org permissions
app.use('/api/orgs/:orgId/policies', createPolicyRouter())

const analyticsThresholdSeconds = Number(process.env.ANALYTICS_STALENESS_SECONDS ?? '300')
  jsonBodyParser,
  requestSizeLimitErrorHandler,
} from "./middleware/requestSizeLimit.js";
import { createWsSubscriptionServer } from "./routes/ws.js";

const app = express();

let rateLimitConfig: {
  enabled: boolean;
  windowSec: number;
  maxFree: number;
  maxPro: number;
  maxEnterprise: number;
  failOpen: boolean;
};
try {
  rateLimitConfig = validateConfig(process.env).rateLimit;
} catch {
  // Fail-closed by default in production so a misconfigured startup cannot
  // silently disable rate limiting and expose the API to abuse.
  const isProd = process.env.NODE_ENV === "production";
  rateLimitConfig = {
    enabled: true,
    windowSec: 60,
    maxFree: 100,
    maxPro: 1000,
    maxEnterprise: 10000,
    failOpen: !isProd,
  };
}

const rateLimitMiddleware = createRateLimitMiddleware(rateLimitConfig);

app.use(requestIdMiddleware);

const metricsCidrs = process.env.METRICS_ALLOWED_CIDRS
  ?.split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (metricsCidrs?.length) {
  app.get("/metrics", createCidrWhitelistMiddleware(metricsCidrs), async (_req, res) => {
    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
  });
} else {
  app.get("/metrics", async (_req, res) => {
    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
  });
}

app.use(metricsMiddleware);
app.use(compressionMetricsMiddleware);
app.use(compressionMiddleware);
app.use(jsonBodyParser);
app.use(requestSizeLimitErrorHandler);
app.use(tenantContextMiddleware);

app.use("/.well-known/jwks.json", createJwksRouter());

const healthProbes = createDefaultProbes();
app.use("/api/health", createHealthRouter({ ...healthProbes, isReady }));

app.use("/api", rateLimitMiddleware);

try {
  const config = validateConfig(process.env)
  const costMeterConfig = {
    costWeights: config.endpointCostWeights,
    defaultMonthlyCredits: config.credits.defaultMonthly,
    defaultLowCreditThreshold: config.credits.defaultLowCreditThreshold,
  }
  const costMeterMiddleware = createCostMeterMiddleware(costMeterConfig, () => pool)
  app.use("/api", costMeterMiddleware)
} catch {
  // If config is invalid, cost metering is safely skipped
}

app.use("/api/trust", trustRouter);

const bondService = new BondService(new BondStore());
app.use("/api/bond", createBondRouter(bondService));

app.use("/api/attestations", createAttestationRouter());

app.use("/api/bulk", bulkRouter);

app.use("/api/imports", createImportsRouter());

app.use("/api/admin", createAdminRouter());
app.use("/api/admin/webhooks", createWebhookAdminRouter());
app.use("/api/admin/feature-flags", createFeatureFlagAdminRouter());

app.use("/api/orgs/:orgId/policies", createPolicyRouter());

const analyticsThresholdSeconds = Number(
  process.env.ANALYTICS_STALENESS_SECONDS ?? "300",
);
const analyticsService = process.env.DATABASE_URL
  ? new AnalyticsService(pool, analyticsThresholdSeconds)
  : undefined;
app.use("/api/analytics", createAnalyticsRouter(analyticsService));

app.use("/api/payouts", createPayoutsRouter());

app.use(errorHandler);

export { createWsSubscriptionServer } from "./routes/ws.js";
export default app;
