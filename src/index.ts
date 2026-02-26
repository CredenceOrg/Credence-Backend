import express from 'express'
import { createHealthRouter } from './routes/health.js'
import { createDefaultProbes } from './services/health/probes.js'
import bulkRouter from './routes/bulk.js'
import { createAdminRouter } from './routes/admin/index.js'
import { ArbitrationLogService } from './services/governance/arbitrationLogs.js'
import { createGovernanceRouter } from './routes/governance.js'
import app from './app.js'

const PORT = process.env.PORT ?? 3000

app.use(express.json())

const healthProbes = createDefaultProbes()
app.use('/api/health', createHealthRouter(healthProbes))

// Bulk verification endpoint (Enterprise)
app.use('/api/bulk', bulkRouter)

// Admin API endpoints (requires admin role)
app.use('/api/admin', createAdminRouter())

// Governance: Arbitration Logs
const arbitrationLogService = new ArbitrationLogService()
app.use(
  '/api/governance/arbitration-logs',
  createGovernanceRouter(arbitrationLogService),
)

// Only start server if not in test environment
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`Credence API listening on http://localhost:${PORT}`)
  })
}

export { app }
export default app
