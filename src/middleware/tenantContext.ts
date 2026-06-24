import { Request, Response, NextFunction } from 'express'
import { setTenantId, getTenantId } from '../utils/tenantContext.js'

export function tenantContextMiddleware(req: Request, res: Response, next: NextFunction) {
  const tenantId = req.headers['x-tenant-id'] as string || 'default-tenant'
  const originalTenant = getTenantId()
  
  if (!originalTenant) {
    setTenantId(tenantId)
  }
  
  // Store original tenant to restore later
  res.on('finish', () => {
    if (!originalTenant) {
      setTenantId(null)
    }
  })
  
  next()
}