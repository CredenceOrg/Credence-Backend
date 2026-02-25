import express, { type RequestHandler } from 'express'
import { loadConfig } from './config/index.js'
import { cache } from './cache/redis.js'
import { createHealthRouter } from './routes/health.js'
import { createBondRouter } from './routes/bond.js'
import bulkRouter from './routes/bulk.js'
import { createDocsRouter } from './routes/docs.js'
import { createGovernanceRouter } from './routes/governance.js'
import { createDefaultProbes } from './services/health/probes.js'
import { BondStore, BondService } from './services/bond/index.js'
import { validate } from './middleware/validate.js'
import { requireApiKey } from './middleware/apiKey.js'
import {
  generateApiKey,
  revokeApiKey,
  rotateApiKey,
  listApiKeys,
} from './services/apiKeys.js'
import {
  createSlashRequest,
  submitVote,
  getSlashRequest,
  listSlashRequests,
  type SlashRequestStatus,
  type VoteChoice,
} from './services/governance/slashingVotes.js'
import {
  trustPathParamsSchema,
  bondPathParamsSchema,
  attestationsPathParamsSchema,
  attestationsQuerySchema,
  createAttestationBodySchema,
} from './schemas/index.js'

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

  // ── Health ────────────────────────────────────────────────────────────────────
  const healthProbes = createDefaultProbes()
  app.use('/api/health', createHealthRouter(healthProbes))

  app.get('/api/health/cache', async (_req, res) => {
    const cacheHealth = await cache.healthCheck()
    res.json({
      status: 'ok',
      service: 'credence-backend',
      cache: cacheHealth,
    })
  })

  // ── Trust & Bond ─────────────────────────────────────────────────────────────
  /** Public: trust score by address (path validation) */
  app.get(
    '/api/trust/:address',
    validate({ params: trustPathParamsSchema }),
    (req, res) => {
      const { address } = req.validated!.params!
      // Placeholder: in production, fetch from DB / reputation engine
      res.json({
        address,
        score: 0,
        bondedAmount: '0',
        bondStart: null,
        attestationCount: 0,
      })
    },
  )

  /** Protected: trust score by address with API key */
  app.get(
    '/api/trust/:address/secure',
    requireApiKey(),
    validate({ params: trustPathParamsSchema }),
    (req, res) => {
      const { address } = req.validated!.params!
      res.json({
        address,
        score: 0,
        bondedAmount: '0',
        bondStart: null,
        attestationCount: 0,
        _accessedWith: { scope: req.apiKey?.scope, tier: req.apiKey?.tier },
      })
    },
  )

  const bondStore = new BondStore()
  const bondService = new BondService(bondStore)
  app.use('/api/bond', createBondRouter(bondService))

  // ── Attestations ─────────────────────────────────────────────────────────────
  /** Public: list attestations for address (path + query validation) */
  app.get(
    '/api/attestations/:address',
    validate({
      params: attestationsPathParamsSchema,
      query: attestationsQuerySchema,
    }),
    (req, res) => {
      const { address } = req.validated!.params!
      const { limit, offset } = req.validated!.query!
      res.json({
        address,
        limit,
        offset,
        attestations: [],
      })
    },
  )

  /** Public: Create attestation (body validation) */
  app.post(
    '/api/attestations',
    validate({ body: createAttestationBodySchema }),
    (req, res) => {
      const body = req.validated!.body!
      res.status(201).json({
        subject: body.subject,
        value: body.value,
        key: body.key ?? null,
      })
    },
  )

  app.get('/api/verification/:address', (req, res) => {
    const { address } = req.params
    res.json({
      address,
      proof: null,
      verified: false,
      timestamp: null,
    })
  })

  // ── API Key Management ────────────────────────────────────────────────────────
  /** POST /api/keys — issue a new API key */
  app.post('/api/keys', (req, res) => {
    const { ownerId, scope, tier } = req.body as {
      ownerId?: string
      scope?: string
      tier?: string
    }

    if (!ownerId) {
      res.status(400).json({ error: 'ownerId is required' })
      return
    }

    const validScopes = ['read', 'full']
    const validTiers = ['free', 'pro', 'enterprise']

    if (scope && !validScopes.includes(scope)) {
      res.status(400).json({
        error: `scope must be one of: ${validScopes.join(', ')}`,
      })
      return
    }
    if (tier && !validTiers.includes(tier)) {
      res.status(400).json({
        error: `tier must be one of: ${validTiers.join(', ')}`,
      })
      return
    }

    const result = generateApiKey(
      ownerId,
      (scope as 'read' | 'full') ?? 'read',
      (tier as 'free' | 'pro' | 'enterprise') ?? 'free',
    )

    res.status(201).json(result)
  })

  /** GET /api/keys?ownerId=<id> — list keys for an owner */
  app.get('/api/keys', (req, res) => {
    const { ownerId } = req.query as { ownerId?: string }
    if (!ownerId) {
      res.status(400).json({ error: 'ownerId query parameter is required' })
      return
    }
    res.json(listApiKeys(ownerId))
  })

  /** DELETE /api/keys/:id — revoke a key */
  app.delete('/api/keys/:id', (req, res) => {
    const revoked = revokeApiKey(req.params['id'])
    if (!revoked) {
      res.status(404).json({ error: 'Key not found' })
      return
    }
    res.status(204).send()
  })

  /** POST /api/keys/:id/rotate — rotate a key */
  app.post('/api/keys/:id/rotate', (req, res) => {
    const result = rotateApiKey(req.params['id'])
    if (!result) {
      res.status(404).json({ error: 'Key not found or already revoked' })
      return
    }
    res.json(result)
  })

  // ── Governance ──────────────────────────────────────────────────────────────
  app.get('/api/governance/slash-requests', (req, res) => {
    const { status } = req.query as { status?: string }
    const validStatuses: SlashRequestStatus[] = ['pending', 'approved', 'rejected']
    if (status && !validStatuses.includes(status as SlashRequestStatus)) {
      res.status(400).json({
        error: `status must be one of: ${validStatuses.join(', ')}`,
      })
      return
    }
    res.json(listSlashRequests(status as SlashRequestStatus | undefined))
  })

  app.get('/api/governance/slash-requests/:id', (req, res) => {
    const request = getSlashRequest(req.params['id'])
    if (!request) {
      res.status(404).json({ error: 'Slash request not found' })
      return
    }
    res.json(request)
  })

  app.post('/api/governance/slash-requests', (req, res) => {
    const { targetAddress, reason, requestedBy, threshold, totalSigners } =
      req.body as {
        targetAddress?: string
        reason?: string
        requestedBy?: string
        threshold?: number
        totalSigners?: number
      }

    if (!targetAddress) {
      res.status(400).json({ error: 'targetAddress is required' })
      return
    }
    if (!reason) {
      res.status(400).json({ error: 'reason is required' })
      return
    }
    if (!requestedBy) {
      res.status(400).json({ error: 'requestedBy is required' })
      return
    }

    try {
      const request = createSlashRequest({
        targetAddress,
        reason,
        requestedBy,
        threshold,
        totalSigners,
      })
      res.status(201).json(request)
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  app.post('/api/governance/slash-requests/:id/votes', (req, res) => {
    const { voterId, choice } = req.body as { voterId?: string; choice?: string }

    if (!voterId) {
      res.status(400).json({ error: 'voterId is required' })
      return
    }
    if (!choice) {
      res.status(400).json({ error: 'choice is required' })
      return
    }

    const validChoices: VoteChoice[] = ['approve', 'reject']
    if (!validChoices.includes(choice as VoteChoice)) {
      res.status(400).json({
        error: `choice must be one of: ${validChoices.join(', ')}`,
      })
      return
    }

    try {
      const result = submitVote(req.params['id'], voterId, choice as VoteChoice)
      if (!result) {
        res.status(404).json({ error: 'Slash request not found' })
        return
      }
      res.status(201).json(result)
    } catch (err) {
      res.status(409).json({ error: (err as Error).message })
    }
  })

  app.use('/api/governance', createGovernanceRouter())

  // ── Other ────────────────────────────────────────────────────────────────────
  app.use('/api/bulk', bulkRouter)
  app.use('/api-docs', createDocsRouter())

  return app
}

const config = loadConfig()
const app = createApp()

if (process.env.NODE_ENV !== 'test') {
  app.listen(config.port, () => {
    console.log(`Credence API listening on http://localhost:${config.port}`)
  })
}

export default app
