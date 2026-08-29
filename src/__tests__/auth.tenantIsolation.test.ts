import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ApiScope } from '../middleware/auth.js';
import { authenticate, requireTenant, requireScope, type TokenVerifier } from '../auth/middleware.js';

type State = { displayName: string };
type Invoked = { count: number };

function createApp(verifier: TokenVerifier, state: State, invoked: Invoked) {
  const app = express();
  app.use(express.json());
  app.put(
    '/api/tenants/:tenantId/identities/:address',
    authenticate(verifier),
    requireTenant(),
    requireScope(ApiScope.ADMIN_WRITE),
    (_req, res) => {
      invoked.count += 1;
      state.displayName = 'new';
      res.json({ ok: true });
    }
  );
  return app;
}

describe('auth tenant isolation', () => {
  const verifier: TokenVerifier = {
    verify: async (token: string) => {
      switch (token) {
        case 'valid-a':
          return { tenantId: 'tenant-a', serviceAccountId: 'svc-a', scopes: [ApiScope.ADMIN_WRITE] };
        case 'valid-b':
          return { tenantId: 'tenant-b', serviceAccountId: 'svc-b', scopes: [ApiScope.ADMIN_WRITE] };
        case 'readonly':
          return { tenantId: 'tenant-a', serviceAccountId: 'svc-ro', scopes: [ApiScope.TRUST_READ] };
        default:
          return null;
      }
    },
  };

  it('rejects missing token with 401 and no mutation', async () => {
    const state: State = { displayName: 'old' };
    const invoked: Invoked = { count: 0 };
    const app = createApp(verifier, state, invoked);

    const res = await request(app)
      .put('/api/tenants/tenant-a/identities/0xabc')
      .send({ displayName: 'new' });

    expect(res.status).toBe(401);
    expect(state.displayName).toBe('old');
    expect(invoked.count).toBe(0);
  });

  it('rejects forged token with 401 and no mutation', async () => {
    const state: State = { displayName: 'old' };
    const invoked: Invoked = { count: 0 };
    const app = createApp(verifier, state, invoked);

    const res = await request(app)
      .put('/api/tenants/tenant-a/identities/0xabc')
      .set('Authorization', 'Bearer forged')
      .send({ displayName: 'new' });

    expect(res.status).toBe(401);
    expect(state.displayName).toBe('old');
    expect(invoked.count).toBe(0);
  });

  it('rejects cross-tenant request with 403 and no mutation', async () => {
    const state: State = { displayName: 'old' };
    const invoked: Invoked = { count: 0 };
    const app = createApp(verifier, state, invoked);

    const res = await request(app)
      .put('/api/tenants/tenant-a/identities/0xabc')
      .set('Authorization', 'Bearer valid-b')
      .send({ displayName: 'new' });

    expect(res.status).toBe(403);
    expect(state.displayName).toBe('old');
    expect(invoked.count).toBe(0);
  });

  it('rejects insufficient scope with 403 and no mutation', async () => {
    const state: State = { displayName: 'old' };
    const invoked: Invoked = { count: 0 };
    const app = createApp(verifier, state, invoked);

    const res = await request(app)
      .put('/api/tenants/tenant-a/identities/0xabc')
      .set('Authorization', 'Bearer readonly')
      .send({ displayName: 'new' });

    expect(res.status).toBe(403);
    expect(state.displayName).toBe('old');
    expect(invoked.count).toBe(0);
  });

  it('allows authorized same-tenant request and mutates', async () => {
    const state: State = { displayName: 'old' };
    const invoked: Invoked = { count: 0 };
    const app = createApp(verifier, state, invoked);

    const res = await request(app)
      .put('/api/tenants/tenant-a/identities/0xabc')
      .set('Authorization', 'Bearer valid-a')
      .send({ displayName: 'new' });

    expect(res.status).toBe(200);
    expect(state.displayName).toBe('new');
    expect(invoked.count).toBe(1);
  });
});
