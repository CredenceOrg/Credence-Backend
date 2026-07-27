import express from 'express'
import { createJwksRouter } from './routes/jwks.js'
import { createHealthRouter } from './routes/health.js'
import { createDefaultProbes } from './services/health/probes.js'
import trustRouter from './routes/trust.js'
import bulkRouter from './routes/bulk.js'
import importsRouter from './routes/imports.js'
import { createAdminRouter } from './routes/admin/index.js'
import { createWebhookAdminRouter } from './routes/admin/webhooks.js'
import { createRateLimitAdminRouter } from './routes/admin/rateLimit.js'
import { createPolicyRouter } from './routes/policy.js'
import { createAnalyticsRouter } from './routes/analytics.js'
import { createPayoutsRouter } from './routes/payouts.js'
import { AnalyticsService } from './services/analytics/service.js'
import { BondService, BondStore } from './services/bond/index.js'
import { createBondRouter } from './routes/bond.js'
import { pool } from './db/pool.js'
import { validate } from './middleware/validate.js'
import { requestIdMiddleware } from './middleware/requestId.js'
import { errorHandler } from './middleware/errorHandler.js'
import { createRateLimitMiddleware } from './middleware/rateLimit.js'
import { validateConfig } from './config/index.js'
import {
  buildPaginationMeta,
  parsePaginationParams,
} from './lib/pagination.js'
import {
  attestationsPathParamsSchema,
  createAttestationBodySchema,
} from './schemas/index.js'
import { compressionMiddleware, compressionMetricsMiddleware } from './middleware/compression.js'
import { metricsMiddleware, register } from './middleware/metrics.js'

const app = express()

let rateLimitConfig: { enabled: boolean; windowSec: number; maxFree: number; maxPro: number; maxEnterprise: number; failOpen: boolean }
try {
  rateLimitConfig = validateConfig(process.env).rateLimit
} catch {
  rateLimitConfig = {
    enabled: true,
    windowSec: 60,
    maxFree: 100,
    maxPro: 1000,
    maxEnterprise: 10000,
    failOpen: true,
  }
}

const rateLimitMiddleware = createRateLimitMiddleware(rateLimitConfig)

app.use(requestIdMiddleware)

app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType)
  res.end(await register.metrics())
})

app.use(metricsMiddleware)
app.use(compressionMetricsMiddleware)
app.use(compressionMiddleware)
app.use(express.json())

app.use('/.well-known/jwks.json', createJwksRouter())

const healthProbes = createDefaultProbes()
app.use('/api/health', createHealthRouter(healthProbes))

app.use('/api', rateLimitMiddleware)

app.use('/api/trust', trustRouter)

const bondService = new BondService(new BondStore())
app.use('/api/bond', createBondRouter(bondService))

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

app.use('/api/bulk', bulkRouter)

app.use('/api/imports', importsRouter)

app.use('/api/admin', createAdminRouter())
app.use('/api/admin/webhooks', createWebhookAdminRouter())
app.use('/api/admin/rate-limit', createRateLimitAdminRouter())

app.use('/api/orgs/:orgId/policies', createPolicyRouter())

const analyticsThresholdSeconds = Number(process.env.ANALYTICS_STALENESS_SECONDS ?? '300')
const analyticsService = process.env.DATABASE_URL
  ? new AnalyticsService(pool, analyticsThresholdSeconds)
  : undefined
app.use('/api/analytics', createAnalyticsRouter(analyticsService))

app.use('/api/payouts', createPayoutsRouter())

app.use(errorHandler)

export default app
