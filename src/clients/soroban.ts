import {
  getBackoffDelayMs,
  resolveProviderRetryPolicy,
  type ProviderRetryPolicies,
  type RetryPolicy,
} from "../lib/retryPolicy.js";
import {
  executeSorobanOperation,
  createMetricsAdapter,
  TimeoutExceededError,
} from "../lib/timeoutExecutor.js";
import { createDefaultMetricsCollector } from "../observability/timeoutMetrics.js";
import { normalizeTransportError, isAbortError } from "./httpErrors.js";
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
  timeoutMs?: number;
  retry?: Partial<RetryOptions>;
  retryPolicies?: ProviderRetryPolicies;
  circuitBreaker?: {
    failureThreshold?: number;
    cooldownPeriodMs?: number;
  };
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
}

export interface ContractEventsPage {
  events: ContractEvent[];
  cursor: string | null;
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
  sleepFn?: (ms: number) => Promise<void>;
  randomFn?: () => number;
  retryObserver?: RetryObserver;
  /** Override the identity-state cache (useful in tests). */
  stateCache?: SorobanStateCache;
}

export class SorobanClientError extends Error {
  public readonly code:
    | "CONFIG_ERROR"
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

const DEFAULT_RETRY: RetryOptions = {
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
  private readonly timeoutMs: number;
  private readonly retryOptions: RetryOptions;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly randomFn: () => number;
  private readonly retryObserver: RetryObserver;
  private readonly metrics = createMetricsAdapter(
    createDefaultMetricsCollector(),
  );
  private readonly circuitBreakerConfig: {
    failureThreshold: number;
    cooldownPeriodMs: number;
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
    this.timeoutMs = resolveTimeout(
      "soroban",
      createTimeoutConfig("soroban", "SOROBAN_RPC_TIMEOUT", config.timeoutMs),
    );
    this.retryOptions = resolveProviderRetryPolicy("soroban", DEFAULT_RETRY, {
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
    let defaultCooldownMs = 10000;
    let defaultCacheTtlMs = 5000;
    try {
      const globalConfig = validateConfig(process.env);
      defaultFailureThreshold =
        globalConfig.sorobanCircuitBreaker.failureThreshold;
      defaultCooldownMs = globalConfig.sorobanCircuitBreaker.cooldownPeriodMs;
      defaultCacheTtlMs = globalConfig.sorobanStateCache.ttlMs;
    } catch {
      if (process.env.SOROBAN_CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
        defaultFailureThreshold = Number(
          process.env.SOROBAN_CIRCUIT_BREAKER_FAILURE_THRESHOLD,
        );
      }
      if (process.env.SOROBAN_CIRCUIT_BREAKER_COOLDOWN_MS) {
        defaultCooldownMs = Number(
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
      cooldownPeriodMs:
        config.circuitBreaker?.cooldownPeriodMs ?? defaultCooldownMs,
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
   * Fetches contract-scoped events and returns the normalized next cursor.
   */
  async getContractEvents(cursor?: string): Promise<ContractEventsPage> {
    const result = await this.callRpc<{
      events?: ContractEvent[];
      latestCursor?: string;
      cursor?: string;
    }>("getEvents", {
      network: this.network,
      contractIds: [this.contractId],
      ...(cursor ? { cursor } : {}),
    });

    return {
      events: result.events ?? [],
      cursor: result.latestCursor ?? result.cursor ?? null,
    };
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
      let attempt = 0;
      let lastError: SorobanClientError | null = null;
      const startMs = Date.now();

      while (attempt < this.retryOptions.maxAttempts) {
        attempt += 1;
        try {
          const result = await this.executeRpc<T>(method, params, attempt);
          this.retryObserver.onSuccess?.({
            provider: "soroban",
            attempt,
            durationMs: Date.now() - startMs,
          });
          return result;
        } catch (error) {
          const normalized = this.normalizeError(error, attempt);
          lastError = normalized;

          const hasAttemptsRemaining = attempt < this.retryOptions.maxAttempts;
          const shouldRetry =
            hasAttemptsRemaining && this.isRetryable(normalized);

          if (!shouldRetry) {
            if (!hasAttemptsRemaining || !this.isRetryable(normalized)) {
              this.retryObserver.onRetryExhausted?.({
                provider: "soroban",
                attempts: attempt,
                errorCode: normalized.code,
              });
            }
            throw normalized;
          }

          const delay = this.getDelayMs(attempt);
          this.retryObserver.onRetryAttempt?.({
            provider: "soroban",
            attempt,
            delayMs: delay,
            errorCode: normalized.code,
          });
          logger.info(
            `Retrying outbound request provider=soroban attempt=${attempt + 1}/${this.retryOptions.maxAttempts} delayMs=${delay} code=${normalized.code}`,
          );
          await this.sleepFn(delay);
        }
      }

      this.retryObserver.onRetryExhausted?.({
        provider: "soroban",
        attempts: attempt,
        errorCode: lastError?.code ?? "NETWORK_ERROR",
      });

      throw (
        lastError ??
        new SorobanClientError({
          code: "NETWORK_ERROR",
          message: `Unknown Soroban RPC failure after ${this.retryOptions.maxAttempts} attempts.`,
          attempts: this.retryOptions.maxAttempts,
        })
      );
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
      { overrideMs: this.timeoutMs, metrics: this.metrics },
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
