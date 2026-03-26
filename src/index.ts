import 'dotenv/config'
import app from './app.js'
import { loadConfig } from './config/index.js'
import { pool } from './db/pool.js'
import { AnalyticsService } from './services/analytics/service.js'
import { AnalyticsRefreshWorker, getAnalyticsRefreshIntervalMs } from './jobs/analyticsRefreshWorker.js'
import {
  OrganizationRepository,
  RetentionPolicyRepository,
  RetentionRecordRepository,
} from './db/repositories/index.js'
import {
  RetentionCleanupWorker,
  getRetentionCleanupIntervalMs,
} from './jobs/retentionCleanupWorker.js'

export { app }
export default app

try {
  const config = loadConfig()

  app.listen(config.port, () => {
    console.log(`Credence API listening on port ${config.port}`)
  })

  if (process.env.DATABASE_URL) {
    const thresholdSeconds = Number(process.env.ANALYTICS_STALENESS_SECONDS ?? '300')
    const analyticsService = new AnalyticsService(pool, thresholdSeconds)
    const refreshWorker = new AnalyticsRefreshWorker(analyticsService, console.log)
    const intervalMs = getAnalyticsRefreshIntervalMs()
    let running = false

    const tick = async (): Promise<void> => {
      if (running) {
        console.log('Analytics refresh is already running, skipping interval')
        return
      }
      running = true
      try {
        await refreshWorker.run()
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown refresh error'
        console.error(`Analytics refresh failed: ${message}`)
      } finally {
        running = false
      }
    }

    // Run once on startup, then periodically.
    void tick()
    setInterval(() => {
      void tick()
    }, intervalMs)

    const retentionWorker = new RetentionCleanupWorker(
      new OrganizationRepository(pool),
      new RetentionPolicyRepository(pool),
      new RetentionRecordRepository(pool),
      {
        eventBatchSize: Number(process.env.RETENTION_EVENT_BATCH_SIZE ?? '250'),
        auditBatchSize: Number(process.env.RETENTION_AUDIT_BATCH_SIZE ?? '250'),
        maxBatchesPerClass: Number(process.env.RETENTION_MAX_BATCHES_PER_CLASS ?? '20'),
        logger: console.log,
      }
    )
    const retentionIntervalMs = getRetentionCleanupIntervalMs()
    let retentionRunning = false

    const retentionTick = async (): Promise<void> => {
      if (retentionRunning) {
        console.log('Retention cleanup is already running, skipping interval')
        return
      }
      retentionRunning = true
      try {
        await retentionWorker.run()
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown retention cleanup error'
        console.error(`Retention cleanup failed: ${message}`)
      } finally {
        retentionRunning = false
      }
    }

    void retentionTick()
    setInterval(() => {
      void retentionTick()
    }, retentionIntervalMs)
  }
} catch (error) {
  console.error("Failed to start Credence API:", error)
  process.exit(1)
}
