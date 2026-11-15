import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { newDb } from 'pg-mem'
import type { Pool } from 'pg'
import client from 'prom-client'

const testRegistry = vi.hoisted(() => ({ current: null as client.Registry | null }))
const loggerInfoSpy = vi.hoisted(() => vi.fn())

vi.mock('../tracing/tracer.js', () => ({ initTracing: vi.fn() }))
vi.mock('../app.js', () => ({ default: {} }))
vi.mock('../db/pool.js', () => ({ pool: {}, workerPool: {}, replicaPool: {} }))
vi.mock('../migrations/index.js', () => ({
  validateMigrationChecksums: vi.fn(),
  resolveMigrationsDir: vi.fn(),
}))
vi.mock('../cache/redis.js', () => ({ redisConnection: {} }))
vi.mock('../observability/shutdownMetrics.js', () => ({ createShutdownMetrics: vi.fn() }))
vi.mock('../services/analytics/service.js', () => ({ AnalyticsService: class {} }))
vi.mock('../jobs/analyticsRefreshWorker.js', () => ({ createAnalyticsRefreshWorker: vi.fn() }))
vi.mock('../jobs/analyticsRefreshScheduler.js', () => ({ AnalyticsRefreshScheduler: class {} }))
vi.mock('../jobs/analyticsRefreshMetrics.js', () => ({ createAnalyticsRefreshMetrics: vi.fn() }))
vi.mock('../jobs/settlementReconciler.js', () => ({ SettlementReconciler: class {} }))
vi.mock('../jobs/scheduler.js', () => ({ createScheduler: vi.fn() }))
vi.mock('../services/keyManager/index.js', () => ({ keyManager: {} }))
vi.mock('../lifecycle.js', () => ({ initializeAuth: vi.fn() }))
vi.mock('../jobs/keyRotationScheduler.js', () => ({ KeyRotationScheduler: class {} }))
vi.mock('../gracefulShutdown.js', () => ({ GracefulShutdownManager: class {} }))
vi.mock('../jobs/failedInboundEventsSweeper.js', () => ({ FailedInboundEventsSweeper: class {} }))
vi.mock('../jobs/pgStatActivitySnapshotJob.js', () => ({ PgStatActivitySnapshotJob: class {} }))
vi.mock('../jobs/longTransactionReaper.js', () => ({
  LongTransactionReaper: class {},
  loadLongTransactionReaperConfig: vi.fn(),
  registerLongTransactionReaperMetrics: vi.fn(),
}))
vi.mock('../config/retention.js', () => ({ loadFailedInboundSweeperConfig: vi.fn() }))
vi.mock('../cache/index.js', () => ({ getInvalidationBus: vi.fn() }))
vi.mock('../routes/ws.js', () => ({ createWsSubscriptionServer: vi.fn() }))
vi.mock('../services/impersonation/index.js', () => ({ impersonationService: {} }))
vi.mock('../middleware/metrics.js', async () => {
  const prom = await import('prom-client')
  const reg = new prom.default.Registry()
  testRegistry.current = reg
  return {
    recordOomEvent: vi.fn(),
    recordWebhookDlqSize: vi.fn(),
    register: reg,
  }
})
vi.mock('../observability/customMetrics.js', () => ({
  webhookPayloadBytes: { observe: vi.fn() },
}))
vi.mock('../clients/retryExecutor.js', () => ({
  resolveExtendedProviderRetryPolicy: (_provider: string, fallback: unknown) => fallback,
  executeWithRetry: async (_provider: string, fn: (signal: AbortSignal) => Promise<unknown>) =>
    fn(new AbortController().signal),
}))
vi.mock('../lib/ssrfProtection.js', () => ({
  checkHostBlocked: () => ({ blocked: false }),
  checkHostnameBlocked: () => ({ blocked: false }),
}))
vi.mock('../utils/logger.js', () => ({
  logger: {
    info: loggerInfoSpy,
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
  runWithCorrelationIds: <T>(_ids: unknown, fn: () => T) => fn(),
  sanitizeCorrelationId: (value: string | undefined | null) => value ?? undefined,
}))
vi.mock('../jobs/outbox.js', () => ({ OutboxJob: class {} }))
vi.mock('../jobs/requestSnapshotsSweeper.js', () => ({ RequestSnapshotsSweeper: class {} }))
vi.mock('../jobs/idempotencyKeySweeper.js', () => ({ IdempotencyKeySweeper: class {} }))
vi.mock('../jobs/expiredSessionsSweeper.js', () => ({ ExpiredSessionsSweeper: class {} }))

process.env.NODE_ENV = 'test'

import { createWebhookDlqProcessor } from '../index.js'

function createPassthroughPool(pool: Pool): Pool {
  return new Proxy(pool, {
    get(target, prop) {
      if (prop !== 'query') return (target as unknown as Record<string, unknown>)[prop as string]
      return (text: string, values?: unknown[]) =>
        (target as unknown as { query: (sql: string, params?: unknown[]) => Promise<unknown> }).query(text, values)
    },
  })
}

describe('createWebhookDlqProcessor (index.ts wiring)', () => {
  let rawPool: Pool
  let pool: Pool

  beforeAll(async () => {
    const db = newDb()
    const adapter = db.adapters.createPg()
    rawPool = new adapter.Pool() as unknown as Pool
    pool = createPassthroughPool(rawPool)

    await rawPool.query(`
      CREATE TABLE webhook_dlq (
        id VARCHAR(255) PRIMARY KEY,
        webhook_id VARCHAR(255) NOT NULL,
        payload JSONB NOT NULL,
        failed_at TIMESTAMPTZ NOT NULL,
        attempts INTEGER NOT NULL,
        last_status_code INTEGER,
        last_error TEXT,
        response_body_snippet TEXT,
        replayed_at TIMESTAMPTZ
      );
    `)

    await rawPool.query(`
      CREATE TABLE webhook_replay_audit (
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
      );
    `)

    await rawPool.query(`
      CREATE TABLE webhook_configs (
        id VARCHAR(255) PRIMARY KEY,
        url TEXT NOT NULL,
        events TEXT[] NOT NULL,
        secret TEXT NOT NULL,
        previous_secret TEXT,
        previous_secret_expires_at TIMESTAMPTZ,
        secret_updated_at TIMESTAMPTZ NOT NULL,
        active BOOLEAN NOT NULL DEFAULT true,
        max_attempts INTEGER,
        timeout_ms INTEGER,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `)
  })

  afterEach(async () => {
    loggerInfoSpy.mockClear()
    await rawPool.query('DELETE FROM webhook_replay_audit')
    await rawPool.query('DELETE FROM webhook_dlq')
    await rawPool.query('DELETE FROM webhook_configs')
  })

  it('returns a processor whose run() resolves against pg-mem without throwing and logs completion', async () => {
    const processor = createWebhookDlqProcessor(pool, {
      webhookDlq: { intervalMs: 60_000, batchSize: 200 },
    })

    const result = await processor.run()

    expect(result).toMatchObject({
      scannedCount: 0,
      eligibleCount: 0,
      replayedCount: 0,
      failedCount: 0,
      skippedCount: 0,
    })
    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.stringContaining('[WebhookDlqProcessor] Completed:'),
    )
  })

  it('replays a seeded DLQ entry against a real local HTTP receiver, sets replayed_at, and writes a system replay audit row', async () => {
    const receivedRequests: Array<{ method?: string; headers: http.IncomingHttpHeaders; body: string }> = []
    const receiver = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        receivedRequests.push({
          method: req.method,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
    })

    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', () => resolve()))

    try {
      const { port } = receiver.address() as AddressInfo

      await rawPool.query(
        `INSERT INTO webhook_configs (id, url, events, secret, secret_updated_at, active)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          'wh_wired_1',
          `http://127.0.0.1:${port}/webhook`,
          ['bond.created'],
          'test-hmac-secret',
          new Date('2026-01-01T00:00:00.000Z'),
          true,
        ],
      )

      const payload = {
        event: 'bond.created',
        timestamp: '2026-02-01T00:00:00.000Z',
        data: {
          address: 'GABC',
          bondedAmount: '100',
          bondStart: null,
          bondDuration: null,
          active: true,
        },
      }

      await rawPool.query(
        `INSERT INTO webhook_dlq (id, webhook_id, payload, failed_at, attempts, last_status_code, last_error)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          'dlq_wired_1',
          'wh_wired_1',
          JSON.stringify(payload),
          new Date(Date.now() - 5 * 60_000).toISOString(),
          4,
          503,
          'Service Unavailable',
        ],
      )

      const processor = createWebhookDlqProcessor(pool, {
        webhookDlq: { intervalMs: 60_000, batchSize: 50 },
      })

      const result = await processor.run()

      expect(result.replayedCount).toBe(1)
      expect(receivedRequests).toHaveLength(1)
      expect(receivedRequests[0].method).toBe('POST')
      expect(receivedRequests[0].headers['x-webhook-signature']).toBeTruthy()
      expect(JSON.parse(receivedRequests[0].body)).toEqual(payload)

      const dlqRows = await rawPool.query('SELECT replayed_at FROM webhook_dlq WHERE id = $1', ['dlq_wired_1'])
      expect(dlqRows.rows[0]?.replayed_at).toBeTruthy()

      const auditRows = await rawPool.query(
        'SELECT actor_id, actor_email, tenant_id, idempotency_key, success, status_code FROM webhook_replay_audit WHERE dlq_entry_id = $1',
        ['dlq_wired_1'],
      )
      expect(auditRows.rows).toHaveLength(1)
      expect(auditRows.rows[0]).toMatchObject({
        actor_id: 'system:dlq-processor',
        actor_email: 'system',
        tenant_id: 'system',
        idempotency_key: 'dlq_wired_1:attempt:1',
        success: true,
        status_code: 200,
      })
    } finally {
      await new Promise<void>((resolve, reject) =>
        receiver.close((err) => (err ? reject(err) : resolve())),
      )
    }
  })
})
