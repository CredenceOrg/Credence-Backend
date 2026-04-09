/**
 * @module routes/attestations
 */

import { Router, type Request, type Response } from 'express';
import {
  buildPaginationMeta,
  parsePaginationParams,
} from '../lib/pagination.js';
import { AttestationRepository } from '../repositories/attestationRepository.js';
import type {
  AttestationCountResponse,
  AttestationListResponse,
} from '../types/attestation.js';
import { AppError, ErrorCode, ValidationError, NotFoundError } from '../lib/errors.js';

/**
 * Create and return an Express {@link Router} wired to the given
 * {@link AttestationRepository}.
 *
 * @param repo - The repository instance to delegate to.
 * @returns Configured Express router.
 */
export function createAttestationRouter(repo: AttestationRepository): Router {
  const router = Router();

  // ── GET /api/attestations/:identity/count ────────────────────────────
  router.get('/:identity/count', (req: Request, res: Response): void => {
    const { identity } = req.params;
    const includeRevoked = req.query.includeRevoked === 'true';

    const count = repo.countBySubject(identity, includeRevoked);

    const body: AttestationCountResponse = {
      identity,
      count,
      includeRevoked,
    };

    res.json(body);
  });

  // ── GET /api/attestations/:identity ──────────────────────────────────
  router.get('/:identity', (req: Request, res: Response, next): void => {
    const { identity } = req.params;
    const includeRevoked = req.query.includeRevoked === 'true';

    try {
      const { page, limit, offset } = parsePaginationParams(req.query as Record<string, unknown>);

      // Note: check the repo interface in repositories/attestationRepository.ts if needed
      const { attestations, total } = repo.findBySubject(identity, {
        includeRevoked,
        offset, // Using offset instead of page if that's what's expected
        limit,
      });
      const paginationMeta = buildPaginationMeta(total, page, limit);

      const body: AttestationListResponse = {
        identity,
        attestations,
        ...paginationMeta,
      };

      res.json(body);
    } catch (error) {
      next(error);
    }

    const { page, limit, offset } = pagination;

    const { attestations, total } = repo.findBySubject(identity, {
      includeRevoked,
      offset,
      limit,
    });
    const paginationMeta = buildPaginationMeta(total, page, limit);

    const body: AttestationListResponse = {
      identity,
      attestations,
      ...paginationMeta,
    };

    res.json(body);
  });

  // ── POST /api/attestations ───────────────────────────────────────────
  router.post('/', (req: Request, res: Response, next): void => {
    try {
      const { subject, verifier, weight, claim } = req.body as {
        subject: string;
        verifier: string;
        weight: number;
        claim: string;
      };

      const attestation = repo.create({ subject, verifier, weight, claim });
      res.status(201).json(attestation);
    } catch (err) {
      next(err);
    }
  });

  // ── DELETE /api/attestations/:id ─────────────────────────────────────
  router.delete('/:id', (req: Request, res: Response, next): void => {
    try {
      const result = repo.revoke(req.params.id);
      if (!result) {
        throw new NotFoundError('Attestation', req.params.id);
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
