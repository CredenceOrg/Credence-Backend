/**
 * @module routes/attestations
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import {
  buildPaginationMeta,
  parsePaginationParams,
  PaginationValidationError,
} from '../lib/pagination.js'
import { AttestationRepository } from '../repositories/attestationRepository.js'
import { AttestationsApiService } from '../services/attestationsApiService.js'
import type {
  AttestationCountResponse,
  AttestationListResponse,
  CreateAttestationParams,
} from '../types/attestation.js'
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js'
import { validate } from '../middleware/validate.js'
import {
  attestationIdentityParamsSchema,
  attestationListQuerySchema,
  createAttestationBodySchema,
} from '../schemas/attestations.js'
import { normalizeAddress } from '../lib/address.js'

export type AttestationRouterBackend = AttestationRepository | AttestationsApiService

function isApiService(backend: AttestationRouterBackend): backend is AttestationsApiService {
  return backend instanceof AttestationsApiService
}

function handleRouteError(error: unknown, next: NextFunction): void {
  if (error instanceof PaginationValidationError) {
    next(new ValidationError('Validation failed', error.details))
    return
  }
  if (error instanceof Error) {
    if (error.message.includes('already revoked')) {
      next(new ConflictError(error.message))
      return
    }
    if (
      error.message.includes('subject is required') ||
      error.message.includes('verifier is required') ||
      error.message.includes('claim is required') ||
      error.message.includes('weight must be')
    ) {
      next(new ValidationError(error.message))
      return
    }
  }
  next(error)
}

/**
 * Create and return an Express {@link Router} for attestation endpoints.
 */
export function createAttestationRouter(backend: AttestationRouterBackend): Router {
  const router = Router()

  router.get(
    '/:identity/count',
    validate({ params: attestationIdentityParamsSchema }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { identity } = req.validated!.params! as { identity: string }
        const includeRevoked = req.query.includeRevoked === 'true'
        const normalized = normalizeAddress(identity)

        const count = isApiService(backend)
          ? await backend.countBySubject(normalized, includeRevoked)
          : backend.countBySubject(normalized, includeRevoked)

        const body: AttestationCountResponse = {
          identity: normalized,
          count,
          includeRevoked,
        }

        res.json(body)
      } catch (error) {
        handleRouteError(error, next)
      }
    },
  )

  router.get(
    '/:identity',
    validate({
      params: attestationIdentityParamsSchema,
      query: attestationListQuerySchema,
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { identity } = req.validated!.params! as { identity: string }
        const query = req.validated!.query as {
          page: number
          limit: number
          offset: number
          includeRevoked?: boolean
        }
        const includeRevoked = query.includeRevoked ?? req.query.includeRevoked === 'true'
        const normalized = normalizeAddress(identity)

        const { page, limit, offset } = parsePaginationParams(req.query as Record<string, unknown>)

        let attestations: AttestationListResponse['attestations']
        let total: number

        if (isApiService(backend)) {
          const result = await backend.findBySubject(normalized, {
            includeRevoked,
            offset,
            limit,
          })
          attestations = result.attestations
          total = result.total
        } else {
          const result = backend.findBySubject(normalized, {
            includeRevoked,
            offset,
            limit,
          })
          attestations = result.attestations
          total = result.total
        }

        const body: AttestationListResponse = {
          identity: normalized,
          attestations,
          ...buildPaginationMeta(total, page, limit),
        }

        res.json(body)
      } catch (error) {
        handleRouteError(error, next)
      }
    },
  )

  router.post(
    '/',
    validate({ body: createAttestationBodySchema }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = req.validated!.body! as CreateAttestationParams & { bondId?: number }
        const params: CreateAttestationParams = {
          subject: normalizeAddress(body.subject),
          verifier: normalizeAddress(body.verifier),
          weight: body.weight,
          claim: body.claim,
        }

        const attestation = isApiService(backend)
          ? await backend.create({ ...params, bondId: body.bondId })
          : backend.create(params)

        res.status(201).json(attestation)
      } catch (error) {
        handleRouteError(error, next)
      }
    },
  )

  router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (isApiService(backend)) {
        const attestation = await backend.revoke(req.params.id)
        res.json(attestation)
        return
      }

      const result = backend.revoke(req.params.id)
      if (!result) {
        throw new NotFoundError('Attestation', req.params.id)
      }
      res.json(result)
    } catch (error) {
      handleRouteError(error, next)
    }
  })

  return router
}
