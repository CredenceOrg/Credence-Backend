import { Router, type Request, type Response, type NextFunction } from 'express'
import {
  type AuthenticatedRequest,
  requireUserAuth,
  requireAdminRole,
} from '../../middleware/auth.js'
import { validate } from '../../middleware/validate.js'
import {
  migrationsDryRunQuerySchema,
  migrationsDryRunBodySchema,
} from '../../schemas/admin.js'
import { dryRunMigration } from '../../migrations/runner.js'

const router = Router()

/**
 * GET /api/admin/migrations/dry-run
 *
 * Previews the SQL statements that would be executed by the next migration up without applying them.
 */
router.get(
  '/dry-run',
  requireUserAuth,
  requireAdminRole,
  validate({ query: migrationsDryRunQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { count, file, skipPreflight } = req.query as unknown as {
        count?: number
        file?: string
        skipPreflight?: boolean
      }

      const result = await dryRunMigration({
        count,
        file,
        skipPreflight: Boolean(skipPreflight),
        verbose: false,
      })

      if (!result.success) {
        return res.status(400).json({
          success: false,
          error: 'MigrationDryRunFailed',
          message: result.error ?? 'Failed to execute migration dry run',
        })
      }

      const sqlStatements = result.sql ?? []

      return res.status(200).json({
        success: true,
        data: {
          applied: result.applied,
          sql: sqlStatements,
          sqlText: sqlStatements.join('\n'),
          count: result.applied.length,
        },
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * POST /api/admin/migrations/dry-run
 *
 * Previews the SQL statements that would be executed by the next migration up without applying them.
 */
router.post(
  '/dry-run',
  requireUserAuth,
  requireAdminRole,
  validate({ body: migrationsDryRunBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { count, file, skipPreflight } = req.body as {
        count?: number
        file?: string
        skipPreflight?: boolean
      }

      const result = await dryRunMigration({
        count,
        file,
        skipPreflight: Boolean(skipPreflight),
        verbose: false,
      })

      if (!result.success) {
        return res.status(400).json({
          success: false,
          error: 'MigrationDryRunFailed',
          message: result.error ?? 'Failed to execute migration dry run',
        })
      }

      const sqlStatements = result.sql ?? []

      return res.status(200).json({
        success: true,
        data: {
          applied: result.applied,
          sql: sqlStatements,
          sqlText: sqlStatements.join('\n'),
          count: result.applied.length,
        },
      })
    } catch (error) {
      next(error)
    }
  },
)

export default router
