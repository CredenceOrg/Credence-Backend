import type { HealthProbe, DependencyHealth, DependencyReason } from "./types.js";
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
import { keyManager } from "../../services/keyManager/index.js";
import { kekManager } from "../../services/keyManager/index.js";

/** Default timeout (ms) for each dependency check to avoid hanging. */
const DEFAULT_CHECK_TIMEOUT_MS = 5000;
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
 * Classifies an arbitrary error into a stable `DependencyReason`.
 * Falls back to `'error'` for anything we don't recognise.
 */
function classifyError(err: unknown): DependencyReason {
  if (err instanceof Error && err.message === "timeout") return "timeout"
  if (err instanceof Error) {
    const msg = err.message.toLowerCase()
    if (msg.includes("refused") || msg.includes("econnrefused")) return "connection_refused"
    if (msg.includes("not_initialized") || msg.includes("not initialized")) return "not_initialized"
  }
  return "error"
}

/**
 * Like classifyError but used inside the Horizon circuit-breaker probe where
 * any unexpected exception indicates the RPC endpoint is unreachable.
 */
function classifyHorizonError(_err: unknown): DependencyReason {
  if (_err instanceof Error && _err.message === "timeout") return "timeout"
  return "unreachable"
}

/**
 * Options for createDbProbe (for testing: inject a custom check).
 */
export interface DbProbeOptions {
  /** When set (e.g. in tests), used instead of real DB; throw to simulate down. */
  runQuery?: () => Promise<unknown>
  /** Per-probe timeout override (ms). Defaults to 5 s. */
  timeoutMs?: number
}

/**
 * Creates a DB health probe.
 *
 * Always returns a probe (never `undefined`).  When `DB_URL` is not set and
 * no `runQuery` override is injected the probe returns `{ status: 'down',
 * reason: 'not_configured' }` so that the readiness endpoint fails closed
 * rather than silently degrading.
 */
export function createDbProbe(
  options: DbProbeOptions = {},
): HealthProbe {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS

  return async () => {
    const start = Date.now();

    // Fail closed: no DB URL means the service is mis-configured and cannot
    // serve traffic safely.
    if (!process.env.DB_URL && !options.runQuery) {
      return { status: 'down', reason: 'not_configured' };
    }

    try {
      if (options.runQuery) {
        await withTimeout(options.runQuery(), timeoutMs);
      } else {
        await withTimeout(pool.query("SELECT 1"), timeoutMs);
      }
      return { status: "up", latencyMs: elapsed(start) };
    } catch (err) {
      return { status: "down", reason: classifyError(err), latencyMs: elapsed(start) };
    }
  };
}

/**
 * Options for generic Redis-based probe (for testing: inject a custom check).
 */
export interface RedisProbeOptions {
  /** When set (e.g. in tests), used instead of real Redis; throw to simulate down. */
  ping?: () => Promise<unknown>
  /** Per-probe timeout override (ms). Defaults to 5 s. */
  timeoutMs?: number
}

/**
 * Creates a generic Redis health probe for a given environment variable URL.
 *
 * Always returns a probe (never `undefined`).  When the URL env var is not set
 * and no `ping` override is injected the probe returns `{ status: 'down',
 * reason: 'not_configured' }` so that the readiness endpoint fails closed.
 */
function createGenericRedisProbe(
  urlEnvVar: string,
  options: RedisProbeOptions = {},
): HealthProbe {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS

  return async () => {
    const start = Date.now();

    if (!process.env[urlEnvVar] && !options.ping) {
      return { status: 'down', reason: 'not_configured' };
    }

    try {
      if (options.ping) {
        await withTimeout(options.ping(), timeoutMs);
        return { status: "up", latencyMs: elapsed(start) };
      }

      const redis = RedisConnection.getInstance();
      await withTimeout(redis.connect(), timeoutMs);
      const healthy = await withTimeout(redis.isHealthy(), timeoutMs);
      if (!healthy) {
        return { status: "down", reason: "connection_refused", latencyMs: elapsed(start) };
      }
      return { status: "up", latencyMs: elapsed(start) };
    } catch (err) {
      return { status: "down", reason: classifyError(err), latencyMs: elapsed(start) };
    }
  };
}

/**
 * Creates a Cache health probe.
 *
 * Always returns a probe (never `undefined`).  Reports `down /
 * not_configured` when `REDIS_URL` is absent so the readiness probe fails
 * closed rather than silently degrading.
 */
export function createCacheProbe(
  options: RedisProbeOptions = {},
): HealthProbe {
  return createGenericRedisProbe("REDIS_URL", options);
}

/**
 * Creates a Queue health probe when QUEUE_URL is set.
 * This probe is optional; returns `undefined` when the env var is absent
 * and no ping override is provided (queue is not a critical dependency).
 */
export function createQueueProbe(
  options: RedisProbeOptions = {},
): HealthProbe | undefined {
  const url = process.env.QUEUE_URL;
  if (!url && !options.ping) return undefined;
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
  return async (): Promise<DependencyHealth> => {
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
        reason: "lag_exceeded",
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
  getState?: () => string
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
      return { status: 'down', reason: classifyHorizonError(err), latencyMs: elapsed(start) };
    }
  };
}

/**
 * Options for `createKeyManagerProbe` (for testing).
 */
export interface KeyManagerProbeOptions {
  /** Inject a custom liveness check (e.g. a fake KeyManager). */
  isInitialized?: () => boolean
}

/**
 * Probes the JWT signing-key manager.  Reports `not_initialized` when
 * the singleton has not yet bootstrapped an active key — which means
 * the service cannot sign or verify JWTs until the next restart /
 * successful `initializeAuth()` call.
 */
export function createKeyManagerProbe(
  options: KeyManagerProbeOptions = {},
): HealthProbe {
  const isInitialized = options.isInitialized ?? (() => keyManager.isInitialized())
  return async () => {
    const start = Date.now()
    try {
      if (!isInitialized()) {
        return {
          status: "down",
          reason: "not_initialized",
          latencyMs: elapsed(start),
        }
      }
      return { status: "up", latencyMs: elapsed(start) }
    } catch (err) {
      return { status: "down", reason: classifyError(err), latencyMs: elapsed(start) }
    }
  }
}

/**
 * Options for `createKekProbe` (for testing).
 */
export interface KekProbeOptions {
  /** Inject a custom KEK liveness check (e.g. a fake KekManager). */
  getCurrentVersion?: () => number | null
}

/**
 * Probes the KEK (Key Encryption Key) manager used for envelope
 * encryption of evidence-at-rest.  Reports `not_initialized` when
 * there is no registered active KEK version — which means evidence
 * write paths cannot encrypt new data.
 */
export function createKekProbe(options: KekProbeOptions = {}): HealthProbe {
  const getCurrentVersion =
    options.getCurrentVersion ?? (() => {
      try {
        return kekManager.getCurrentKek().version
      } catch {
        return null
      }
    })
  return async () => {
    const start = Date.now()
    try {
      const version = getCurrentVersion()
      if (version === null || version === undefined) {
        return {
          status: "down",
          reason: "not_initialized",
          latencyMs: elapsed(start),
        }
      }
      return {
        status: "up",
        latencyMs: elapsed(start),
        details: { activeVersion: version },
      }
    } catch (err) {
      return { status: "down", reason: classifyError(err), latencyMs: elapsed(start) }
    }
  }
}

/**
 * Builds default probes from environment and runtime worker state.
 *
 * Critical probes (postgres, redis, horizonListener) are **always** registered
 * so that missing env vars cause a fail-closed `unhealthy` response rather than
 * a silent `degraded`.  Optional probes are registered only when their
 * respective env vars are present.
 */
export function createDefaultProbes(): {
  postgres: HealthProbe
  redis: HealthProbe
  horizonListener: HealthProbe
  outboxPublisher?: HealthProbe
  horizon?: HealthProbe
  keyManager?: HealthProbe
  kek?: HealthProbe
} {
  // Critical deps — always present; probe returns down/not_configured when
  // the env var is missing.
  const postgres = createDbProbe()
  const redis = createCacheProbe()

  // horizonListener heartbeat tracking — configured flag drives the probe result.
  setHorizonListenerConfigured(Boolean(process.env.HORIZON_URL))
  const horizonListener = createHorizonListenerProbe()

  const out: {
    postgres: HealthProbe
    redis: HealthProbe
    horizonListener: HealthProbe
    outboxPublisher?: HealthProbe
    horizon?: HealthProbe
    keyManager?: HealthProbe
    kek?: HealthProbe
  } = { postgres, redis, horizonListener }

  const outboxEnabled = (process.env.OUTBOX_ENABLED ?? "true") === "true"
  setOutboxPublisherConfigured(outboxEnabled)
  out.outboxPublisher = createOutboxPublisherProbe()

  const horizonProbe = createHorizonClientProbe()
  if (horizonProbe) out.horizon = horizonProbe

  // JWT signing-key manager is always relevant in this service — register
  // unconditionally.  Reports `not_initialized` if the bootstrap hasn't run.
  out.keyManager = createKeyManagerProbe()

  // KEK (evidence encryption) is only relevant when the encryption key
  // env var is configured.  Otherwise leave it off so the response stays
  // clean for deployments that don't use envelope encryption.
  if (process.env.EVIDENCE_ENCRYPTION_KEY) {
    out.kek = createKekProbe()
  }

  return out
}