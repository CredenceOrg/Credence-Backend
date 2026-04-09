import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { newDb, type IMemoryDb } from 'pg-mem';
import { Pool } from 'pg';
import { PostgresWebhookRepository } from '../../../db/repositories/webhookRepository.js';
import { WebhookService } from '../service.js';
import { deliverWebhook, signPayload } from '../delivery.js';
import type { WebhookConfig, WebhookPayload } from '../types.js';

// Helper to build test DB with pg-mem
async function buildTestDb(): Promise<{ db: IMemoryDb; pool: Pool }> {
  const db = newDb();
  db.public.none(`
    CREATE TABLE webhook_configs (
      id                 UUID          PRIMARY KEY,
      url                TEXT          NOT NULL,
      secret             TEXT          NOT NULL,
      previous_secret    TEXT,
      secret_updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      active             BOOLEAN       NOT NULL DEFAULT TRUE,
      events             TEXT[]        NOT NULL,
      created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    );
  `);
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool() as unknown as Pool;
  return { db, pool };
}

describe('Webhook Rotation', () => {
  let pool: Pool;
  let repo: PostgresWebhookRepository;
  let service: WebhookService;

  beforeAll(async () => {
    const built = await buildTestDb();
    pool = built.pool;
    repo = new PostgresWebhookRepository(pool);
    service = new WebhookService(repo);
  }, 10000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rotates secret and keeps previous secret', async () => {
    const webhookId = crypto.randomUUID();
    const initialConfig: WebhookConfig = {
      id: webhookId,
      url: 'https://example.com/wh',
      secret: 'secret-1',
      secretUpdatedAt: new Date(),
      active: true,
      events: ['bond.created'],
    };

    await repo.set(initialConfig);

    // Rotate
    const rotated = await service.rotateSecret(webhookId);
    expect(rotated.previousSecret).toBe('secret-1');
    expect(rotated.secret).not.toBe('secret-1');
    expect(rotated.secret.length).toBe(64);

    // Verify in DB
    const dbConfig = await repo.get(webhookId);
    expect(dbConfig?.previousSecret).toBe('secret-1');
  });

  it('sends dual signatures during 24h grace period', async () => {
    vi.useFakeTimers();
    const now = new Date('2024-01-01T12:00:00Z');
    vi.setSystemTime(now);

    const webhook: WebhookConfig = {
      id: crypto.randomUUID(),
      url: 'https://example.com/wh',
      secret: 'new-secret',
      previousSecret: 'old-secret',
      secretUpdatedAt: now,
      active: true,
      events: ['bond.created'],
    };

    const payload: WebhookPayload = {
      event: 'bond.created',
      timestamp: now.toISOString(),
      data: { address: '0x123', bondedAmount: '100', bondStart: null, bondDuration: null, active: true },
    };

    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    // 1. Within grace period (23 hours later)
    vi.setSystemTime(new Date(now.getTime() + 23 * 60 * 60 * 1000));
    await deliverWebhook(webhook, payload);

    let call = (fetch as any).mock.calls[0];
    let sigHeader = call[1].headers['X-Webhook-Signature'];
    expect(sigHeader.split(',')).toHaveLength(2);
    expect(sigHeader).toContain(signPayload(JSON.stringify(payload), 'new-secret'));
    expect(sigHeader).toContain(signPayload(JSON.stringify(payload), 'old-secret'));

    // 2. Outside grace period (25 hours later)
    vi.setSystemTime(new Date(now.getTime() + 25 * 60 * 60 * 1000));
    await deliverWebhook(webhook, payload);

    call = (fetch as any).mock.calls[1];
    sigHeader = call[1].headers['X-Webhook-Signature'];
    expect(sigHeader.split(',')).toHaveLength(1);
    expect(sigHeader).toBe(signPayload(JSON.stringify(payload), 'new-secret'));
    
    vi.useRealTimers();
  });

  it('stops sending dual signatures after revocation', async () => {
    const webhookId = crypto.randomUUID();
    const webhook: WebhookConfig = {
      id: webhookId,
      url: 'https://example.com/wh',
      secret: 'secret-current',
      previousSecret: 'secret-previous',
      secretUpdatedAt: new Date(),
      active: true,
      events: ['bond.created'],
    };
    await repo.set(webhook);

    // Revoke
    await service.revokePreviousSecret(webhookId);
    const updated = await repo.get(webhookId);
    expect(updated?.previousSecret).toBeUndefined();

    // Verify delivery sends only one
    const payload: WebhookPayload = {
      event: 'bond.created',
      timestamp: new Date().toISOString(),
      data: { address: '0x123', bondedAmount: '100', bondStart: null, bondDuration: null, active: true },
    };
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await deliverWebhook(updated!, payload);

    const call = (fetch as any).mock.calls[0];
    expect(call[1].headers['X-Webhook-Signature'].split(',')).toHaveLength(1);
  });
});
