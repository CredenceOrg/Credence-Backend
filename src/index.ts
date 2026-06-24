import 'dotenv/config'
import app from './app.js'
import { createServer } from './app.js'
import { createAdminRouter } from './routes/admin/index.js'
import governanceRouter from './routes/governance.js'
import disputesRouter from './routes/disputes.js'
import evidenceRouter from './routes/evidence.js'
import { loadConfig } from './config/index.js'
import { pool } from './db/pool.js'
import { AnalyticsService } from './services/analytics/service.js'
import { AnalyticsRefreshWorker, getAnalyticsRefreshIntervalMs } from './jobs/analyticsRefreshWorker.js'
import { keyManager } from './services/keyManager/index.js'
import { shutdownWebSocketServer } from './routes/ws.js'

app.use('/api/admin', createAdminRouter())
app.use('/api/governance', governanceRouter)
app.use('/api/disputes', disputesRouter)
app.use('/api/evidence', evidenceRouter)
export { app }
export default app

if (process.env.NODE_ENV !== 'test') {
  try {
    const config = loadConfig()
    const server = createServer()

    server.listen(config.port, () => {
      console.log(`Credence API listening on port ${config.port}`)
    })

    // Graceful shutdown
    const shutdown = async (signal: string): Promise<void> => {
      console.log(`Received ${signal}, shutting down gracefully...`)
      
      // Shutdown WebSocket server
      await shutdownWebSocketServer()
      
      // Close HTTP server
      server.close(() => {
        console.log('HTTP server closed')
        process.exit(0)
      })
      
      // Force shutdown after 10 seconds
      setTimeout(() => {
        console.error('Forced shutdown after timeout')
        process.exit(1)
      }, 10000)
    }

    process.on('SIGTERM', () => void shutdown('SIGTERM'))
    process.on('SIGINT', () => void shutdown('SIGINT'))

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
    }
  } catch (error) {
    console.error('Failed to start Credence API:', error)
    process.exit(1)
  }
}
