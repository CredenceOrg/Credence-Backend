import express, { type RequestHandler } from 'express'
import { createHealthRouter } from './routes/health.js'
import bulkRouter from './routes/bulk.js'
import { createDocsRouter } from './routes/docs.js'
import { createGovernanceRouter } from './routes/governance.js'
import { createDefaultProbes } from './services/health/probes.js'

/**
 * Optional app-level configuration for middleware injection.
 */
export interface AppOptions {
  preRouteMiddlewares?: RequestHandler[]
}

/**
 * Builds configured express application with all API routes.
 */
export function createApp(options: AppOptions = {}) {
  const app = express()
  app.use(express.json())

  for (const middleware of options.preRouteMiddlewares ?? []) {
    app.use(middleware)
  }

  const healthProbes = createDefaultProbes()
  app.use('/api/health', createHealthRouter(healthProbes))

  app.get('/api/trust/:address', (req, res) => {
    const { address } = req.params
    // Placeholder: in production, fetch from DB / reputation engine
    res.json({
      address,
      score: 0,
      bondedAmount: '0',
      bondStart: null,
      attestationCount: 0,
    })
  })

  app.get('/api/bond/:address', (req, res) => {
    const { address } = req.params
    res.json({
      address,
      bondedAmount: '0',
      bondStart: null,
      bondDuration: null,
      active: false,
    })
  })

  app.use('/api/bulk', bulkRouter)
  app.use('/api/governance', createGovernanceRouter())
  app.use('/api-docs', createDocsRouter())

  return app
}

const app = createApp()
export default app
