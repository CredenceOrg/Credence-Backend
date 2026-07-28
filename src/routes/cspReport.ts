import { Router, Request, Response } from 'express'
import express from 'express'
import { validate } from '../middleware/validate.js'
import { cspReportSchema } from '../schemas/index.js'
import { logger } from '../utils/logger.js'

/**
 * CSP violation report ingestion.
 *
 * **CORS policy:** Open — `POST /csp-report` accepts reports from any browser
 * origin. See `docs/CORS_POLICY.md`.
 */
const router = Router()

router.post(
  '/csp-report',
  express.json({ type: ['application/json', 'application/csp-report'] }),
  validate({ body: cspReportSchema }) as any,
  (req: any, res: Response): void => {
    logger.warn('CSP Violation Report:', req.body)
    res.sendStatus(204)
  }
)

export default router
