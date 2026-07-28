import { Router, type Request, type Response, type NextFunction } from 'express'
import { requireUserAuth, requireAdminRole } from '../../middleware/auth.js'
import { pool } from '../../db/pool.js'
import { BACKUP_STALE_THRESHOLD_MS } from '../../config/constants.js'
import { BackfillProgressRepository } from '../../db/repositories/backfillProgressRepository.js'
import { sendError, ErrorCode } from '../../lib/errors.js'

const router = Router()
const backfillRepo = new BackfillProgressRepository(pool)

/**
 * GET /api/admin/system/backup-status
 * 
 * Returns the status of the continuous WAL archiving backup job.
 * If the last archived WAL file is older than the configured threshold,
 * the backup is considered stale.
 */
router.get(
  '/backup-status',
  requireUserAuth,
  requireAdminRole,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Query PostgreSQL for the last time a WAL file was successfully archived
      const { rows } = await pool.query('SELECT last_archived_time FROM pg_stat_archiver')
      const lastArchivedTime = rows[0]?.last_archived_time

      let isStale = true
      let lastSuccessfulBackup = null

      if (lastArchivedTime) {
        lastSuccessfulBackup = new Date(lastArchivedTime).toISOString()
        const ageMs = Date.now() - new Date(lastArchivedTime).getTime()
        isStale = ageMs > BACKUP_STALE_THRESHOLD_MS
      }

      res.status(200).json({
        success: true,
        data: {
          isStale,
          lastSuccessfulBackup,
        },
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * GET /api/admin/system/backfill-status
 *
 * Returns the status of all backfill progress markers.
 * Useful for operators to check whether database backfills are in flight.
 *
 * Response shape:
 *   {
 *     success: true,
 *     data: [
 *       {
 *         jobName: string,
 *         cursorValue: string,
 *         rowsProcessed: number,
 *         totalRows: number | null,
 *         status: 'pending' | 'running' | 'completed' | 'failed',
 *         lastError: string | null,
 *         createdAt: string (ISO),
 *         updatedAt: string (ISO)
 *       }
 *     ]
 *   }
 */
router.get(
  '/backfill-status',
  requireUserAuth,
  requireAdminRole,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const markers = await backfillRepo.findAll()

      const data = markers.map((m) => ({
        jobName: m.jobName,
        cursorValue: m.cursorValue,
        rowsProcessed: m.rowsProcessed,
        totalRows: m.totalRows,
        status: m.status,
        lastError: m.lastError,
        createdAt: m.createdAt.toISOString(),
        updatedAt: m.updatedAt.toISOString(),
      }))

      res.status(200).json({
        success: true,
        data,
      })
    } catch (error) {
      next(error)
    }
  },
)

export default router
