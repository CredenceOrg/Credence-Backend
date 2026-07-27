import { Router, type Request, type Response, type NextFunction } from 'express'
import {
  type AuthenticatedRequest,
  requireUserAuth,
  requireAdminRole,
} from '../../middleware/auth.js'
import { validate } from '../../middleware/validate.js'
import { settlementReconciliationQuerySchema } from '../../schemas/settlementReconciliation.js'
import { pool } from '../../db/pool.js'
import { buildCursorEnvelope, buildCursorPaginationLinks, encodeCursor } from '../../lib/pagination.js'

const router = Router()

/**
 * GET /api/admin/settlement/reconciliation
 *
 * Returns the most recent settlement reconciliation run's summary and a
 * cursor-paginated list of unmatched findings.
 *
 * Read-only — never mutates payout or settlement records.
 *
 * @openapi
 * /api/admin/settlement/reconciliation:
 *   get:
 *     summary: Get latest reconciliation report
 *     tags: [Admin, Settlement]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/schemas/SettlementReconciliationQuery'
 *     responses:
 *       200:
 *         description: Latest reconciliation run summary with paginated findings
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SettlementReconciliationResponse'
 *       401:
 *         description: Unauthenticated
 *       403:
 *         description: Non-admin caller
 */
router.get(
  '/reconciliation',
  requireUserAuth,
  requireAdminRole,
  validate({ query: settlementReconciliationQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // 1. Fetch the latest reconciliation run
      const runResult = await pool.query<{
        id: string
        checked: number
        discrepancies: number
        errors: number
        run_at: Date
      }>(
        `SELECT id, checked, discrepancies, errors, run_at
         FROM settlement_reconciliation_runs
         ORDER BY run_at DESC
         LIMIT 1`
      )

      const latestRun = runResult.rows[0]

      if (!latestRun) {
        res.status(200).json({ success: true, data: null })
        return
      }

      // 2. Parse pagination params
      const limit = Number(req.query.limit) || 20
      const cursor = typeof req.query.cursor === 'string' && req.query.cursor.trim() !== ''
        ? req.query.cursor
        : null

      // 3. Build findings query with optional cursor
      let findingsQuery: string
      let findingsParams: unknown[]

      if (cursor) {
        // Decode a simple base64url cursor: "createdAt|id"
        let cursorCreatedAt: string
        let cursorId: string
        try {
          const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
          const parts = decoded.split('|')
          if (parts.length !== 2) throw new Error('Invalid cursor')
          cursorCreatedAt = parts[0]
          cursorId = parts[1]
        } catch {
          res.status(400).json({
            success: false,
            error: 'Invalid cursor format',
            code: 'validation_failed',
          })
          return
        }

        findingsQuery = `
          SELECT id, settlement_id, finding_type, details, created_at
          FROM settlement_reconciliation_findings
          WHERE run_id = $1
            AND (created_at, id) < ($2::timestamptz, $3::uuid)
          ORDER BY created_at DESC, id DESC
          LIMIT $4
        `
        findingsParams = [latestRun.id, cursorCreatedAt, cursorId, limit + 1]
      } else {
        findingsQuery = `
          SELECT id, settlement_id, finding_type, details, created_at
          FROM settlement_reconciliation_findings
          WHERE run_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT $2
        `
        findingsParams = [latestRun.id, limit + 1]
      }

      const findingsResult = await pool.query<{
        id: string
        settlement_id: string
        finding_type: string
        details: Record<string, unknown>
        created_at: Date
      }>(findingsQuery, findingsParams)

      const rows = findingsResult.rows
      const hasMore = rows.length > limit
      const findings = rows.slice(0, limit).map((row) => ({
        id: row.id,
        settlementId: row.settlement_id,
        findingType: row.finding_type,
        details: row.details,
        createdAt: row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
      }))

      // Build next cursor from the last returned item
      let nextCursor: string | null = null
      if (hasMore && findings.length > 0) {
        const last = findings[findings.length - 1]
        nextCursor = Buffer.from(
          `${last.createdAt}|${last.id}`,
          'utf8',
        ).toString('base64url')
      }

      const envelope = buildCursorEnvelope(findings, {
        limit,
        hasMore,
        nextCursor,
      })

      const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`

      res.status(200).json({
        success: true,
        data: {
          summary: {
            checked: latestRun.checked,
            discrepancies: latestRun.discrepancies,
            errors: latestRun.errors,
            runAt: latestRun.run_at instanceof Date
              ? latestRun.run_at.toISOString()
              : String(latestRun.run_at),
          },
          findings: {
            ...envelope,
            links: buildCursorPaginationLinks(fullUrl, limit, nextCursor),
          },
        },
      })
    } catch (error) {
      next(error)
    }
  },
)

export default router
