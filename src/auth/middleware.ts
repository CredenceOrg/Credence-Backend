import type { NextFunction, Request, Response } from 'express'
import { ApiScope } from '../middleware/auth.js'

export interface AuthPrincipal {
  tenantId: string
  serviceAccountId?: string
  scopes: ApiScope[]
}

export interface TokenVerifier {
  verify(token: string): Promise<AuthPrincipal | null> | AuthPrincipal | null
}

export type AuthenticatedRequest = Request & { auth?: AuthPrincipal }
type Handler = (req: AuthenticatedRequest, res: Response, next: NextFunction) => void | Promise<void>

export function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return null
  return header.slice('Bearer '.length).trim() || null
}

export function authenticate(verifier: TokenVerifier): Handler {
  return async (req, res, next) => {
    try {
      const token = extractBearerToken(req)
      const principal = token ? await verifier.verify(token) : null
      if (!principal?.tenantId) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }
      ;(req as AuthenticatedRequest).auth = principal
      next()
    } catch (err) {
      next(err)
    }
  }
}

export function requireTenant(paramName = 'tenantId'): Handler {
  return (req, res, next) => {
    const auth = (req as AuthenticatedRequest).auth
    if (!auth?.tenantId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const value = req.params[paramName]
    if (!value || value !== auth.tenantId) {
      res.status(403).json({ error: 'Forbidden: tenant mismatch' })
      return
    }
    next()
  }
}

export function requireScope(...allowedScopes: ApiScope[]): Handler {
  return (req, res, next) => {
    const auth = (req as AuthenticatedRequest).auth
    if (!auth) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const ok = auth.scopes.some((scope) => allowedScopes.includes(scope))
    if (!ok) {
      res.status(403).json({ error: 'Forbidden: insufficient scope' })
      return
    }
    next()
  }
}
