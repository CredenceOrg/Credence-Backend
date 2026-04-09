import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import express, { type Express } from 'express';
import { newDb, type IMemoryDb } from 'pg-mem';
import { Pool } from 'pg';
import { IdempotencyRepository } from '../../db/repositories/idempotencyRepository.js';
import { idempotencyMiddleware } from '../idempotency.js';

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
  
  // Create the idempotency_keys table
  db.public.none(`
    CREATE TABLE idempotency_keys (
      key TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      response_code INTEGER NOT NULL,
      response_body JSONB NOT NULL,
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
    app.post(BASE, idempotencyMiddleware(idempotencyRepo), (req, res) => {
      callCount++;
      res.status(201).json({ 
        success: true, 
        received: req.body,
        callCount 
      });
    });
  });

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

  it('rejects different payload for same key', async () => {
    const headers = { 'idempotency-key': 'test-key-2' };

    // First request
    await request(app, 'POST', BASE, headers, { data: 'original' });

    // Second request with different data
    const { status, body } = await request(app, 'POST', BASE, headers, { data: 'modified' });
    
    expect(status).toBe(400);
    expect((body as any).error).toBe('IdempotencyParameterMismatch');
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
