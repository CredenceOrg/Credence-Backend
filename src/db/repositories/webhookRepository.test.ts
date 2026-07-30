import { describe, it, expect, beforeEach } from 'vitest'
import { newDb } from 'pg-mem'
import type { Pool } from 'pg'
import { PostgresWebhookRepository } from './webhookRepository.js'
import type { WebhookConfig } from '../../services/webhooks/types.js'

/**
 * Exercises PostgresWebhookRepository against a real (in-memory) Postgres so
 * that schema drift between this repository's SQL and the migrations that
 * actually create `webhook_configs` gets caught here instead of only at
 * runtime against a real database. This is the schema exactly as it exists
 * after migrations 005, 007, 009, and 032 have all run.
 */
async function buildTestDb(): Promise<Pool> {
  const db = newDb()

  db.public.registerFunction({
    name: 'gen_random_uuid',
    returns: 'uuid',
    implementation: () => crypto.randomUUID(),
  } as Parameters<typeof db.public.registerFunction>[0])

  const adapter = db.adapters.createPg()
  const pool = new adapter.Pool() as unknown as Pool

  await pool.query(`
    CREATE TABLE IF NOT EXISTS webhook_configs (
      id                          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
      url                         TEXT          NOT NULL,
      secret                      TEXT          NOT NULL,
      previous_secret             VARCHAR(255),
      previous_secret_expires_at  TIMESTAMPTZ,
      secret_updated_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      active                      BOOLEAN       NOT NULL DEFAULT TRUE,
      events                      TEXT[]        NOT NULL,
      timeout_ms                  INTEGER       NOT NULL DEFAULT 5000,
      max_attempts                INTEGER       NOT NULL DEFAULT 3,
      created_at                  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      updated_at                  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    );
  `)

  return pool
}

const SEED: WebhookConfig = {
  id: '',
  url: 'https://example.com/hook',
  events: ['bond.created'],
  secret: 'initial-secret',
  secretUpdatedAt: new Date(),
  active: true,
}

describe('PostgresWebhookRepository', () => {
  let pool: Pool
  let repo: PostgresWebhookRepository
  let webhookId: string

  beforeEach(async () => {
    pool = await buildTestDb()
    repo = new PostgresWebhookRepository(pool)
    webhookId = crypto.randomUUID()
    await repo.set({ ...SEED, id: webhookId })
  })

  it('rotateSecret() atomically swaps the secret and persists previousSecretExpiresAt', async () => {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

    const updated = await repo.rotateSecret(webhookId, 'brand-new-secret', 'initial-secret', expiresAt)

    expect(updated.secret).toBe('brand-new-secret')
    expect(updated.previousSecret).toBe('initial-secret')
    expect(updated.previousSecretExpiresAt).toBeTruthy()
    expect(new Date(updated.previousSecretExpiresAt!).toISOString()).toBe(new Date(expiresAt).toISOString())
  })

  it('rotateSecret() throws when the webhook does not exist', async () => {
    const nonExistentId = crypto.randomUUID()
    await expect(
      repo.rotateSecret(nonExistentId, 'new-secret', 'old-secret', new Date().toISOString()),
    ).rejects.toThrow('Webhook not found')
  })

  it('get() reflects the rotated secret and expiry after rotation', async () => {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    await repo.rotateSecret(webhookId, 'rotated-secret', 'initial-secret', expiresAt)

    const fetched = await repo.get(webhookId)

    expect(fetched).not.toBeNull()
    expect(fetched!.secret).toBe('rotated-secret')
    expect(fetched!.previousSecret).toBe('initial-secret')
    expect(fetched!.previousSecretExpiresAt).toBeTruthy()
  })

  it('a second rotation replaces previousSecret rather than accumulating history', async () => {
    const firstExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    await repo.rotateSecret(webhookId, 'second-secret', 'initial-secret', firstExpiry)

    const secondExpiry = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
    const updated = await repo.rotateSecret(webhookId, 'third-secret', 'second-secret', secondExpiry)

    expect(updated.secret).toBe('third-secret')
    expect(updated.previousSecret).toBe('second-secret')
  })
})
