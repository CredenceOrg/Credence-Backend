// src/__tests__/app.test.ts
/**
 * Test suite for boundary and recovery behaviour of src/app.ts.
 * The tests import the internal configuration export `_testInternals`
 * (exposed only for test builds) to assert that fallback defaults are
 * correctly applied when environment variables are missing or malformed.
 */
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import request from 'supertest';
import path from 'path';

// Helper to reload the app module after changing process.env.
async function loadApp() {
  // Reset module cache so the app re‑reads env vars.
  vi.resetModules();
  // Dynamically import after resetting.
  const mod = await import('../../src/app');
  // The default export is the Express app, and `_testInternals` contains
  // the resolved configuration values.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const app = mod.default;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const internals = (mod as any)._testInternals;
  return { app, internals };
}

// Preserve original env to avoid cross‑test contamination.
const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('src/app.ts boundary & recovery', () => {
  it('uses provided valid configuration and starts health endpoint', async () => {
    process.env.RATE_LIMIT_ENABLED = 'true';
    process.env.RATE_LIMIT_WINDOW_SEC = '60';
    process.env.RATE_LIMIT_MAX_FREE = '100';
    process.env.RATE_LIMIT_MAX_PRO = '1000';
    process.env.RATE_LIMIT_MAX_ENTERPRISE = '10000';
    process.env.RATE_LIMIT_FAIL_OPEN = 'false';

    process.env.AUTH_RATE_LIMIT_ENABLED = 'true';
    process.env.AUTH_RATE_LIMIT_WINDOW_SEC = '60';
    process.env.AUTH_RATE_LIMIT_MAX_PER_TENANT = '20';
    process.env.AUTH_RATE_LIMIT_FAIL_OPEN = 'false';

    process.env.TIMEOUTS_GLOBAL = '5000';
    process.env.MAINTENANCE_MODE_ENABLED = 'true';
    process.env.CORS_ORIGIN = 'https://example.com';
    // No REDIS_URL – app should start without a Redis client.
    delete process.env.REDIS_URL;

    const { app, internals } = await loadApp();
    // Verify internal config reflects env values.
    expect(internals.rateLimitConfig.enabled).toBe(true);
    expect(internals.authRateLimitConfig.enabled).toBe(true);
    expect(internals.globalTimeoutMs).toBe(5000);
    expect(internals.maintenanceModeEnabled).toBe(true);
    expect(internals.corsOrigin).toBe('https://example.com');
    expect(internals.redisClient).toBeUndefined();

    // Health endpoint should respond 200.
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
  });

  it('falls back to safe defaults when rate‑limit config is missing or invalid', async () => {
    // Unset all RATE_LIMIT_* vars.
    delete process.env.RATE_LIMIT_ENABLED;
    delete process.env.RATE_LIMIT_WINDOW_SEC;
    delete process.env.RATE_LIMIT_MAX_FREE;
    delete process.env.RATE_LIMIT_MAX_PRO;
    delete process.env.RATE_LIMIT_MAX_ENTERPRISE;
    delete process.env.RATE_LIMIT_FAIL_OPEN;

    // Provide a valid auth‑rate‑limit config so the app can start.
    process.env.AUTH_RATE_LIMIT_ENABLED = 'true';
    process.env.AUTH_RATE_LIMIT_WINDOW_SEC = '60';
    process.env.AUTH_RATE_LIMIT_MAX_PER_TENANT = '20';
    process.env.AUTH_RATE_LIMIT_FAIL_OPEN = 'false';

    const { app, internals } = await loadApp();
    // The fallback enables rate limiting and uses the hard‑coded defaults.
    expect(internals.rateLimitConfig.enabled).toBe(true);
    expect(internals.rateLimitConfig.windowSec).toBe(60);
    expect(internals.rateLimitConfig.maxFree).toBe(100);
    // Verify the app still responds.
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
  });

  it('uses default global timeout when value is malformed', async () => {
    process.env.TIMEOUTS_GLOBAL = 'not-a-number';
    // Minimal required config to start the app.
    process.env.AUTH_RATE_LIMIT_ENABLED = 'true';
    process.env.AUTH_RATE_LIMIT_WINDOW_SEC = '60';
    process.env.AUTH_RATE_LIMIT_MAX_PER_TENANT = '20';
    process.env.AUTH_RATE_LIMIT_FAIL_OPEN = 'false';

    const { app, internals } = await loadApp();
    expect(internals.globalTimeoutMs).toBe(30000);
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
  });

  it('defaults maintenance mode to false when config is invalid', async () => {
    process.env.MAINTENANCE_MODE_ENABLED = 'invalid-boolean';
    // Provide required auth rate‑limit config.
    process.env.AUTH_RATE_LIMIT_ENABLED = 'true';
    process.env.AUTH_RATE_LIMIT_WINDOW_SEC = '60';
    process.env.AUTH_RATE_LIMIT_MAX_PER_TENANT = '20';
    process.env.AUTH_RATE_LIMIT_FAIL_OPEN = 'false';

    const { app, internals } = await loadApp();
    expect(internals.maintenanceModeEnabled).toBe(false);
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
  });

  it('exposes undefined redisClient when REDIS_URL is not set', async () => {
    delete process.env.REDIS_URL;
    process.env.AUTH_RATE_LIMIT_ENABLED = 'true';
    process.env.AUTH_RATE_LIMIT_WINDOW_SEC = '60';
    process.env.AUTH_RATE_LIMIT_MAX_PER_TENANT = '20';
    process.env.AUTH_RATE_LIMIT_FAIL_OPEN = 'false';

    const { app, internals } = await loadApp();
    expect(internals.redisClient).toBeUndefined();
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
  });
});
