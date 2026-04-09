import type { HealthProbe } from "./types.js";

/** Default timeout (ms) for each dependency check to avoid hanging. */
const CHECK_TIMEOUT_MS = 5000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), ms),
    ),
  ]);
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
  const url = process.env.DATABASE_URL;
  if (!url && !options.runQuery) return undefined;

  let pool: import("pg").Pool | null = null;

  return async () => {
    try {
      if (options.runQuery) {
        await withTimeout(options.runQuery(), CHECK_TIMEOUT_MS);
        return { status: "up" };
      }
      if (!pool) {
        const pg = (await import("pg")).default;
        pool = new pg.Pool({ connectionString: url });
      }
      await withTimeout(pool.query("SELECT 1"), CHECK_TIMEOUT_MS);
      return { status: "up" };
    } catch {
      return { status: "down" };
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

  let client: {
    ping: () => Promise<string>;
    quit: () => Promise<string>;
  } | null = null;

  return async () => {
    try {
      if (options.ping) {
        await withTimeout(options.ping(), CHECK_TIMEOUT_MS);
        return { status: "up" };
      }
      if (!client) {
        const ioredis = await import("ioredis");
        const Redis = ioredis.default as any;
        client = new Redis(url!, { maxRetriesPerRequest: 1 });
      }
      await withTimeout(client!.ping(), CHECK_TIMEOUT_MS);
      return { status: "up" };
    } catch {
      return { status: "down" };
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

/**
 * Optional gateway (e.g. Horizon/contract) probe.
 * When provided, failure is reported as degraded, not unhealthy.
 */
export function createGatewayProbe(
  check?: () => Promise<boolean>,
): HealthProbe | undefined {
  if (!check) return undefined;
  
  return async () => {
    try {
      const ok = await withTimeout(check(), CHECK_TIMEOUT_MS);
      return { status: ok ? "up" : "down" };
    } catch {
      return { status: "down" };
    }
  };
}

/**
 * Builds default probes from environment (DATABASE_URL, REDIS_URL, QUEUE_URL).
 * When not configured, skips that probe (reported as not_configured).
 */
export function createDefaultProbes(): {
  db?: HealthProbe;
  cache?: HealthProbe;
  queue?: HealthProbe;
  gateway?: HealthProbe;
} {
  const out: { db?: HealthProbe; cache?: HealthProbe; queue?: HealthProbe; gateway?: HealthProbe } =
    {};
  if (process.env.DATABASE_URL) out.db = createDbProbe();
  if (process.env.REDIS_URL) out.cache = createCacheProbe();
  if (process.env.QUEUE_URL) out.queue = createQueueProbe();
  // Gateway could have a default check if GATEWAY_URL is provided, but currently it's externally provided
  if (process.env.GATEWAY_URL) {
    out.gateway = createGatewayProbe(async () => {
      const res = await fetch(process.env.GATEWAY_URL!);
      return res.ok;
    });
  }
  return out;
}
