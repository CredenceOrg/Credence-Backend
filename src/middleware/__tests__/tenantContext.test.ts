import { describe, it, expect, beforeEach } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import { tenantContextMiddleware } from '../tenantContext.js'
import { errorHandler } from '../errorHandler.js'
import { getTenantId } from '../../utils/tenantContext.js'

describe('tenantContextMiddleware', () => {
  let app: Express

  beforeEach(() => {
    process.env.NODE_ENV = 'test'
    app = express()
    app.use(tenantContextMiddleware)
    app.get('/whoami', (_req, res) => {
      res.json({ tenantId: getTenantId() ?? null })
    })
    app.use(errorHandler)
  })

  it('accepts a request with a valid x-tenant-id header', async () => {
    const res = await request(app).get('/whoami').set('x-tenant-id', 'tenant-1')

    expect(res.status).toBe(200)
    expect(res.body.tenantId).toBe('tenant-1')
  })

  // Negative test: this is the case the fix targets. Before the fix, a
  // missing header silently fell back to 'default-tenant' instead of being
  // rejected — masking a tenant-isolation bug rather than surfacing it.
  it('rejects a request with no x-tenant-id header with a typed TENANT_REQUIRED error', async () => {
    const res = await request(app).get('/whoami')

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('tenant_required')
    expect(res.body.error_code).toBe('tenant_required')
  })

  it('rejects a request with an empty x-tenant-id header the same as a missing one', async () => {
    const res = await request(app).get('/whoami').set('x-tenant-id', '')

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('tenant_required')
  })

  it('rejects a request with a whitespace-only x-tenant-id header', async () => {
    const res = await request(app).get('/whoami').set('x-tenant-id', '   ')

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('tenant_required')
  })
})
