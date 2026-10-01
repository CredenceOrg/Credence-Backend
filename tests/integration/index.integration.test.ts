import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app, shutdown } from '../../src/index.js';

describe('index.ts boundary and recovery tests', () => {
  beforeAll(() => {
    // any setup
  });

  afterAll(async () => {
    await shutdown('SIGTERM');
  });

  it('loads the application module without errors', () => {
    expect(app).toBeDefined();
    expect(shutdown).toBeTypeOf('function');
  });

  it('returns 404 for unknown routes (loading state/boundary)', async () => {
    const response = await request(app).get('/api/unknown-route-boundary');
    expect(response.status).toBe(404);
  });

  it('handles shutdown correctly', async () => {
    // testing shutdown invariant
    await expect(shutdown('SIGINT')).resolves.toBeUndefined();
  });
});
