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
import {
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
  const costMeterConfig = { costWeights: config.endpointCostWeights, defaultMonthlyCredits: config.credits.defaultMonthly }
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
