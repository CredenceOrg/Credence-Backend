import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import express, { type Express } from 'express';
import { newDb, type IMemoryDb } from 'pg-mem';
import { Pool } from 'pg';
import { IdempotencyRepository } from '../../db/repositories/idempotencyRepository.js';
import { idempotencyMiddleware, computeBoundKeyHash } from '../idempotency.js';
import { ErrorCode } from '../../lib/errors.js';

// Helper to simulate request without supertest
async function request(
  app: Express,
  method: 'GET' | 'POST',
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('Could not get server address'));
        return;
      }

      const url = `http://127.0.0.1:${addr.port}${path}`;
      const opts: RequestInit = {
        method,
        headers: { 
          'Content-Type': 'application/json',
          ...headers 
        },
      };
      if (body !== undefined) opts.body = JSON.stringify(body);

      fetch(url, opts)
        .then(async (res) => {
          const json = await res.json();
          server.close();
          resolve({ status: res.status, body: json });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

/**
 * Builds an in-memory database for testing using pg-mem.
 */
async function buildTestDb(): Promise<{ db: IMemoryDb; pool: Pool }> {
  const db = newDb();
  
  // Create the idempotency_keys table with actor_id and ttl_seconds columns
  db.public.none(`
    CREATE TABLE idempotency_keys (
      key TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      response_code INTEGER NOT NULL,
      response_body JSONB NOT NULL,
      ttl_seconds INTEGER NOT NULL DEFAULT 86400,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool() as unknown as Pool;
  
  return { db, pool };
}

describe('Idempotency Middleware (In-Memory)', () => {
  let app: Express;
  let idempotencyRepo: IdempotencyRepository;
  let pool: Pool;
  
  const BASE = '/test-idempotency';

  beforeAll(async () => {
    const built = await buildTestDb();
    pool = built.pool;
    idempotencyRepo = new IdempotencyRepository(pool);
  });

  beforeEach(async () => {
    // Clear the table before each test
    await pool.query('DELETE FROM idempotency_keys');
    
    app = express();
    app.use(express.json());
    
    // A dummy operational route to test middleware
    let callCount = 0;
    app.post(BASE, idempotencyMiddleware(idempotencyRepo), (req: any, res) => {
      callCount++;
      res.status(201).json({ 
        success: true, 
        received: req.body,
        callCount,
        actorId: req.apiKey?.id ?? req.apiKeyRecord?.id ?? 'anonymous',
      });
    });
  });

  describe('basic functionality', () => {
    it('stores and replays a successful response', async () => {
      const headers = { 'idempotency-key': 'test-key-1' };
      const payload = { data: 'hello' };

      // First request
      const res1 = await request(app, 'POST', BASE, headers, payload);
      expect(res1.status).toBe(201);
      expect((res1.body as any).callCount).toBe(1);

      // Second request with same key
      const res2 = await request(app, 'POST', BASE, headers, payload);
      expect(res2.status).toBe(201);
      expect(res2.body).toEqual(res1.body);
      // Since it's replayed, callCount should STILL be 1 in the response
      expect((res2.body as any).callCount).toBe(1);
    });

    it('works without idempotency key (passes through)', async () => {
      const payload = { data: 'no-key' };
      
      const res1 = await request(app, 'POST', BASE, {}, payload);
      const res2 = await request(app, 'POST', BASE, {}, payload);
      
      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);
      expect((res1.body as any).callCount).toBe(1);
      expect((res2.body as any).callCount).toBe(2);
    });

    it('works with different keys for same payload', async () => {
      const payload = { data: 'shared' };

      const res1 = await request(app, 'POST', BASE, { 'idempotency-key': 'key-A' }, payload);
      const res2 = await request(app, 'POST', BASE, { 'idempotency-key': 'key-B' }, payload);

      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);
      expect((res1.body as any).callCount).toBe(1);
      expect((res2.body as any).callCount).toBe(2);
    });

    it('does not store responses for 5xx errors', async () => {
      const failingBase = '/test-failure';
      let failures = 0;
      
      app.post(failingBase, idempotencyMiddleware(idempotencyRepo), (req, res) => {
        failures++;
        res.status(500).json({ error: 'Server error', failures });
      });

      const headers = { 'idempotency-key': 'fail-key' };
      
      // First attempt (fails)
      const res1 = await request(app, 'POST', failingBase, headers, { data: 'x' });
      expect(res1.status).toBe(500);
      expect((res1.body as any).failures).toBe(1);

      // Second attempt (should NOT be replayed, so failures should increment)
      const res2 = await request(app, 'POST', failingBase, headers, { data: 'x' });
      expect(res2.status).toBe(500);
      expect((res2.body as any).failures).toBe(2);
    });

    it('allows a new request after key expiry', async () => {
      const headers = { 'idempotency-key': 'expiry-key' };
      const payload = { data: 'test' };

      // 1. Create a successful request
      await request(app, 'POST', BASE, headers, payload);

      // 2. Manually expire the key in the database
      await pool.query(
        'UPDATE idempotency_keys SET expires_at = NOW() - INTERVAL \'1 second\' WHERE key = $1',
        ['expiry-key']
      );

      // 3. Request again with same key/payload - should NOT be replayed (callCount should increment)
      const { status, body } = await request(app, 'POST', BASE, headers, payload);
      
      expect(status).toBe(201);
      expect((body as any).callCount).toBe(2);
    });
  });

  describe('replay protection - actor binding', () => {
    it('rejects same key from different actor (409 Conflict)', async () => {
      // First request with actor 'actor-A'
      const appWithActorA = express();
      appWithActorA.use(express.json());
      appWithActorA.use((req: any, _res, next) => {
        req.apiKey = { id: 'actor-A' };
        next();
      });
      appWithActorA.post(BASE, idempotencyMiddleware(idempotencyRepo), (req: any, res) => {
        res.status(201).json({ success: true, actorId: req.apiKey.id });
      });

      const res1 = await request(appWithActorA, 'POST', BASE, { 'idempotency-key': 'shared-key' }, { data: 'test' });
      expect(res1.status).toBe(201);
      expect((res1.body as any).actorId).toBe('actor-A');

      // Second request with same key but different actor 'actor-B'
      const appWithActorB = express();
      appWithActorB.use(express.json());
      appWithActorB.use((req: any, _res, next) => {
        req.apiKey = { id: 'actor-B' };
        next();
      });
      appWithActorB.post(BASE, idempotencyMiddleware(idempotencyRepo), (req: any, res) => {
        res.status(201).json({ success: true, actorId: req.apiKey.id });
      });

      const res2 = await request(appWithActorB, 'POST', BASE, { 'idempotency-key': 'shared-key' }, { data: 'test' });
      expect(res2.status).toBe(409);
      expect((res2.body as any).code).toBe(ErrorCode.IDEMPOTENCY_KEY_MISMATCH);
      expect((res2.body as any).error).toContain('already bound');
    });

    it('replays response for same actor with same payload', async () => {
      const appWithActor = express();
      appWithActor.use(express.json());
      appWithActor.use((req: any, _res, next) => {
        req.apiKey = { id: 'same-actor' };
        next();
      });
      
      let callCount = 0;
      appWithActor.post(BASE, idempotencyMiddleware(idempotencyRepo), (req: any, res) => {
        callCount++;
        res.status(201).json({ success: true, callCount, actorId: req.apiKey.id });
      });

      const headers = { 'idempotency-key': 'actor-key' };
      const payload = { data: 'same' };

      const res1 = await request(appWithActor, 'POST', BASE, headers, payload);
      const res2 = await request(appWithActor, 'POST', BASE, headers, payload);

      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);
      expect((res1.body as any).callCount).toBe(1);
      expect((res2.body as any).callCount).toBe(1); // Replayed, not called again
      expect(res2.body).toEqual(res1.body);
    });
  });

  describe('replay protection - payload binding', () => {
    it('rejects same key with different payload (409 Conflict)', async () => {
      const appWithActor = express();
      appWithActor.use(express.json());
      appWithActor.use((req: any, _res, next) => {
        req.apiKey = { id: 'fixed-actor' };
        next();
      });
      
      appWithActor.post(BASE, idempotencyMiddleware(idempotencyRepo), (req: any, res) => {
        res.status(201).json({ success: true, received: req.body });
      });

      const headers = { 'idempotency-key': 'payload-key' };

      // First request with payload A
      const res1 = await request(appWithActor, 'POST', BASE, headers, { data: 'payload-A' });
      expect(res1.status).toBe(201);

      // Second request with same key but different payload
      const res2 = await request(appWithActor, 'POST', BASE, headers, { data: 'payload-B' });
      expect(res2.status).toBe(409);
      expect((res2.body as any).code).toBe(ErrorCode.IDEMPOTENCY_KEY_MISMATCH);
    });

    it('accepts different keys with same payload from same actor', async () => {
      const appWithActor = express();
      appWithActor.use(express.json());
      appWithActor.use((req: any, _res, next) => {
        req.apiKey = { id: 'same-actor' };
        next();
      });
      
      let callCount = 0;
      appWithActor.post(BASE, idempotencyMiddleware(idempotencyRepo), (req: any, res) => {
        callCount++;
        res.status(201).json({ success: true, callCount });
      });

      const payload = { data: 'same-payload' };

      const res1 = await request(appWithActor, 'POST', BASE, { 'idempotency-key': 'key-X' }, payload);
      const res2 = await request(appWithActor, 'POST', BASE, { 'idempotency-key': 'key-Y' }, payload);

      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);
      expect((res1.body as any).callCount).toBe(1);
      expect((res2.body as any).callCount).toBe(2); // Different key, so executed again
    });
  });

  describe('anonymous actor handling', () => {
    it('treats requests without authentication as anonymous', async () => {
      const res1 = await request(app, 'POST', BASE, { 'idempotency-key': 'anon-key' }, { data: 'test' });
      expect(res1.status).toBe(201);
      expect((res1.body as any).actorId).toBe('anonymous');

      // Verify the key was stored with 'anonymous' actor
      const stored = await idempotencyRepo.findByKey('anon-key');
      expect(stored?.actorId).toBe('anonymous');
    });

    it('allows replay from anonymous with same payload', async () => {
      const headers = { 'idempotency-key': 'anon-replay-key' };
      const payload = { data: 'anon-data' };

      const res1 = await request(app, 'POST', BASE, headers, payload);
      const res2 = await request(app, 'POST', BASE, headers, payload);

      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);
      expect(res2.body).toEqual(res1.body);
    });
  });

  describe('edge cases', () => {
    it('handles empty body correctly', async () => {
      const headers = { 'idempotency-key': 'empty-body-key' };

      const res1 = await request(app, 'POST', BASE, headers, {});
      const res2 = await request(app, 'POST', BASE, headers, {});

      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);
      expect(res2.body).toEqual(res1.body);
    });

    it('handles concurrent identical writes (race condition)', async () => {
      const headers = { 'idempotency-key': 'concurrent-key' };
      const payload = { data: 'concurrent' };

      // Simulate two concurrent requests with same key and payload
      const [res1, res2] = await Promise.all([
        request(app, 'POST', BASE, headers, payload),
        request(app, 'POST', BASE, headers, payload),
      ]);

      // Both should succeed (one may be replayed, or both executed)
      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);
    });

    it('stores TTL correctly', async () => {
      const customApp = express();
      customApp.use(express.json());
      customApp.post(BASE, idempotencyMiddleware(idempotencyRepo, { expiresInSeconds: 3600 }), (req, res) => {
        res.status(201).json({ success: true });
      });

      await request(customApp, 'POST', BASE, { 'idempotency-key': 'ttl-key' }, { data: 'test' });

      const stored = await idempotencyRepo.findByKey('ttl-key');
      expect(stored?.ttlSeconds).toBe(3600);
    });
  });
});

describe('computeBoundKeyHash', () => {
  it('produces consistent hash for same actor and payload', () => {
    const hash1 = computeBoundKeyHash('actor-A', 'hash123');
    const hash2 = computeBoundKeyHash('actor-A', 'hash123');
    
    expect(hash1).toBe(hash2);
  });

  it('produces different hash for different actors', () => {
    const hash1 = computeBoundKeyHash('actor-A', 'hash123');
    const hash2 = computeBoundKeyHash('actor-B', 'hash123');
    
    expect(hash1).not.toBe(hash2);
  });

  it('produces different hash for different payloads', () => {
    const hash1 = computeBoundKeyHash('actor-A', 'hash123');
    const hash2 = computeBoundKeyHash('actor-A', 'hash456');
    
    expect(hash1).not.toBe(hash2);
  });

  it('produces 64-character hex string', () => {
    const hash = computeBoundKeyHash('actor', 'payload');
    
    expect(hash).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
  });
});
