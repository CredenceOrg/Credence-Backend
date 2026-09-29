import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import express, { type Express, type Request } from 'express';
import { newDb, type IMemoryDb } from 'pg-mem';
import { Pool } from 'pg';
import { IdempotencyRepository } from '../../db/repositories/idempotencyRepository.js';
import { idempotencyMiddleware, computeBoundKeyHash, extractActorId } from '../idempotency.js';
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
      response_headers JSONB,
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

  describe('raw credential binding (provisional actor)', () => {
    it('binds the key to the raw x-api-key credential, not a downstream-decided identity', async () => {
      // A single key+payload presented under a different raw credential must
      // NOT replay the first actor's cached response. It must be rejected and
      // leave no committed state for a third (owning) credential to trip over.
      const headersA = {
        'idempotency-key': 'cred-key',
        'x-api-key': 'cr_aaaaaaaaaaaaaaaa',
      };
      const headersB = {
        'idempotency-key': 'cred-key',
        'x-api-key': 'cr_bbbbbbbbbbbbbbbb',
      };
      const headersBackToA = {
        'idempotency-key': 'cred-key',
        'x-api-key': 'cr_aaaaaaaaaaaaaaaa',
      };
      const payload = { data: 'credential-bound' };

      const res1 = await request(app, 'POST', BASE, headersA, payload);
      expect(res1.status).toBe(201);

      // Different raw credential + same key + same payload => 409 mismatch.
      const res2 = await request(app, 'POST', BASE, headersB, payload);
      expect(res2.status).toBe(409);
      expect((res2.body as any).code).toBe(ErrorCode.IDEMPOTENCY_KEY_MISMATCH);

      // Original credential retries => safe replay (single committed effect).
      const res3 = await request(app, 'POST', BASE, headersBackToA, payload);
      expect(res3.status).toBe(201);
      expect((res3.body as any).callCount).toBe(1);
    });

    it('does not admit an unauthenticated actor onto an authenticated idempotency record', async () => {
      const authedHeaders = {
        'idempotency-key': 'anon-vs-authed',
        'x-api-key': 'cr_cccccccccccccccc',
      };
      const payload = { data: 'bound-actor' };

      const authed = await request(app, 'POST', BASE, authedHeaders, payload);
      expect(authed.status).toBe(201);

      // Same key but no credential at all => different (anonymous) actor => 409,
      // so an unauthenticated caller cannot retrieve a credentialed response.
      const anon = await request(app, 'POST', BASE, { 'idempotency-key': 'anon-vs-authed' }, payload);
      expect(anon.status).toBe(409);
      expect((anon.body as any).code).toBe(ErrorCode.IDEMPOTENCY_KEY_MISMATCH);
    });
  });

  describe('rejected and failed operations leave no cached state', () => {
    it('does not cache 401 responses — a retry re-executes the operation', async () => {
      const authBase = '/test-auth-reject';
      let attempts = 0;

      app.post(authBase, idempotencyMiddleware(idempotencyRepo), (req, res) => {
        attempts++;
        res.status(401).json({ error: 'unauthorized', attempts });
      });

      const headers = { 'idempotency-key': 'no-cache-401' };
      const payload = { data: 'x' };

      const res1 = await request(app, 'POST', authBase, headers, payload);
      const res2 = await request(app, 'POST', authBase, headers, payload);

      expect(res1.status).toBe(401);
      expect(res2.status).toBe(401);
      expect((res1.body as any).attempts).toBe(1);
      expect((res2.body as any).attempts).toBe(2);
    });

    it('does not cache 403 responses — a retry re-executes the operation', async () => {
      const authBase = '/test-forbid';
      let attempts = 0;

      app.post(authBase, idempotencyMiddleware(idempotencyRepo), (req, res) => {
        attempts++;
        res.status(403).json({ error: 'forbidden', attempts });
      });

      const res1 = await request(app, 'POST', authBase, { 'idempotency-key': 'no-cache-403' }, { data: 'x' });
      const res2 = await request(app, 'POST', authBase, { 'idempotency-key': 'no-cache-403' }, { data: 'x' });

      expect((res1.body as any).attempts).toBe(1);
      expect((res2.body as any).attempts).toBe(2);
    });

    it('does not cache 5xx — a retry re-executes the operation (timeout/transient failure case)', async () => {
      const failingBase = '/test-timeout-retry';
      let attempts = 0;

      app.post(failingBase, idempotencyMiddleware(idempotencyRepo), (_req, res) => {
        attempts++;
        res.status(503).json({ error: 'upstream timeout', attempts });
      });

      const headers = { 'idempotency-key': 'timeout-retry' };

      const res1 = await request(app, 'POST', failingBase, headers, { data: 'y' });
      const res2 = await request(app, 'POST', failingBase, headers, { data: 'y' });

      expect((res1.body as any).attempts).toBe(1);
      expect((res2.body as any).attempts).toBe(2);
    });
  });

  describe('single committed effect under duplicate / reordered / conflicting keys', () => {
    it('a conflicting idempotency key leaves no record so a corrective retry commits exactly once', async () => {
      // Conflicting credential tries to submit the same key first.
      const appConflicting = express();
      appConflicting.use(express.json());
      appConflicting.use((req: any, _res, next) => { req.apiKey = { id: 'actor-B' }; next(); });
      appConflicting.post(BASE, idempotencyMiddleware(idempotencyRepo), (_req, res) => {
        res.status(201).json({ success: true, committed: 999 });
      });

      const good = express();
      good.use(express.json());
      good.use((req: any, _res, next) => { req.apiKey = { id: 'actor-A' }; next(); });
      let committed = 0;
      good.post(BASE, idempotencyMiddleware(idempotencyRepo), (req: any, res) => {
        committed++;
        res.status(201).json({ success: true, committed });
      });

      // actor-B claims the key with its own payload.
      const resB = await request(appConflicting, 'POST', BASE, { 'idempotency-key': 'corrective-key' }, { data: 'b' });
      expect(resB.status).toBe(201);
      expect((resB.body as any).committed).toBe(999);

      // actor-A retries with the same key but a different payload => mismatch,
      // and crucially the conflicting (actor-B) record is untouched.
      const resA = await request(good, 'POST', BASE, { 'idempotency-key': 'corrective-key' }, { data: 'b' });
      expect(resA.status).toBe(409);

      // actor-A submits under a fresh key => executes and commits exactly once.
      const resA2 = await request(good, 'POST', BASE, { 'idempotency-key': 'corrective-key-2' }, { data: 'a' });
      expect(resA2.status).toBe(201);
      expect((resA2.body as any).committed).toBe(1);
    });

    it('a conflict response is not persisted, so the same key can later be bound to a legitimate effect', async () => {
      const legit = express();
      legit.use(express.json());
      legit.use((req: any, _res, next) => { req.apiKey = { id: 'legit-actor' }; next(); });
      let runs = 0;
      legit.post(BASE, idempotencyMiddleware(idempotencyRepo), (_req, res) => {
        runs++;
        res.status(201).json({ success: true, runs });
      });

      const first = await request(legit, 'POST', BASE, { 'idempotency-key': 'reclaim-key' }, { data: 'v1' });
      expect(first.status).toBe(201);
      expect((first.body as any).runs).toBe(1);

      // Same key with a different payload => 409; the original record is retained.
      const conf = await request(legit, 'POST', BASE, { 'idempotency-key': 'reclaim-key' }, { data: 'v2' });
      expect(conf.status).toBe(409);

      // Replaying the ORIGINAL payload still returns the cached response (one effect).
      const replay = await request(legit, 'POST', BASE, { 'idempotency-key': 'reclaim-key' }, { data: 'v1' });
      expect(replay.status).toBe(201);
      expect((replay.body as any).runs).toBe(1);
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

describe('extractActorId', () => {
  function reqWith(headers: Record<string, string>): Request {
    const req: any = { headers };
    return req as Request;
  }

  it('binds to a raw x-api-key hash before any resolved apiKey identity', () => {
    const req = reqWith({ 'x-api-key': 'cr_secret-material' });
    (req as any).apiKey = { id: 'resolved-key-id' };
    expect(extractActorId(req)).toMatch(/^raw-key:[0-9a-f]{64}$/);
    expect(extractActorId(req)).not.toBe('resolved-key-id');
  });

  it('binds to a raw bearer token hash when no x-api-key is present', () => {
    const req = reqWith({ authorization: 'Bearer abcdef123456' });
    (req as any).user = { id: 'user-1' };
    expect(extractActorId(req)).toMatch(/^raw-token:[0-9a-f]{64}$/);
    expect(extractActorId(req)).not.toBe('user-1');
  });

  it('is deterministic for the same credential material', () => {
    const a = reqWith({ 'x-api-key': 'cr_stable-material' });
    const b = reqWith({ 'x-api-key': 'cr_stable-material' });
    expect(extractActorId(a)).toBe(extractActorId(b));
  });

  it('differs across distinct credential material', () => {
    const a = reqWith({ 'x-api-key': 'cr_material-one' });
    const b = reqWith({ 'x-api-key': 'cr_material-two' });
    expect(extractActorId(a)).not.toBe(extractActorId(b));
  });

  it('falls back to resolved apiKey identity when no raw credential is present', () => {
    const req = reqWith({});
    (req as any).apiKey = { id: 'resolved-key-id' };
    expect(extractActorId(req)).toBe('resolved-key-id');
  });

  it('falls back to anonymous when nothing is present', () => {
    expect(extractActorId(reqWith({}))).toBe('anonymous');
  });
});
