import "dotenv/config";
import http from "http";
import { initTracing } from "./tracing/tracer.js";
import app from "./app.js";
import { createAdminRouter } from "./routes/admin/index.js";
import governanceRouter from "./routes/governance.js";
import disputesRouter from "./routes/disputes.js";
import evidenceRouter from "./routes/evidence.js";
import { loadConfig } from "./config/index.js";
import { pool, workerPool, replicaPool } from "./db/pool.js";
import {
  validateMigrationChecksums,
  resolveMigrationsDir,
} from "./migrations/index.js";
import { redisConnection } from "./cache/redis.js";
import { createShutdownMetrics } from "./observability/shutdownMetrics.js";
import { AnalyticsService } from "./services/analytics/service.js";
import { createAnalyticsRefreshWorker } from "./jobs/analyticsRefreshWorker.js";
import { AnalyticsRefreshScheduler } from "./jobs/analyticsRefreshScheduler.js";
import { createAnalyticsRefreshMetrics } from "./jobs/analyticsRefreshMetrics.js";
import { SettlementReconciler } from "./jobs/settlementReconciler.js";
import { createScheduler } from "./jobs/scheduler.js";
import { keyManager } from "./services/keyManager/index.js";
import { initializeAuth } from "./lifecycle.js";
import { KeyRotationScheduler } from "./jobs/keyRotationScheduler.js";
import { validateConfig } from "./config/index.js";
import { GracefulShutdownManager } from "./gracefulShutdown.js";
import { FailedInboundEventsSweeper } from "./jobs/failedInboundEventsSweeper.js";
import { PgStatActivitySnapshotJob } from "./jobs/pgStatActivitySnapshotJob.js";
import {
  LongTransactionReaper,
  loadLongTransactionReaperConfig,
  registerLongTransactionReaperMetrics,
} from "./jobs/longTransactionReaper.js";
import { loadFailedInboundSweeperConfig } from "./config/retention.js";
import { getInvalidationBus } from "./cache/index.js";
import { createWsSubscriptionServer } from "./routes/ws.js";
import { impersonationService } from "./services/impersonation/index.js";
import { recordOomEvent, register } from "./middleware/metrics.js";
import { logger } from "./utils/logger.js";

// Outbox imports
import { OutboxJob } from "./jobs/outbox.js";
import { RequestSnapshotsSweeper } from "./jobs/requestSnapshotsSweeper.js";
import { IdempotencyKeySweeper } from "./jobs/idempotencyKeySweeper.js";
import { ExpiredSessionsSweeper } from "./jobs/expiredSessionsSweeper.js";
import { WebhookDlqProcessor } from "./jobs/webhookDlqProcessor.js";

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
let pgStatActivitySnapshotJob: PgStatActivitySnapshotJob | null = null;
let longTransactionReaper: LongTransactionReaper | null = null;
let shutdownManager: GracefulShutdownManager | null = null;
let wss: ReturnType<typeof createWsSubscriptionServer> | null = null;
let invalidationBus: ReturnType<typeof getInvalidationBus> | null = null;
let requestSnapshotsSweeper: RequestSnapshotsSweeper | null = null;
let idempotencyKeySweeper: IdempotencyKeySweeper | null = null;
let expiredSessionsSweeper: ExpiredSessionsSweeper | null = null;
let keyRotationScheduler: KeyRotationScheduler | null = null;
let webhookDlqProcessor: WebhookDlqProcessor | null = null;

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
  process.on("uncaughtException", (err) => {
    logger.error("Uncaught Exception:", err);
    if (
      err.message.includes("heap out of memory") ||
      err.name === "JavaScript heap out of memory"
    ) {
      recordOomEvent();
    }
    // Let the process exit after logging
    process.exit(1);
  });

  process.on("unhandledRejection", (reason, promise) => {
    logger.error(
      `Unhandled Rejection at: ${promise} reason: ${reason}`,
      reason instanceof Error ? reason : undefined,
    );
    if (
      reason instanceof Error &&
      (reason.message.includes("heap out of memory") ||
        reason.name === "JavaScript heap out of memory")
    ) {
      recordOomEvent();
    }
  });

  try {
    const config = loadConfig();

    if (process.env.MIGRATION_CHECKSUM_VALIDATE !== "false") {
      const bootstrapMissing = process.env.MIGRATION_CHECKSUM_BOOTSTRAP !== "false";
      try {
        const checksumResult = await validateMigrationChecksums(
          pool,
          {
            migrationsDir: resolveMigrationsDir(),
            migrationsTable: process.env.MIGRATIONS_TABLE ?? "pgmigrations",
            migrationsSchema: process.env.MIGRATIONS_SCHEMA ?? "public",
          },
          { bootstrapMissing },
        );
        if (checksumResult.bootstrapped.length > 0) {
          logger.info(
            `[Main] Bootstrapped migration checksums for: ${checksumResult.bootstrapped.join(", ")}`,
          );
        }
      } catch (checksumErr) {
        logger.error(
          `[Main] Aborting startup — migration checksum validation failed: ${
            checksumErr instanceof Error ? checksumErr.message : String(checksumErr)
          }`,
          checksumErr,
        );
        process.exit(1);
      }
    }

    // Bootstrap the JWT signing key BEFORE accepting traffic so the
    // `/.well-known/jwks.json` endpoint and JWT signing respond with
    // real data from the first request. Failure is fatal.
    await initializeAuth().catch((bootstrapErr) => {
      logger.error(
        `[Main] Aborting startup — KeyManager bootstrap failed: ${
          bootstrapErr instanceof Error ? bootstrapErr.message : String(bootstrapErr)
        }`,
        bootstrapErr,
      );
      process.exit(1);
    });

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

    if (process.env.DATABASE_URL) {
      const analyticsConfig = config.analyticsRefresh;
      const thresholdSeconds = Number(
        process.env.ANALYTICS_STALENESS_SECONDS ?? "300",
      );
      const analyticsService = new AnalyticsService(pool, thresholdSeconds);
      const metrics = createAnalyticsRefreshMetrics();

      // The refresh worker uses the workerPool so background refresh
      // traffic never starves the API/replica pools of connections.
      const refreshWorker = createAnalyticsRefreshWorker({
        pool: workerPool,
        maxAttemptsPerView: analyticsConfig.maxAttemptsPerView,
        retryBackoffMs: analyticsConfig.retryBackoffMs,
        metrics,
        logger: logger.info,
      });

      const refreshScheduler = new AnalyticsRefreshScheduler(refreshWorker, {
        intervalMs: analyticsConfig.intervalMs,
        runOnStart: analyticsConfig.enabled,
        logger: logger.info,
        metrics,
        lockTtlMs: analyticsConfig.lockTtlMs,
        failCooldownThreshold: analyticsConfig.failCooldownThreshold,
        failCooldownMs: analyticsConfig.failCooldownMs,
      });
      if (!analyticsConfig.enabled) {
        logger.info(
          "[Main] Analytics refresh is disabled by config (ANALYTICS_REFRESH_ENABLED=false)",
        );
      }

      const reconcilerJob = new SettlementReconciler(pool);
      const reconcilerScheduler = createScheduler(reconcilerJob, {
        cronExpression: "0 * * * *", // hourly
        runOnStart: false,
        logger: logger.info,
        lockKey: "cron:settlement-reconciliation",
      });

      const impersonationCleanupScheduler = createScheduler(
        {
          run: async () => {
            const removed = await impersonationService.cleanupExpiredTokens();
            return { removed };
          },
        },
        {
          cronExpression: "0 * * * *", // hourly
          runOnStart: false,
          logger: logger.info,
          lockKey: "cron:impersonation-cleanup",
        },
      );

      refreshScheduler.start();
      reconcilerScheduler.start();
      impersonationCleanupScheduler.start();

      const failedInboundSweeperConfig = loadFailedInboundSweeperConfig();
      failedInboundSweeper = new FailedInboundEventsSweeper(
        pool,
        failedInboundSweeperConfig,
      );
      failedInboundSweeper.start();

      pgStatActivitySnapshotJob = new PgStatActivitySnapshotJob(pool, {
        logger: logger.info,
      });
      pgStatActivitySnapshotJob.start();

      scheduler = {
        stop() {
          refreshScheduler.stop();
          reconcilerScheduler.stop();
          impersonationCleanupScheduler.stop();
          failedInboundSweeper?.stop();
          pgStatActivitySnapshotJob?.stop();
        },
        isJobRunning() {
          return (
            refreshScheduler.isJobRunning() ||
            reconcilerScheduler.isJobRunning()
          );
        },
      } as any;
    }

    // Start Outbox Publisher job if enabled
    if (config.outbox.enabled) {
      try {
        outboxJob = new OutboxJob(pool, {
          leaderLease: {
            enabled: config.outbox.leaderLease.enabled,
            retryIntervalMs: config.outbox.leaderLease.retryIntervalMs,
            heartbeatIntervalMs: config.outbox.leaderLease.heartbeatIntervalMs,
          },
        });
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
        logger.error(
          `Failed to start Request Snapshots Sweeper: ${message}`,
          error,
        );
      }
    }

    // Start Idempotency Key sweeper
    try {
      idempotencyKeySweeper = new IdempotencyKeySweeper(pool, {
        intervalMs: config.idempotency.sweeperIntervalMs,
        logger: logger.info,
      });
      idempotencyKeySweeper.start();
      logger.info("[Main] Idempotency Key Sweeper started");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error(`Failed to start Idempotency Key Sweeper: ${message}`, error);
    }

    // Start Expired Sessions sweeper
    try {
      expiredSessionsSweeper = new ExpiredSessionsSweeper(pool, {
        intervalMs: config.sessionSweep.sweepIntervalMs,
        logger: logger.info,
      });
      expiredSessionsSweeper.start();
      logger.info("[Main] Expired Sessions Sweeper started");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error(`Failed to start Expired Sessions Sweeper: ${message}`, error);
    }

    // Start Long Transaction Reaper (kills backends holding a transaction
    // open past DB_LONG_TRANSACTION_MAX_AGE_MS to prevent lock/pool hold-off
    // cascades; see src/jobs/longTransactionReaper.ts)
    try {
      const longTransactionReaperConfig = loadLongTransactionReaperConfig();
      if (longTransactionReaperConfig.enabled) {
        registerLongTransactionReaperMetrics(register);
        longTransactionReaper = new LongTransactionReaper(pool, {
          ...longTransactionReaperConfig,
          logger: logger.info,
        });
        longTransactionReaper.start();
        logger.info("[Main] Long Transaction Reaper started");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error(`Failed to start Long Transaction Reaper: ${message}`, error);
    }

    // Start cache invalidation bus
    try {
      invalidationBus = getInvalidationBus();
      await invalidationBus.start();
      logger.info("[Main] Cache invalidation bus started");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error(`Failed to start cache invalidation bus: ${message}`, error);
    }

    // Start Webhook DLQ Processor — promotes permanently-failed outbox webhook
    // events into the webhook_dlq table so operators can replay them.
    if (process.env.DATABASE_URL) {
      try {
        webhookDlqProcessor = new WebhookDlqProcessor(pool, {
          intervalMs: parseInt(process.env.WEBHOOK_DLQ_INTERVAL_MS ?? "60000", 10),
          batchSize: parseInt(process.env.WEBHOOK_DLQ_BATCH_SIZE ?? "200", 10),
          logger: logger.info,
        });
        webhookDlqProcessor.start();
        logger.info("[Main] Webhook DLQ Processor started");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        logger.error(`Failed to start Webhook DLQ Processor: ${message}`, error);
      }
    }
    // Start JWT signing-key rotation scheduler.
    // Rotation interval is configurable (KEY_ROTATION_INTERVAL_SECONDS, default 24h).
    // The pruning tick is hourly so retired keys are GC'd even if rotation halts.
    try {
      const jwtConfig = validateConfig(process.env).jwt;
      const rotationIntervalMs = jwtConfig.keyRotationIntervalSeconds * 1000;
      keyRotationScheduler = new KeyRotationScheduler({
        rotationIntervalMs,
        pruneIntervalMs: 60 * 60 * 1000,
        logger: logger.info,
      });
      keyRotationScheduler.start();
      logger.info(
        `[Main] Key Rotation Scheduler started (rotate every ${jwtConfig.keyRotationIntervalSeconds}s, prune every 3600s)`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error(`Failed to start Key Rotation Scheduler: ${message}`, error);
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
        if (expiredSessionsSweeper) {
          logger.info("[Main] Stopping Expired Sessions Sweeper");
          expiredSessionsSweeper.stop();
        }
        if (pgStatActivitySnapshotJob) {
          logger.info("[Main] Stopping pg_stat_activity Snapshot Job");
          pgStatActivitySnapshotJob.stop();
        }
        if (longTransactionReaper) {
          logger.info("[Main] Stopping Long Transaction Reaper");
          longTransactionReaper.stop();
        }
        if (keyRotationScheduler) {
          logger.info("[Main] Stopping Key Rotation Scheduler");
          keyRotationScheduler.stop();
        }
        if (webhookDlqProcessor) {
          logger.info("[Main] Stopping Webhook DLQ Processor");
          webhookDlqProcessor.stop();
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
