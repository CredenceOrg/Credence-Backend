import { Request, Response, NextFunction } from 'express'
import { runWithTenant, getTenantId } from '../utils/tenantContext.js'
import { TenantRequiredError } from '../lib/errors.js'

export function tenantContextMiddleware(req: Request, res: Response, next: NextFunction) {
  const rawTenantId = req.headers['x-tenant-id']
  const tenantId = typeof rawTenantId === 'string' ? rawTenantId.trim() : ''

  if (!tenantId) {
    next(new TenantRequiredError())
    return
  }

  const existingTenant = getTenantId()

  if (existingTenant) {
    // Already inside a tenant-scoped ALS run (e.g. nested call) — don't
    // start a new one, just continue.
    next()
    return
  }

  runWithTenant(tenantId, () => {
    next()
  })
}
