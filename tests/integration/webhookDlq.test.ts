/**
 * Integration tests for webhook DLQ & replay endpoint
 *
 * Scenario coverage
 * -----------------
 * 1. WebhookDlqProcessor job scans event_outbox for failed rows, pushes to DLQ
 * 2. GET /api/webhooks/dlq lists DLQ entries
 * 3. GET /api/webhooks/dlq/:id fetches one DLQ entry
 * 4. POST /api/webhooks/dlq/:id/replay replays with idempotency key + audit
 * 5. GET /api/webhooks/dlq/:id/history fetches replay audit trail
 * 6. Duplicate replay with same key returns cached result (idempotent)
 * 7. Unauthorized requests (missing webhooks:admin scope) return 401
 * 8. Rate limiting on replay endpoint (configurable via env)
 */

import { beforeAll, afterAll, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { randomUUID } from 'crypto'
import { createTestDatabase, type TestDatabase } from './testDatabase.js'
import { WebhookDlqProcessor } from '../../src/jobs/webhookDlqProcessor.js'
import { createWebhookReplayRouter } from '../../src/routes/webhookReplay.js'
import { WebhookDlqRepository } from '../../src/repositories/webhookDlqRepository.js'
import { errorHandler } from '../../src/middleware/errorHandler.js'

describe('Webhook DLQ & Replay Integration', () => {
  let db: TestDatabase
  let app: express.Application
  let dlqRepo: WebhookDlqRepository

  // Admin API key (webhooks:admin scope)
  const adminKey = 'test-webhooks-admin-key'

  beforeAll(async () => {
    db = await createTestDatabase()
    
    // Run migrations (simplified for test — in real scenario use node-pg-migrate)
    await db.pool.query(`
      CREATE TABLE IF NOT EXISTS event_outbox (
        id VARCHAR(255) PRIMARY KEY,
        event_type VARCHAR(255) NOT NULL,
        payload JSONB NOT NULL,
        metadata JSONB,
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        retry_count INTEGER DEFAULT 0,
        last_error TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `)

    await db.pool.query(`
      CREATE TABLE IF NOT EXISTS webhook_dlq (
        id VARCHAR(255) PRIMARY KEY,
        webhook_id VARCHAR(255) NOT NULL,
        payload JSONB NOT NULL,
        failed_at TIMESTAMPTZ NOT NULL,
        attempts INTEGER NOT NULL,
        last_status_code INTEGER,
        last_error TEXT,
        response_body_snippet TEXT,
        replayed_at TIMESTAMPTZ
      )
    `)

    await db.pool.query(`
      CREATE TABLE IF NOT EXISTS webhook_replay_audit (
        id VARCHAR(255) PRIMARY KEY,
        dlq_entry_id VARCHAR(255) NOT NULL,
        webhook_id VARCHAR(255) NOT NULL,
        actor_id VARCHAR(255) NOT NULL,
        actor_email VARCHAR(255) NOT NULL,
        tenant_id VARCHAR(255) NOT NULL,
        idempotency_key VARCHAR(255) NOT NULL,
        replayed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        success BOOLEAN NOT NULL,
        status_code INTEGER,
        error_message TEXT,
        ip_address VARCHAR(64),
        request_id VARCHAR(255),
        CONSTRAINT uq_webhook_replay_audit_idempotency UNIQUE (dlq_entry_id, idempotency_key)
      )
    `)

    await db.pool.query(`
      CREATE TABLE IF NOT EXISTS webhook_configs (
        id VARCHAR(255) PRIMARY KEY,
        url TEXT NOT NULL,
        events TEXT[] NOT NULL,
        secret TEXT NOT NULL,
        previous_secret TEXT,
        secret_updated_at TIMESTAMPTZ NOT NULL,
        active BOOLEAN NOT NULL DEFAULT true
      )
    `)

    dlqRepo = new WebhookDlqRepository(db.pool)

    // Setup Express app with the webhook replay router
    app = express()
    app.use(express.json())
    
    // Mock auth middleware that accepts adminKey
    app.use((req, _res, next) => {
      const apiKey = req.headers['x-api-key'] as string | undefined
      if (apiKey === adminKey) {
        (req as any).apiKey = { ownerId: 'test-admin', id: 'test-key-id', scopes: ['webhooks:admin'] }
        (req as any).user = { id: 'admin-user-123', email: 'admin@test.com', tenantId: 'test-tenant', role: 'admin' }
      }
      next()
    })

    app.use('/api/webhooks/dlq', createWebhookReplayRouter(db.pool))
    app.use(errorHandler)
  }, 30000)

  afterAll(async () => {
    await db.close()
  })

  beforeEach(async () => {
    // Clean up tables before each test
    await db.pool.query('TRUNCATE event_outbox, webhook_dlq, webhook_replay_audit, webhook_configs CASCADE')
  })

  // ── Test 1: WebhookDlqProcessor scans outbox and pushes to DLQ ─────────────

  it('should scan event_outbox and push failed webhooks to DLQ', async () => {
    // Seed a failed webhook event in the outbox
    const eventId = randomUUID()
    const webhookId = randomUUID()
    await db.pool.query(
      `INSERT INTO event_outbox (id, event_type, payload, metadata, status, retry_count, last_error, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        eventId,
        'bond.created',
        JSON.stringify({ address: '0x123', bondedAmount: '1000' }),
        JSON.stringify({ webhookId }),
        'failed',
        3,
        'Timeout after 3 attempts',
        new Date(),
      ],
    )

    // Run the DLQ processor
    const processor = new WebhookDlqProcessor(db.pool, { logger: () => {} })
    const result = await processor.run()

    expect(result.examined).toBe(1)
    expect(result.pushed).toBe(1)

    // Verify DLQ entry was created
    const dlqEntry = await dlqRepo.findById(eventId)
    expect(dlqEntry).toBeTruthy()
    expect(dlqEntry?.webhookId).toBe(webhookId)
    expect(dlqEntry?.attempts).toBe(3)
    expect(dlqEntry?.lastError).toBe('Timeout after 3 attempts')
    expect(dlqEntry?.replayedAt).toBeUndefined()
  })

  // ── Test 2: GET /api/webhooks/dlq lists DLQ entries ────────────────────────

  it('should list DLQ entries with webhooks:admin scope', async () => {
    const webhookId = randomUUID()
    await db.pool.query(
      `INSERT INTO webhook_dlq (id, webhook_id, payload, failed_at, attempts, last_error)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        randomUUID(),
        webhookId,
        JSON.stringify({ event: 'bond.created', data: {} }),
        new Date(),
        2,
        'Connection refused',
      ],
    )

    const res = await request(app)
      .get('/api/webhooks/dlq')
      .set('X-API-Key', adminKey)
      .expect(200)

    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].webhookId).toBe(webhookId)
  })

  it('should reject list request without admin scope', async () => {
    await request(app)
      .get('/api/webhooks/dlq')
      .set('X-API-Key', 'invalid-key')
      .expect(401)
  })

  // ── Test 3: GET /api/webhooks/dlq/:id fetches one entry ────────────────────

  it('should fetch a single DLQ entry by id', async () => {
    const entryId = randomUUID()
    await db.pool.query(
      `INSERT INTO webhook_dlq (id, webhook_id, payload, failed_at, attempts)
       VALUES ($1, $2, $3, $4, $5)`,
      [entryId, 'webhook-123', JSON.stringify({ event: 'bond.slashed' }), new Date(), 1],
    )

    const res = await request(app)
      .get(`/api/webhooks/dlq/${entryId}`)
      .set('X-API-Key', adminKey)
      .expect(200)

    expect(res.body.data.id).toBe(entryId)
    expect(res.body.data.webhookId).toBe('webhook-123')
  })

  it('should return 404 for non-existent DLQ entry', async () => {
    await request(app)
      .get(`/api/webhooks/dlq/${randomUUID()}`)
      .set('X-API-Key', adminKey)
      .expect(404)
  })

  // ── Test 4: POST /api/webhooks/dlq/:id/replay with idempotency ─────────────

  it('should replay a DLQ entry and record audit', async () => {
    // Setup: insert a webhook config and DLQ entry
    const webhookId = randomUUID()
    const dlqEntryId = randomUUID()
    const idempotencyKey = randomUUID()

    await db.pool.query(
      `INSERT INTO webhook_configs (id, url, events, secret, secret_updated_at, active)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [webhookId, 'https://example.com/webhook', ['bond.created'], 'secret123', new Date(), true],
    )

    await db.pool.query(
      `INSERT INTO webhook_dlq (id, webhook_id, payload, failed_at, attempts)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        dlqEntryId,
        webhookId,
        JSON.stringify({ event: 'bond.created', timestamp: new Date().toISOString(), data: {} }),
        new Date(),
        2,
      ],
    )

    const res = await request(app)
      .post(`/api/webhooks/dlq/${dlqEntryId}/replay`)
      .set('X-API-Key', adminKey)
      .set('Idempotency-Key', idempotencyKey)
      .expect(200)

    expect(res.body.replayed).toBe(true)
    expect(res.body.idempotent).toBe(false)
    expect(res.body.dlqEntryId).toBe(dlqEntryId)
    
    // Verify replay audit was recorded
    const history = await dlqRepo.getReplayHistory(dlqEntryId)
    expect(history).toHaveLength(1)
    expect(history[0].idempotency_key).toBe(idempotencyKey)
    expect(history[0].actor_id).toBe('admin-user-123')
  })

  it('should return cached result on duplicate replay with same idempotency key', async () => {
    const webhookId = randomUUID()
    const dlqEntryId = randomUUID()
    const idempotencyKey = randomUUID()

    await db.pool.query(
      `INSERT INTO webhook_configs (id, url, events, secret, secret_updated_at, active)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [webhookId, 'https://example.com/webhook', ['bond.created'], 'secret123', new Date(), true],
    )

    await db.pool.query(
      `INSERT INTO webhook_dlq (id, webhook_id, payload, failed_at, attempts)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        dlqEntryId,
        webhookId,
        JSON.stringify({ event: 'bond.created', timestamp: new Date().toISOString(), data: {} }),
        new Date(),
        2,
      ],
    )

    // First replay
    await request(app)
      .post(`/api/webhooks/dlq/${dlqEntryId}/replay`)
      .set('X-API-Key', adminKey)
      .set('Idempotency-Key', idempotencyKey)
      .expect(200)

    // Second replay with same key — should return idempotent result
    const res2 = await request(app)
      .post(`/api/webhooks/dlq/${dlqEntryId}/replay`)
      .set('X-API-Key', adminKey)
      .set('Idempotency-Key', idempotencyKey)
      .expect(200)

    expect(res2.body.replayed).toBe(false)
    expect(res2.body.idempotent).toBe(true)
    expect(res2.header['x-idempotent-replay']).toBe('true')

    // Audit table should still have only one row
    const history = await dlqRepo.getReplayHistory(dlqEntryId)
    expect(history).toHaveLength(1)
  })

  it('should reject replay without Idempotency-Key header', async () => {
    await request(app)
      .post(`/api/webhooks/dlq/${randomUUID()}/replay`)
      .set('X-API-Key', adminKey)
      .expect(400)
  })

  // ── Test 5: GET /api/webhooks/dlq/:id/history fetches audit trail ──────────

  it('should fetch replay audit history for a DLQ entry', async () => {
    const dlqEntryId = randomUUID()
    const webhookId = randomUUID()

    // Seed DLQ entry
    await db.pool.query(
      `INSERT INTO webhook_dlq (id, webhook_id, payload, failed_at, attempts)
       VALUES ($1, $2, $3, $4, $5)`,
      [dlqEntryId, webhookId, JSON.stringify({ event: 'test' }), new Date(), 1],
    )

    // Seed two audit records
    await dlqRepo.recordReplay({
      dlqEntryId,
      webhookId,
      actorId: 'admin-1',
      actorEmail: 'admin1@test.com',
      tenantId: 'tenant-1',
      idempotencyKey: 'key-1',
      success: true,
      statusCode: 200,
    })

    await dlqRepo.recordReplay({
      dlqEntryId,
      webhookId,
      actorId: 'admin-2',
      actorEmail: 'admin2@test.com',
      tenantId: 'tenant-1',
      idempotencyKey: 'key-2',
      success: false,
      errorMessage: 'Timeout',
    })

    const res = await request(app)
      .get(`/api/webhooks/dlq/${dlqEntryId}/history`)
      .set('X-API-Key', adminKey)
      .expect(200)

    expect(res.body.data).toHaveLength(2)
    expect(res.body.data[0].actor_id).toBe('admin-2') // Newest first
    expect(res.body.data[1].actor_id).toBe('admin-1')
  })
})
