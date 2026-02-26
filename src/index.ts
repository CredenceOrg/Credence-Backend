import express from 'express'
import { createHealthRouter } from './routes/health.js'
import { createDefaultProbes } from './services/health/probes.js'
import bulkRouter from './routes/bulk.js'
import { createAdminRouter } from './routes/admin/index.js'
import app from './app.js'

const PORT = process.env.PORT ?? 3000

app.use(express.json())

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

// Bulk verification endpoint (Enterprise)
app.use('/api/bulk', bulkRouter)

// Admin API endpoints (requires admin role)
app.use('/api/admin', createAdminRouter())

// Only start server if not in test environment
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`Credence API listening on http://localhost:${PORT}`)
  })
}

export { app }
export default app
