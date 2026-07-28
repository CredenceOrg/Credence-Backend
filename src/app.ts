import express from "express";
import { createJwksRouter } from "./routes/jwks.js";
import { createHealthRouter } from "./routes/health.js";
import { createVersionRouter } from "./routes/version.js";
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
import { cache } from "./cache/redis.js";
import { pool } from "./db/pool.js";
import { responseTimeMiddleware } from "./middleware/responseTime.js";
import { requestIdMiddleware } from "./middleware/requestId.js";
import { correlationIdMiddleware } from "./middleware/correlationId.js";
import { latencyBudgetMiddleware } from "./middleware/latencyBudget.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { createRateLimitMiddleware } from "./middleware/rateLimit.js";
import { createCostMeterMiddleware } from "./middleware/costMeter.js";
import { validateConfig } from "./config/index.js";
import { securityHeadersMiddleware } from "./middleware/securityHeaders.js";
import { createAttestationRouter } from "./routes/attestations.js";
import { tenantContextMiddleware } from "./middleware/tenantContext.js";
import { gracefulDegradeMiddleware } from "./middleware/gracefulDegrade.js";
import { createDevResponseValidator } from "./middleware/validateResponse.js";
import {
  compressionMiddleware,
  compressionMetricsMiddleware,
} from "./middleware/compression.js";
import { metricsMiddleware, register } from "./middleware/metrics.js";
import { createCidrWhitelistMiddleware } from "./middleware/cidrWhitelist.js";
import { createSafeRedirectMiddleware } from "./middleware/safeRedirect.js";
import {
  jsonBodyParser,
  requestSizeLimitErrorHandler,
} from "./middleware/requestSizeLimit.js";
import { createWsSubscriptionServer } from "./routes/ws.js";
import reportRouter from "./routes/report.js";
import cspReportRouter from "./routes/cspReport.js";
import { idempotencyMiddleware } from "./middleware/idempotency.js";
import { IdempotencyRepository } from "./db/repositories/idempotencyRepository.js";
import { createTimeoutBudgetMiddleware } from "./middleware/timeoutBudget.js";
import { clientVersionEchoMiddleware } from "./middleware/clientVersionEcho.js";
import { requestAttemptEchoMiddleware } from "./middleware/requestAttemptEcho.js";
import { RedisConnection } from "./cache/redis.js";
import { createFaultInjectionRouter } from "./routes/faultInjection.js";
import { cacheHeaderMiddleware } from "./middleware/cacheHeader.js";
import { createAuthRouter } from "./routes/auth.js";
import { createMaintenanceModeMiddleware } from "./middleware/maintenanceMode.js";
import { applyRouteCorsPolicy } from "./middleware/corsPolicy.js";
import { sunsetHeaderMiddleware } from "./middleware/sunsetHeader.js";
import { createOutboxAdminRouter } from "./routes/admin/outbox.js";

const app = express();

// ── Rate-limit configuration ──────────────────────────────────────────────────
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

let authRateLimitConfig: {
  enabled: boolean;
  windowSec: number;
  maxPerTenant: number;
  failOpen: boolean;
};
try {
  authRateLimitConfig = validateConfig(process.env).authRateLimit;
} catch {
  const isProd = process.env.NODE_ENV === "production";
  authRateLimitConfig = {
    enabled: true,
    windowSec: 60,
    maxPerTenant: 20,
    failOpen: !isProd,
  };
}

let globalTimeoutMs: number;
try {
  globalTimeoutMs = validateConfig(process.env).timeouts.global;
} catch {
  globalTimeoutMs = 30000;
}
const timeoutBudgetMiddleware = createTimeoutBudgetMiddleware(globalTimeoutMs);

// Resolve maintenance mode flag at startup; default to off when config is invalid.
let maintenanceModeEnabled = false;
try {
  maintenanceModeEnabled = validateConfig(process.env).maintenanceMode.enabled;
} catch {
  // Fail-open for maintenance mode: an invalid config must not block startup.
}
const maintenanceModeMiddleware = createMaintenanceModeMiddleware(maintenanceModeEnabled);

let corsOrigin = "*";
try {
  corsOrigin = validateConfig(process.env).cors.origin;
} catch {
  // Default to wildcard when config is invalid (dev/test convenience).
}

app.use(responseTimeMiddleware);
app.use(requestIdMiddleware);
app.use(securityHeadersMiddleware);
app.use(cacheHeaderMiddleware);
app.use(clientVersionEchoMiddleware);
app.use(requestAttemptEchoMiddleware);
app.use(timeoutBudgetMiddleware);

const metricsCidrs = process.env.METRICS_ALLOWED_CIDRS
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (metricsCidrs?.length) {
  app.get(
    "/metrics",
    createCidrWhitelistMiddleware(metricsCidrs),
    async (_req, res) => {
      res.set("Content-Type", register.contentType);
      res.end(await register.metrics());
    },
  );
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
app.use(gracefulDegradeMiddleware);

applyRouteCorsPolicy(app, corsOrigin);

// ── Routes ────────────────────────────────────────────────────────────────────

app.use(maintenanceModeMiddleware);
app.use(sunsetHeaderMiddleware);
app.use("/.well-known/jwks.json", createJwksRouter());

const healthProbes = createDefaultProbes();

let redisClient: import("./cache/redis.js").RedisClient | undefined;
if (process.env.REDIS_URL) {
  try {
    const conn = RedisConnection.getInstance();
    conn.connect().catch(() => {});
    redisClient = conn.getClient();
  } catch {
  }
}

app.use("/api/health", createHealthRouter({ ...healthProbes, isReady, redisClient }));
app.use("/api/version", createVersionRouter());

app.use("/api/auth", createAuthRouter(authRateLimitConfig));

app.use("/api", rateLimitMiddleware);

// Idempotency middleware — runs after body parsing, before route handlers.
try {
  const idempotencyConfig = validateConfig(process.env).idempotency;
  const idempotencyRepo = new IdempotencyRepository(pool);
  app.use(
    "/api",
    idempotencyMiddleware(idempotencyRepo, {
      expiresInSeconds: idempotencyConfig.ttlSeconds,
    }),
  );
} catch {
}

try {
  const config = validateConfig(process.env);
  const costMeterConfig = {
    costWeights: config.endpointCostWeights,
    defaultMonthlyCredits: config.credits.defaultMonthly,
    defaultLowCreditThreshold: config.credits.defaultLowCreditThreshold,
  };
  const costMeterMiddleware = createCostMeterMiddleware(
    costMeterConfig,
    () => pool,
  );
  app.use("/api", costMeterMiddleware);
} catch {
}

app.use("/api/trust", trustRouter);

// Bond status — uses the real BondService + BondStore backed by
// deriveBondPaymentStatus, with read-through caching via CacheService.
const bondService = new BondService(new BondStore());
app.use("/api/bond", createBondRouter(bondService, cache));

app.use("/api/attestations", createAttestationRouter());

app.use("/api/bulk", bulkRouter);

app.use("/api/imports", createImportsRouter());

// Defence-in-depth open-redirect guard for /api/admin/*.
const adminRedirectAllowedHosts = process.env.ADMIN_REDIRECT_ALLOWED_HOSTS
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean) ?? [];

app.use(
  "/api/admin",
  createSafeRedirectMiddleware({ allowedHosts: adminRedirectAllowedHosts }),
);
app.use("/api/admin", createAdminRouter());
app.use("/api/admin/webhooks", createWebhookAdminRouter());
app.use("/api/admin/feature-flags", createFeatureFlagAdminRouter());
app.use("/api/admin/outbox", createOutboxAdminRouter());

app.use("/api/orgs/:orgId/policies", createPolicyRouter());

const analyticsThresholdSeconds = Number(
  process.env.ANALYTICS_STALENESS_SECONDS ?? "300",
);
const analyticsService = process.env.DATABASE_URL
  ? new AnalyticsService(pool, analyticsThresholdSeconds)
  : undefined;
app.use("/api/analytics", createAnalyticsRouter(analyticsService));

app.use("/api/payouts", createPayoutsRouter());

app.use("/api/reports", reportRouter);
app.use("/api/export", createExportRouter());
app.use(cspReportRouter);


let devMode = false;
try {
  devMode = validateConfig(process.env).devMode;
} catch {
}
app.use(
  "/api/dev/fault-injection",
  createFaultInjectionRouter({ devMode }),
);

app.use(errorHandler);

export { createWsSubscriptionServer } from "./routes/ws.js";
export default app;
