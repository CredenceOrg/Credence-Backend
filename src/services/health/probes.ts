import type { HealthProbe } from "./types.js";
import { pool } from "../../db/pool.js";
import { RedisConnection } from "../../cache/redis.js";
import { getCircuitBreaker } from "../../clients/circuitBreaker.js";
import {
  getHorizonListenerState,
  getOutboxPublisherState,
  setHorizonListenerConfigured,
  setOutboxPublisherConfigured,
} from "./runtimeState.js";
import { evaluateOutboxPublisherLag } from "./outbox.js";
import { OUTBOX_MAX_LAG_SECONDS } from "../../config/constants.js";

/** Default timeout (ms) for each dependency check to avoid hanging. */
const CHECK_TIMEOUT_MS = 5000;
const WORKER_HEARTBEAT_STALE_MS = Number(
  process.env.HEALTH_WORKER_STALE_MS ?? "60000",
);

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), ms),
    ),
  ]);
}

function elapsed(start: number): number {
  return Date.now() - start;
}

/**
 * Options for createDbProbe (for testing: inject a custom check).
 */
export interface DbProbeOptions {
  /** When set (e.g. in tests), used instead of real DB; throw to simulate down. */
  runQuery?: () => Promise<unknown>;
}

/**
 * Creates a DB health probe when DATABASE_URL is set.
 * Uses pg Pool; runs a simple query. Does not expose errors.
 */
export function createDbProbe(
  options: DbProbeOptions = {},
): HealthProbe | undefined {
  if (!process.env.DB_URL && !options.runQuery) return undefined;

  return async () => {
    const start = Date.now();
    try {
      if (options.runQuery) {
        await withTimeout(options.runQuery(), CHECK_TIMEOUT_MS);
      } else {
        await withTimeout(pool.query("SELECT 1"), CHECK_TIMEOUT_MS);
      }
      return { status: "up", latencyMs: elapsed(start) };
    } catch (err) {
      const reason =
        err instanceof Error && err.message === "timeout"
          ? "timeout"
          : "connection_refused";
      return { status: "down", reason, latencyMs: elapsed(start) };
    }
  };
}

/**
 * Options for generic Redis-based probe (for testing: inject a custom check).
 */
export interface RedisProbeOptions {
  /** When set (e.g. in tests), used instead of real Redis; throw to simulate down. */
  ping?: () => Promise<unknown>;
}

/**
 * Creates a generic Redis health probe for a given environment variable URL.
 * Uses ioredis PING. Does not expose errors.
 */
function createGenericRedisProbe(
  urlEnvVar: string,
  options: RedisProbeOptions = {},
): HealthProbe | undefined {
  const url = process.env[urlEnvVar];
  if (!url && !options.ping) return undefined;

  return async () => {
    const start = Date.now();
    try {
      if (options.ping) {
        await withTimeout(options.ping(), CHECK_TIMEOUT_MS);
        return { status: "up", latencyMs: elapsed(start) };
      }

      const redis = RedisConnection.getInstance();
      await withTimeout(redis.connect(), CHECK_TIMEOUT_MS);
      const healthy = await withTimeout(redis.isHealthy(), CHECK_TIMEOUT_MS);
      if (!healthy) {
        return { status: "down", reason: "connection_refused", latencyMs: elapsed(start) };
      }
      return { status: "up", latencyMs: elapsed(start) };
    } catch (err) {
      const reason =
        err instanceof Error && err.message === "timeout"
          ? "timeout"
          : "connection_refused";
      return { status: "down", reason, latencyMs: elapsed(start) };
    }
  };
}

/**
 * Creates a Cache health probe when REDIS_URL is set.
 */
export function createCacheProbe(
  options: RedisProbeOptions = {},
): HealthProbe | undefined {
  return createGenericRedisProbe("REDIS_URL", options);
}

/**
 * Creates a Queue health probe when QUEUE_URL is set.
 */
export function createQueueProbe(
  options: RedisProbeOptions = {},
): HealthProbe | undefined {
  return createGenericRedisProbe("QUEUE_URL", options);
}

export function createHorizonListenerProbe(
  maxStaleMs: number = WORKER_HEARTBEAT_STALE_MS,
): HealthProbe {
  return async () => {
    const start = Date.now();
    const state = getHorizonListenerState();
    if (!state.configured) {
      return { status: "not_configured" };
    }
    if (!state.running) {
      return { status: "down", reason: "not_running", latencyMs: elapsed(start) };
    }
    if (state.lastHeartbeatAt === null) {
      return { status: "down", reason: "no_heartbeat", latencyMs: elapsed(start) };
    }

    const ageMs = Date.now() - state.lastHeartbeatAt;
    if (ageMs > maxStaleMs) {
      return {
        status: "down",
        reason: "stale_heartbeat",
        latencyMs: elapsed(start),
        details: {
          heartbeatAgeMs: ageMs,
          maxHeartbeatAgeMs: maxStaleMs,
          lastCursor: state.lastCursor,
        },
      };
    }

    return {
      status: "up",
      latencyMs: elapsed(start),
      details: {
        heartbeatAgeMs: ageMs,
        maxHeartbeatAgeMs: maxStaleMs,
        lastCursor: state.lastCursor,
      },
    };
  };
}

export function createOutboxPublisherProbe(
  maxStaleMs: number = WORKER_HEARTBEAT_STALE_MS,
): HealthProbe {
  return async () => {
    const start = Date.now();
    const state = getOutboxPublisherState();
    if (!state.configured) {
      return { status: "not_configured" };
    }
    if (!state.running) {
      return { status: "down", reason: "not_running", latencyMs: elapsed(start), lagSeconds: 0 };
    }
    if (state.lastHeartbeatAt === null) {
      return { status: "down", reason: "no_heartbeat", latencyMs: elapsed(start), lagSeconds: 0 };
    }

    const ageMs = Date.now() - state.lastHeartbeatAt;
    const lagResult = await evaluateOutboxPublisherLag(pool);
    if (ageMs > maxStaleMs) {
      return {
        status: "down",
        reason: "stale_heartbeat",
        latencyMs: elapsed(start),
        lagSeconds: lagResult.lagSeconds,
        details: {
          heartbeatAgeMs: ageMs,
          maxHeartbeatAgeMs: maxStaleMs,
        },
      };
    }

    if (lagResult.status === "down") {
      return {
        status: "down",
        latencyMs: elapsed(start),
        lagSeconds: lagResult.lagSeconds,
        details: {
          maxLagSeconds: OUTBOX_MAX_LAG_SECONDS,
        },
      };
    }

    return {
      status: "up",
      latencyMs: elapsed(start),
      lagSeconds: lagResult.lagSeconds,
      details: {
        heartbeatAgeMs: ageMs,
        maxHeartbeatAgeMs: maxStaleMs,
      },
    };
  };
}

/**
 * Options for the Horizon/Soroban circuit breaker probe (for testing).
 */
export interface HorizonClientProbeOptions {
  /** Inject a state getter for testing; returns the breaker state string. */
  getState?: () => string;
}

/**
 * Creates a Horizon/Soroban reachability probe using the circuit breaker state.
 * Reports 'down' when the breaker is OPEN (repeated failures to the RPC endpoint).
 * Reports 'not_configured' when HORIZON_URL is absent.
 */
export function createHorizonClientProbe(
  options: HorizonClientProbeOptions = {},
): HealthProbe | undefined {
  const horizonUrl = process.env.HORIZON_URL;
  if (!horizonUrl && !options.getState) return undefined;

  return async () => {
    const start = Date.now();
    try {
      let state: string;
      if (options.getState) {
        state = options.getState();
      } else {
        const host = new URL(horizonUrl!).host;
        const breaker = getCircuitBreaker(host, {
          failureThreshold: 5,
          openWindowMs: 10_000,
          halfOpenAfterMs: 30_000,
        });
        state = breaker.getState();
      }

      if (state === 'OPEN') {
        return { status: 'down', reason: 'circuit_open', latencyMs: elapsed(start) };
      }
      return {
        status: 'up',
        latencyMs: elapsed(start),
        details: { circuitState: state },
      };
    } catch (err) {
      return { status: 'down', reason: 'unreachable', latencyMs: elapsed(start) };
    }
  };
}

/**
 * Builds default probes from environment and runtime worker state.
 * When not configured, skips that probe (reported as not_configured).
 */
export function createDefaultProbes(): {
  postgres?: HealthProbe;
  redis?: HealthProbe;
  horizonListener?: HealthProbe;
  outboxPublisher?: HealthProbe;
  horizon?: HealthProbe;
} {
  const out: {
    postgres?: HealthProbe;
    redis?: HealthProbe;
    horizonListener?: HealthProbe;
    outboxPublisher?: HealthProbe;
    horizon?: HealthProbe;
  } = {};

  if (process.env.DB_URL) out.postgres = createDbProbe();
  if (process.env.REDIS_URL) out.redis = createCacheProbe();

  setHorizonListenerConfigured(Boolean(process.env.HORIZON_URL));
  out.horizonListener = createHorizonListenerProbe();

  const outboxEnabled = (process.env.OUTBOX_ENABLED ?? "true") === "true";
  setOutboxPublisherConfigured(outboxEnabled);
  out.outboxPublisher = createOutboxPublisherProbe();

  const horizonProbe = createHorizonClientProbe();
  if (horizonProbe) out.horizon = horizonProbe;

  return out;
}
