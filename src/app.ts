import express from 'express'
import { createHealthRouter } from './routes/health.js'
import { createDefaultProbes } from './services/health/probes.js'
import trustRouter from './routes/trust.js'
import bulkRouter from './routes/bulk.js'
import identityRouter from './routes/identities.js' // Added import for Issue #128
import { createAdminRouter } from './routes/admin/index.js'
import { validate } from './middleware/validate.js'
import {
  bondPathParamsSchema,
  attestationsPathParamsSchema,
  attestationsQuerySchema,
  createAttestationBodySchema,
} from './schemas/index.js'

const app = express()

app.use(express.json())

// Health – full readiness check with per-dependency status
const healthProbes = createDefaultProbes()
app.use('/api/health', createHealthRouter(healthProbes))

// Trust score
app.use('/api/trust', trustRouter)

// Identities & Profiles – Handles Optimistic Locking (Issue #128)
app.use('/api/identities', identityRouter) 

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
  validate({ params: attestationsPathParamsSchema, query: attestationsQuerySchema }),
  (req, res) => {
    const { address } = req.validated!.params! as { address: string }
    const { limit, offset } = req.validated!.query! as { limit: number; offset: number }
    res.json({ address, limit, offset, attestations: [] })
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

// Admin API
app.use('/api/admin', createAdminRouter())

export default app