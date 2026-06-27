import 'dotenv/config'
import http from 'http'
import { initTracing } from './tracing/tracer.js'
import app from './app.js'
import { createServer } from './app.js'
import { createAdminRouter } from './routes/admin/index.js'
import governanceRouter from './routes/governance.js'
import disputesRouter from './routes/disputes.js'
import evidenceRouter from './routes/evidence.js'
import { loadConfig } from './config/index.js'
import { pool, workerPool, replicaPool } from './db/pool.js'
import { redisConnection } from './cache/redis.js'
import { createShutdownMetrics } from './observability/shutdownMetrics.js'
import { AnalyticsService } from './services/analytics/service.js'
import { AnalyticsRefreshWorker, getAnalyticsRefreshIntervalMs } from './jobs/analyticsRefreshWorker.js'
import { AnalyticsRefreshScheduler } from './jobs/analyticsRefreshScheduler.js'
import { createAnalyticsRefreshMetrics } from './jobs/analyticsRefreshMetrics.js'
import { SettlementReconciler } from './jobs/settlementReconciler.js'
import { createScheduler } from './jobs/scheduler.js'
import { keyManager } from './services/keyManager/index.js'
import { GracefulShutdownManager } from './gracefulShutdown.js'
import { FailedInboundEventsSweeper } from './jobs/failedInboundEventsSweeper.js'
import { loadFailedInboundSweeperConfig } from './config/retention.js'
import { getInvalidationBus } from './cache/index.js'
import { createWsSubscriptionServer } from './routes/ws.js'
import { impersonationService } from './services/impersonation/index.js'
import { recordOomEvent } from './middleware/metrics.js'
import { logger } from './utils/logger.js'

// Outbox imports
import { OutboxJob } from "./jobs/outbox.js";
import { RequestSnapshotsSweeper } from "./jobs/requestSnapshotsSweeper.js";

app.use("/api/admin", createAdminRouter());
app.use("/api/governance", governanceRouter);
app.use("/api/disputes", disputesRouter);
app.use("/api/evidence", evidenceRouter);
export { app };
export default app;

let server: http.Server | null = null;
let scheduler: AnalyticsRefreshScheduler | null = null;
let outboxJob: OutboxJob | null = null;
let failedInboundSweeper: FailedInboundEventsSweeper | null = null;
let shutdownManager: GracefulShutdownManager | null = null;
let wss: ReturnType<typeof createWsSubscriptionServer> | null = null;
let invalidationBus: ReturnType<typeof getInvalidationBus> | null = null;
let requestSnapshotsSweeper: RequestSnapshotsSweeper | null = null;

function installShutdownHandlers(): void {
  if (!shutdownManager) return;

  process.once("SIGTERM", () => {
    void shutdownManager?.shutdown("SIGTERM");
  });

  process.once("SIGINT", () => {
    void shutdownManager?.shutdown("SIGINT");
  });
}

if (process.env.NODE_ENV !== "test") {
  initTracing();

  // Listen for uncaught exceptions and unhandled rejections
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception:', err);
    if (err.message.includes('heap out of memory') || err.name === 'JavaScript heap out of memory') {
      recordOomEvent();
    }
    // Let the process exit after logging
    process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
    if (reason instanceof Error && (reason.message.includes('heap out of memory') || reason.name === 'JavaScript heap out of memory')) {
      recordOomEvent();
    }
  });

  try {
    const config = loadConfig();

    server = app.listen(config.port, () => {
      logger.info(`Credence API listening on port ${config.port}`);
    });

    // Initialize WebSocket server for score subscriptions
    wss = createWsSubscriptionServer(pool, {
      rateLimitPerSec: 100,
      backpressureThreshold: 1024 * 1024,
      shutdownGracePeriodMs: 5000,
    });

    server.on("upgrade", async (request, socket, head) => {
      if (request.url?.startsWith("/api/ws/subscribe/")) {
        (wss as any)._handleUpgrade(request, socket, head);
      } else {
        socket.destroy();
      }
    });

    shutdownManager = new GracefulShutdownManager({
      server,
      gracePeriodMs: config.shutdown.gracePeriodMs,
      logger: logger.info,
      forceExit: (code) => process.exit(code),
      dbPools: [pool, workerPool, replicaPool],
      redis: redisConnection,
      metrics: createShutdownMetrics(),
    });

    server.on("connection", (socket) => {
      shutdownManager?.trackConnection(socket);
    });

    installShutdownHandlers();

    // Graceful shutdown
    const shutdown = async (signal: string): Promise<void> => {
      logger.info(`Received ${signal}, shutting down gracefully...`)
      
      // Shutdown WebSocket server
      await shutdownWebSocketServer()
      
      // Close HTTP server
      server.close(() => {
        logger.info('HTTP server closed')
        process.exit(0)
      })
      
      // Force shutdown after 10 seconds
      setTimeout(() => {
        logger.error('Forced shutdown after timeout')
        process.exit(1)
      }, 10000)
    }

    process.on('SIGTERM', () => void shutdown('SIGTERM'))
    process.on('SIGINT', () => void shutdown('SIGINT'))

    if (process.env.DATABASE_URL) {
      const thresholdSeconds = Number(
        process.env.ANALYTICS_STALENESS_SECONDS ?? "300",
      );
      const analyticsService = new AnalyticsService(pool, thresholdSeconds);
      const metrics = createAnalyticsRefreshMetrics();
      const refreshWorker = new AnalyticsRefreshWorker(
        analyticsService,
        logger.info,
        metrics,
      );
      const intervalMs = getAnalyticsRefreshIntervalMs();

      const refreshScheduler = new AnalyticsRefreshScheduler(refreshWorker, {
        intervalMs,
        runOnStart: true,
        logger: logger.info,
        metrics,
      });

      const reconcilerJob = new SettlementReconciler(pool)
      const reconcilerScheduler = createScheduler(reconcilerJob, {
        cronExpression: '0 * * * *', // hourly
        runOnStart: false,
        logger: logger.info,
        lockKey: 'cron:settlement-reconciliation'
      })

      const impersonationCleanupScheduler = createScheduler({
        run: async () => {
          const removed = await impersonationService.cleanupExpiredTokens()
          return { removed }
        }
      }, {
        cronExpression: '0 * * * *', // hourly
        runOnStart: false,
        logger: logger.info,
        lockKey: 'cron:impersonation-cleanup'
      })

      refreshScheduler.start()
      reconcilerScheduler.start()
      impersonationCleanupScheduler.start()

      const failedInboundSweeperConfig = loadFailedInboundSweeperConfig()
      failedInboundSweeper = new FailedInboundEventsSweeper(pool, failedInboundSweeperConfig)
      failedInboundSweeper.start()

      scheduler = {
        stop() {
          refreshScheduler.stop()
          reconcilerScheduler.stop()
          impersonationCleanupScheduler.stop()
          failedInboundSweeper?.stop()
        },
        isJobRunning() {
          return refreshScheduler.isJobRunning() || reconcilerScheduler.isJobRunning()
        },
      } as any
    }

    // Start Outbox Publisher job if enabled
    if (config.outbox.enabled) {
      try {
        outboxJob = new OutboxJob(pool);
        await outboxJob.start();
        logger.info("[Main] Outbox Publisher started");
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        logger.error(`Failed to start Outbox Publisher: ${message}`, error);
      }
    }

    // Start Request Snapshots cleanup sweeper if enabled
    if (config.requestSnapshots.cleanupEnabled) {
      try {
        requestSnapshotsSweeper = new RequestSnapshotsSweeper(pool, {
          retentionDays: config.requestSnapshots.retentionDays,
          intervalMs: config.requestSnapshots.cleanupIntervalMs,
          logger: logger.info,
          onMetric: (metric) => {
            // TODO: integrate with metrics system (Prometheus, etc.)
            logger.info(`[Metrics] ${metric.name}=${metric.value}`);
          },
        });
        requestSnapshotsSweeper.start();
        logger.info("[Main] Request Snapshots Sweeper started");
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        logger.error(`Failed to start Request Snapshots Sweeper: ${message}`, error);
      }
    }

    // Start cache invalidation bus
    try {
      invalidationBus = getInvalidationBus();
      await invalidationBus.start();
      logger.info("[Main] Cache invalidation bus started");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      logger.error(`Failed to start cache invalidation bus: ${message}`, error);
    }

    shutdownManager?.setScheduler(scheduler);
    shutdownManager?.setOutboxJob(outboxJob);
    shutdownManager?.setWss(wss);
    shutdownManager?.setInvalidationBus(invalidationBus);

    // Stop sweepers on shutdown
    const originalShutdown = shutdownManager?.shutdown.bind(shutdownManager);
    if (shutdownManager && originalShutdown) {
      shutdownManager.shutdown = async (signal?: string) => {
        if (requestSnapshotsSweeper) {
          logger.info("[Main] Stopping Request Snapshots Sweeper");
          requestSnapshotsSweeper.stop();
        }
        return originalShutdown(signal ?? "SIGTERM");
      };
    }
  } catch (error) {
    logger.error("Failed to start Credence API:", error);
    process.exit(1);
  }
}

export async function shutdown(signal = "SIGTERM"): Promise<void> {
  await shutdownManager?.shutdown(signal);
}
