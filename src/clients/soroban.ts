import {
  getBackoffDelayMs,
  type ProviderRetryPolicies,
  type RetryPolicy,
} from "../lib/retryPolicy.js";
import {
  executeWithRetry,
  resolveExtendedProviderRetryPolicy,
  type ExtendedRetryPolicy,
} from "./retryExecutor.js";
import {
  executeSorobanOperation,
  createMetricsAdapter,
  TimeoutExceededError,
} from "../lib/timeoutExecutor.js";
import { createDefaultMetricsCollector } from "../observability/timeoutMetrics.js";
import { normalizeTransportError } from "./httpErrors.js";
import { isRetryableRpcCode } from "../utils/retryClassifier.js";
import { logger } from "../utils/logger.js";
import {
  noopRetryObserver,
  type RetryObserver,
} from "../observability/retryMetrics.js";
import { recordDownstreamRpcLatency } from "../observability/rpcLatencyMetrics.js";
import { resolveTimeout, createTimeoutConfig } from "../lib/timeouts.js";
import { validateConfig } from "../config/index.js";
import { getCircuitBreaker } from "./circuitBreaker.js";
import {
  SorobanStateCache,
  createSorobanStateCache,
  type SorobanStateCacheOptions,
} from "./sorobanStateCache.js";

export type SorobanNetwork = "testnet" | "mainnet";

export type RetryOptions = RetryPolicy;

export interface SorobanClientConfig {
  rpcUrl: string;
  network: SorobanNetwork;
  contractId: string;
  /** Maximum number of events accepted from one getEvents response. */
  maxEventsPerPage?: number;
  timeoutMs?: number;
  retry?: Partial<RetryOptions>;
  retryPolicies?: ProviderRetryPolicies;
  circuitBreaker?: {
    failureThreshold?: number
    /**
     * Duration in milliseconds the breaker stays OPEN (fail-fast) after
     * tripping. Default: 10 000 ms (10 s).
     */
    openWindowMs?: number
    /**
     * Duration in milliseconds after tripping before a probe is allowed.
     * Default: 30 000 ms (30 s).
     */
    halfOpenAfterMs?: number
    /**
     * @deprecated Use `halfOpenAfterMs` instead.
     * Accepted for backwards compatibility; maps to `halfOpenAfterMs` when
     * the new field is absent.
     */
    cooldownPeriodMs?: number
  }
  /**
   * TTL in milliseconds for the getIdentityState() read-through cache.
   * Set to 0 to disable caching. When omitted the value is read from
   * SOROBAN_STATE_CACHE_TTL_MS in the environment (default: 5000 ms).
   */
  cacheTtlMs?: number;
}

export interface ContractEvent {
  id?: string;
  type?: string;
  ledger?: number;
  topic?: string[];
  value?: unknown;
  [key: string]: unknown;
  /**
   * Added for #1268 Horizon ingestion and reconciliation: storage and migration compatibility
   * Preserves backward compatibility and resumes migrations observables.
   */
  _migrationVersion?: number;
}

/**
 * A page of contract-scoped events together with deterministic pagination
 * metadata.
 *
 * The response shape is backward compatible: `events` and `cursor` retain
 * their historical meaning. The additional `hasNextPage`, `seq`, and `limit`
 * fields make ordering, cursor encoding, page limits, and end-of-stream
 * behavior explicit and reviewable.
 */
export interface ContractEventsPage {
  events: ContractEvent[];
  /**
   * Opaque next-page cursor (always `null` at end of stream). It is safe to
   * hand this back to `getContractEvents()` to resume from exactly where this
   * page ended.
   */
  cursor: string | null;
  /**
   * `true` when a subsequent page is available (i.e. the provider returned a
   * next cursor). `false` signals deterministic end-of-stream.
   */
  hasNextPage: boolean;
  /** Monotonic page sequence (1-based) for this request. */
  seq: number;
  /** The page limit that was applied to this request. */
  limit: number;
}

/**
 * Supported version of the client-issued event cursor envelope.
 * Bump this only on a wire-incompatible change to the encoding.
 */
export const SOROBAN_EVENT_CURSOR_VERSION = 1;

/**
 * Default number of events requested per page.
 */
export const DEFAULT_EVENTS_PAGE_LIMIT = 100;

/**
 * Hard upper bound on the number of events requested per page. Requests above
 * this are rejected with `CONFIG_ERROR` so page sizes stay bounded and
 * deterministic (protecting downstream RPC payload sizes).
 */
export const MAX_EVENTS_PAGE_LIMIT = 1000;

/**
 * Maximum byte length (as UTF-8) of the decoded cursor payload. Guards against
 * absurdly large cursor strings reaching the RPC, and keeps cursor storage
 * bounded.
 */
export const MAX_EVENT_CURSOR_PAYLOAD_BYTES = 2048;

interface EventCursorPayload {
  v: number;
  /** Opaque server-issued cursor token. */
  c: string;
  /** Monotonic page sequence (1-based). */
  seq: number;
}

/**
 * Encodes an opaque server cursor together with a monotonic page sequence
 * into a deterministic, versioned, base64url token.
 *
 * The token is self-describing (it carries the envelope version) so a stale
 * or incompatible token can be rejected deterministically instead of being
 * silently forwarded to the RPC with unpredictable results.
 */
export function encodeEventCursor(serverCursor: string, seq: number): string {
  const payload: EventCursorPayload = {
    v: SOROBAN_EVENT_CURSOR_VERSION,
    c: serverCursor,
    seq,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * Decodes and validates a client-issued event cursor token.
 *
 * @param token - The encoded cursor token produced by `encodeEventCursor()`.
 * @returns The decoded server cursor and page sequence.
 * @throws `SorobanClientError` (code `PARSE_ERROR`) when the token is not a
 *   valid base64url string, has an unsupported version, is malformed JSON,
 *   carries a non-string/non-finite cursor, or exceeds the size bounds.
 *   Rejecting invalid tokens here guarantees a malformed cursor never reaches
 *   the RPC and never mutates state.
 */
export function decodeEventCursor(
  token: string,
): { cursor: string; seq: number } {
  if (typeof token !== "string" || token.trim() === "" || token.trim() !== token) {
    throw new SorobanClientError({
      code: "PARSE_ERROR",
      message: "Invalid event cursor: cursor must be a non-empty, non-whitespace-padded string.",
    });
  }

  let payload: Partial<EventCursorPayload>;
  try {
    const raw = Buffer.from(token, "base64url").toString("utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_EVENT_CURSOR_PAYLOAD_BYTES) {
      throw new SorobanClientError({
        code: "PARSE_ERROR",
        message: `Invalid event cursor: payload exceeds ${MAX_EVENT_CURSOR_PAYLOAD_BYTES} bytes.`,
      });
    }
    payload = JSON.parse(raw) as Partial<EventCursorPayload>;
  } catch (error) {
    if (error instanceof SorobanClientError) throw error;
    throw new SorobanClientError({
      code: "PARSE_ERROR",
      message: "Invalid event cursor: unable to decode cursor token.",
      cause: error,
    });
  }

  if (payload.v !== SOROBAN_EVENT_CURSOR_VERSION) {
    throw new SorobanClientError({
      code: "PARSE_ERROR",
      message: `Invalid event cursor: unsupported cursor version ${String(payload.v)}.`,
    });
  }

  if (typeof payload.c !== "string" || payload.c.trim() === "") {
    throw new SorobanClientError({
      code: "PARSE_ERROR",
      message: "Invalid event cursor: missing server cursor payload.",
    });
  }

  if (!Number.isSafeInteger(payload.seq) || (payload.seq as number) < 1) {
    throw new SorobanClientError({
      code: "PARSE_ERROR",
      message: "Invalid event cursor: page sequence must be a positive integer.",
    });
  }

  return { cursor: payload.c as string, seq: payload.seq as number };
}

/**
 * Builds the next-page token from a server cursor and the current page
 * sequence, or `null` when the stream has ended.
 */
function buildNextCursor(
  serverCursor: string | undefined | null,
  seq: number,
): string | null {
  if (!serverCursor) return null;
  return encodeEventCursor(serverCursor, seq + 1);
}

interface SorobanRpcResponse<T> {
  jsonrpc: string;
  id: string;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface SorobanClientDependencies {
  fetchFn?: typeof fetch;
  /** Optional abort signal for cancelling an in-flight RPC operation. */
  signal?: AbortSignal;
  sleepFn?: (ms: number) => Promise<void>;
  randomFn?: () => number;
  retryObserver?: RetryObserver;
  /** Override the identity-state cache (useful in tests). */
  stateCache?: SorobanStateCache;
}

export class SorobanClientError extends Error {
  public readonly code:
    | "CONFIG_ERROR"
    | "LIMIT_ERROR"
    | "NETWORK_ERROR"
    | "TIMEOUT_ERROR"
    | "HTTP_ERROR"
    | "RPC_ERROR"
    | "PARSE_ERROR";

  public readonly status?: number;
  public readonly rpcCode?: number;
  public readonly details?: unknown;
  public readonly attempts: number;

  constructor(params: {
    message: string;
    code:
      | "CONFIG_ERROR"
      | "LIMIT_ERROR"
      | "NETWORK_ERROR"
      | "TIMEOUT_ERROR"
      | "HTTP_ERROR"
      | "RPC_ERROR"
      | "PARSE_ERROR";
    attempts?: number;
    status?: number;
    rpcCode?: number;
    details?: unknown;
    cause?: unknown;
  }) {
    super(params.message, { cause: params.cause });
    this.name = "SorobanClientError";
    this.code = params.code;
    this.status = params.status;
    this.rpcCode = params.rpcCode;
    this.details = params.details;
    this.attempts = params.attempts ?? 1;
  }
}

const DEFAULT_RETRY: ExtendedRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 2_000,
  backoffMultiplier: 2,
  jitterStrategy: "none",
};

export class SorobanClient {
  private readonly rpcUrl: string;
  private readonly network: SorobanNetwork;
  private readonly contractId: string;
  private readonly maxEventsPerPage: number;
  private readonly signal?: AbortSignal;
  private readonly timeoutMs: number;
  private readonly retryOptions: ExtendedRetryPolicy;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly randomFn: () => number;
  private readonly retryObserver: RetryObserver;
  private readonly metrics = createMetricsAdapter(
    createDefaultMetricsCollector(),
  );
  private readonly circuitBreakerConfig: {
    failureThreshold: number;
    openWindowMs: number;
    halfOpenAfterMs: number;
  };
  private readonly stateCache: SorobanStateCache;

  constructor(
    config: SorobanClientConfig,
    deps: SorobanClientDependencies = {},
  ) {
    this.assertConfig(config);

    this.rpcUrl = config.rpcUrl;
    this.network = config.network;
    this.contractId = config.contractId;
    this.maxEventsPerPage = config.maxEventsPerPage ?? 100;
    if (!Number.isInteger(this.maxEventsPerPage) || this.maxEventsPerPage < 1) {
      throw new SorobanClientError({
        code: "CONFIG_ERROR",
        message: "maxEventsPerPage must be a positive integer.",
      });
    }
    this.signal = deps.signal;
    this.timeoutMs = resolveTimeout(
      "soroban",
      createTimeoutConfig("soroban", "SOROBAN_RPC_TIMEOUT", config.timeoutMs),
    );
    this.retryOptions = resolveExtendedProviderRetryPolicy("soroban", DEFAULT_RETRY, {
      providerPolicies: config.retryPolicies,
      overrides: config.retry,
    });
    this.fetchFn = deps.fetchFn ?? fetch;
    this.sleepFn =
      deps.sleepFn ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.randomFn = deps.randomFn ?? Math.random;
    this.retryObserver = deps.retryObserver ?? noopRetryObserver;

    let defaultFailureThreshold = 5;
    let defaultOpenWindowMs = 10_000;
    let defaultHalfOpenAfterMs = 30_000;
    let defaultCacheTtlMs = 5000;
    try {
      const globalConfig = validateConfig(process.env);
      defaultFailureThreshold =
        globalConfig.sorobanCircuitBreaker.failureThreshold;
      defaultOpenWindowMs = globalConfig.sorobanCircuitBreaker.openWindowMs;
      defaultHalfOpenAfterMs =
        globalConfig.sorobanCircuitBreaker.halfOpenAfterMs;
      defaultCacheTtlMs = globalConfig.sorobanStateCache.ttlMs;
    } catch {
      if (process.env.SOROBAN_CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
        defaultFailureThreshold = Number(
          process.env.SOROBAN_CIRCUIT_BREAKER_FAILURE_THRESHOLD,
        );
      }
      if (process.env.SOROBAN_CIRCUIT_BREAKER_OPEN_WINDOW_MS) {
        defaultOpenWindowMs = Number(
          process.env.SOROBAN_CIRCUIT_BREAKER_OPEN_WINDOW_MS,
        );
      }
      // Prefer the new var; fall back to deprecated COOLDOWN_MS.
      if (process.env.SOROBAN_CIRCUIT_BREAKER_HALF_OPEN_AFTER_MS) {
        defaultHalfOpenAfterMs = Number(
          process.env.SOROBAN_CIRCUIT_BREAKER_HALF_OPEN_AFTER_MS,
        );
      } else if (process.env.SOROBAN_CIRCUIT_BREAKER_COOLDOWN_MS) {
        defaultHalfOpenAfterMs = Number(
          process.env.SOROBAN_CIRCUIT_BREAKER_COOLDOWN_MS,
        );
      }
      if (process.env.SOROBAN_STATE_CACHE_TTL_MS) {
        defaultCacheTtlMs = Number(process.env.SOROBAN_STATE_CACHE_TTL_MS);
      }
    }

    this.circuitBreakerConfig = {
      failureThreshold:
        config.circuitBreaker?.failureThreshold ?? defaultFailureThreshold,
      openWindowMs:
        config.circuitBreaker?.openWindowMs ?? defaultOpenWindowMs,
      halfOpenAfterMs:
        config.circuitBreaker?.halfOpenAfterMs ??
        config.circuitBreaker?.cooldownPeriodMs ??
        defaultHalfOpenAfterMs,
    };

    // Allow per-instance override via config.cacheTtlMs; fall back to env default.
    const cacheTtlMs = config.cacheTtlMs ?? defaultCacheTtlMs;
    this.stateCache =
      deps.stateCache ?? createSorobanStateCache(cacheTtlMs);
  }

  /**
   * Fetches the current identity state for an address from the configured contract.
   *
   * Results are cached in a short-TTL read-through cache (L1 LRU + L2 Redis).
   * Cache hits bypass the circuit breaker entirely — the breaker only gates
   * live RPC calls. TTL is controlled by SOROBAN_STATE_CACHE_TTL_MS (0 = off).
   */
  async getIdentityState(address: string): Promise<unknown> {
    this.throwIfCancelled();
    if (!address?.trim()) {
      throw new SorobanClientError({
        code: "CONFIG_ERROR",
        message: "Address is required for getIdentityState(address).",
      });
    }

    // ── Cache read (never blocked by the circuit breaker) ──────────────────
    const cached = await this.stateCache.get(
      this.network,
      this.contractId,
      address,
    );
    if (cached !== null) {
      return cached;
    }

    // ── Cache miss: go through the circuit breaker + retry stack ───────────
    const result = await this.callRpc<unknown>("getContractData", {
      contractId: this.contractId,
      network: this.network,
      key: { type: "identity", address },
    });

    // Only cache successful (non-null) responses.
    if (result !== null && result !== undefined) {
      await this.stateCache.set(this.network, this.contractId, address, result);
    }

    return result;
  }

  /**
   * Fetches contract-scoped events with deterministic pagination and cursor
   * semantics.
   *
   * Ordering is explicitly ascending (ledger/sequence order), page limits are
   * bounded (`1..MAX_EVENTS_PAGE_LIMIT`, default `DEFAULT_EVENTS_PAGE_LIMIT`),
   * and the returned `cursor` is a self-describing, validated token that can be
   * handed back to resume from exactly where this page ended. End-of-stream is
   * signalled deterministically via `hasNextPage` (`false` when the provider
   * returns no next cursor).
   *
   * A malformed, stale, or out-of-scope cursor is rejected here (before any RPC
   * call) with a typed `SorobanClientError` (code `PARSE_ERROR`), so an invalid
   * request never mutates downstream state and never yields a partial result.
   *
   * @param cursor  - Optional next-page token returned by a previous call.
   * @param options - Optional `limit` (page size) override.
   */
  async getContractEvents(
    cursor?: string,
    options: { limit?: number } = {},
  ): Promise<ContractEventsPage> {
    let seq = 1;
    let serverCursor: string | undefined;

    if (cursor) {
      const decoded = decodeEventCursor(cursor);
      serverCursor = decoded.cursor;
      seq = decoded.seq;
    }

    const limit = this.resolveEventsPageLimit(options.limit);

    const result = await this.callRpc<{
      events?: ContractEvent[];
      latestCursor?: string;
      cursor?: string;
      order?: string;
    }>("getEvents", {
      network: this.network,
      contractIds: [this.contractId],
      order: "asc",
      limit,
      ...(serverCursor ? { cursor: serverCursor } : {}),
    });

    const events = result.events ?? [];
    const nextServerCursor = result.latestCursor ?? result.cursor ?? null;

    return {
      events,
      cursor: buildNextCursor(nextServerCursor, seq),
      hasNextPage: Boolean(nextServerCursor),
      seq,
      limit,
    };
  }

  /**
   * Resolves and validates the requested page limit.
   * Page limits are bounded so oversized RPC payloads are never requested and
   * page sizes stay deterministic.
   */
  private resolveEventsPageLimit(requested?: number): number {
    if (requested === undefined) {
      return DEFAULT_EVENTS_PAGE_LIMIT;
    }
    if (
      !Number.isInteger(requested) ||
      requested < 1 ||
      requested > MAX_EVENTS_PAGE_LIMIT
    ) {
      throw new SorobanClientError({
        code: "CONFIG_ERROR",
        message: `Invalid events page limit: expected an integer in [1, ${MAX_EVENTS_PAGE_LIMIT}], got ${String(requested)}.`,
      });
    }
    return requested;
  }

  private assertConfig(config: SorobanClientConfig): void {
    if (!config.rpcUrl?.trim()) {
      throw new SorobanClientError({
        code: "CONFIG_ERROR",
        message: "Soroban client configuration requires rpcUrl.",
      });
    }

    if (!config.contractId?.trim()) {
      throw new SorobanClientError({
        code: "CONFIG_ERROR",
        message: "Soroban client configuration requires contractId.",
      });
    }

    if (
      !config.network ||
      (config.network !== "testnet" && config.network !== "mainnet")
    ) {
      throw new SorobanClientError({
        code: "CONFIG_ERROR",
        message:
          "Soroban client configuration requires network: testnet | mainnet.",
      });
    }
  }

  private async callRpc<T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    let host = "unknown";
    try {
      host = new URL(this.rpcUrl).host;
    } catch {
      host = this.rpcUrl;
    }

    const breaker = getCircuitBreaker(host, this.circuitBreakerConfig);

    // Measure the full downstream RPC latency (including retries and any time
    // spent gated by the circuit breaker), labelled by provider and op.
    const callStartMs = Date.now();
    try {
      return await this.executeWithRetries<T>(breaker, method, params);
    } finally {
      recordDownstreamRpcLatency("soroban", method, Date.now() - callStartMs);
    }
  }

  private executeWithRetries<T>(
    breaker: ReturnType<typeof getCircuitBreaker>,
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    return breaker.execute(async () => {
      let attemptCounter = 0;
      return executeWithRetry<T>(
        "soroban",
        async () => {
          attemptCounter += 1;
          return this.executeRpc<T>(method, params, attemptCounter);
        },
        {
          policy: this.retryOptions,
          retryObserver: this.retryObserver,
          sleepFn: this.sleepFn,
          randomFn: this.randomFn,
        }
      ).catch((error) => {
        throw this.normalizeError(error, attemptCounter);
      });
    });
  }

  private async executeRpc<T>(
    method: string,
    params: Record<string, unknown>,
    attempt: number,
  ): Promise<T> {
    return executeSorobanOperation(
      method,
      async (signal) => {
        if (this.signal?.aborted) {
          throw this.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
        }
        const response = await this.fetchFn(this.rpcUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: `${method}-${attempt}`,
            method,
            params,
          }),
          signal,
        });

        if (!response.ok) {
          throw this.buildHttpError(response.status, attempt);
        }

        let payload: SorobanRpcResponse<T>;
        try {
          payload = (await response.json()) as SorobanRpcResponse<T>;
        } catch (error) {
          // If the body read was interrupted by an abort (timeout fired while
          // streaming) or a connection reset, surface the real transport error
          // so the retry classifier handles it correctly instead of treating it
          // as a non-retriable PARSE_ERROR.
          const transport = normalizeTransportError(error);
          if (transport !== null) {
            throw new SorobanClientError({
              code:
                transport.code === "TIMEOUT"
                  ? "TIMEOUT_ERROR"
                  : "NETWORK_ERROR",
              message:
                transport.code === "TIMEOUT"
                  ? `Soroban RPC response timed out while reading body after ${this.timeoutMs}ms.`
                  : `Soroban RPC transport error reading body: ${transport.message}`,
              attempts: attempt,
              cause: error,
            });
          }
          throw new SorobanClientError({
            code: "PARSE_ERROR",
            message: "Unable to parse Soroban RPC response JSON.",
            attempts: attempt,
            cause: error,
          });
        }

        if (payload.error) {
          throw new SorobanClientError({
            code: "RPC_ERROR",
            message: `Soroban RPC error: ${payload.error.message}`,
            rpcCode: payload.error.code,
            details: payload.error.data,
            attempts: attempt,
          });
        }

        if (payload.result === undefined) {
          throw new SorobanClientError({
            code: "PARSE_ERROR",
            message: "Soroban RPC response missing result field.",
            attempts: attempt,
          });
        }

        return payload.result;
      },
      { overrideMs: this.retryOptions.timeoutMs ?? this.timeoutMs, metrics: this.metrics },
    );
  }

  private buildHttpError(status: number, attempts: number): SorobanClientError {
    return new SorobanClientError({
      code: "HTTP_ERROR",
      message: `Soroban RPC request failed with HTTP ${status}.`,
      status,
      attempts,
    });
  }

  private normalizeError(error: unknown, attempts: number): SorobanClientError {
    if (error instanceof SorobanClientError) {
      return error;
    }

    // TimeoutExceededError is thrown by executeSorobanOperation when the
    // AbortController fires. It wraps the original AbortError but has
    // name='TimeoutExceededError', so isAbortError() won't catch it.
    if (error instanceof TimeoutExceededError) {
      return new SorobanClientError({
        code: "TIMEOUT_ERROR",
        message: `Soroban RPC request timed out after ${this.timeoutMs}ms.`,
        attempts,
        cause: error,
      });
    }

    // Use normalizeTransportError as the single classification path so that
    // overlapping timeout+reset signals are resolved consistently:
    // AbortError (or TypeError wrapping AbortError) → TIMEOUT wins over RESET.
    const transport = normalizeTransportError(error);
    if (transport !== null) {
      if (transport.code === "TIMEOUT") {
        return new SorobanClientError({
          code: "TIMEOUT_ERROR",
          message: `Soroban RPC request timed out after ${this.timeoutMs}ms.`,
          attempts,
          cause: error,
        });
      }
      return new SorobanClientError({
        code: "NETWORK_ERROR",
        message: `Soroban RPC transport error: ${transport.message}`,
        attempts,
        cause: error,
      });
    }

    if (error instanceof Error) {
      return new SorobanClientError({
        code: "NETWORK_ERROR",
        message: `Soroban RPC transport error: ${error.message}`,
        attempts,
        cause: error,
      });
    }

    return new SorobanClientError({
      code: "NETWORK_ERROR",
      message: "Unknown Soroban RPC transport error.",
      attempts,
      details: error,
    });
  }

  private isRetryable(error: SorobanClientError): boolean {
    if (error.code === "NETWORK_ERROR" || error.code === "TIMEOUT_ERROR") {
      return true;
    }

    if (error.code === "HTTP_ERROR") {
      return (
        error.status === 408 ||
        error.status === 429 ||
        (error.status !== undefined && error.status >= 500)
      );
    }

    if (error.code === "RPC_ERROR") {
      return isRetryableRpcCode(error.rpcCode);
    }

    return false;
  }

  private getDelayMs(attempt: number): number {
    return getBackoffDelayMs(this.retryOptions, attempt, this.randomFn);
  }
}

export function createSorobanClient(
  config: SorobanClientConfig,
  deps?: SorobanClientDependencies,
): SorobanClient {
  return new SorobanClient(config, deps);
}
