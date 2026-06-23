import { Request, Response, NextFunction } from 'express'
import { tracingContext } from '../utils/logger.js'

export interface TenantContextOptions {
  allowHeaderFallback?: boolean
  allowDefaultTenant?: boolean
  tenantScopedRoutes?: string[]
  requiredOnScoped?: boolean
}

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string
    tenantId: string
    email: string
    role: string
  }
  tenantId?: string
}

const TENANT_ID_FORMAT = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/i
const DEFAULT_TENANT = 'default-tenant'
const TENANT_HEADER = 'x-tenant-id'

let tenantContextConfig: TenantContextOptions = {
  allowHeaderFallback: false,
  allowDefaultTenant: false,
  tenantScopedRoutes: [],
  requiredOnScoped: true,
}

export function configureTenantContext(config: Partial<TenantContextOptions>): void {
  tenantContextConfig = { ...tenantContextConfig, ...config }
}

export function isValidTenantId(tenantId: string): boolean {
  return TENANT_ID_FORMAT.test(tenantId) && tenantId.length <= 255
}

function resolveTenant(req: AuthenticatedRequest): string | null {
  const authReq = req as AuthenticatedRequest

  if (authReq.user?.tenantId) {
    const tenantId = authReq.user.tenantId
    if (!isValidTenantId(tenantId)) {
      throw new Error(`Invalid tenant format from principal: ${tenantId}`)
    }
    return tenantId
  }

  if (tenantContextConfig.allowHeaderFallback) {
    const headerTenant = (req.headers[TENANT_HEADER] as string)?.toLowerCase()
    if (headerTenant) {
      if (!isValidTenantId(headerTenant)) {
        throw new Error(`Invalid tenant format from header: ${headerTenant}`)
      }
      return headerTenant
    }
  }

  if (tenantContextConfig.allowDefaultTenant && DEFAULT_TENANT) {
    return DEFAULT_TENANT
  }

  return null
}

function isRouteScoped(path: string): boolean {
  const scoped = tenantContextConfig.tenantScopedRoutes ?? []
  return scoped.some((route) => {
    const pattern = route.replace(/:[^/]+/g, '[^/]+')
    return new RegExp(`^${pattern}(/|$)`).test(path)
  })
}

export function tenantContextMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const authReq = req as AuthenticatedRequest

  try {
    const tenantId = resolveTenant(authReq)

    if (tenantId === null) {
      const isScoped = isRouteScoped(req.path)
      if (isScoped && tenantContextConfig.requiredOnScoped) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Tenant context required but not provided',
        })
        return
      }

      if (!tenantContextConfig.allowDefaultTenant) {
        res.status(400).json({
          error: 'BadRequest',
          message: 'Tenant ID could not be resolved',
        })
        return
      }
    }

    authReq.tenantId = tenantId ?? DEFAULT_TENANT

    const context = tracingContext.getStore() || new Map<string, string>()
    context.set('tenantId', authReq.tenantId)

    next()
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    res.status(400).json({
      error: 'BadRequest',
      message: `Invalid tenant context: ${message}`,
    })
  }
}

export function requireTenant(req: Request, res: Response, next: NextFunction): void {
  const authReq = req as AuthenticatedRequest

  if (!authReq.tenantId) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Tenant context required',
    })
    return
  }

  next()
}

export function getTenantId(req: Request): string | undefined {
  const authReq = req as AuthenticatedRequest
  return authReq.tenantId
}
