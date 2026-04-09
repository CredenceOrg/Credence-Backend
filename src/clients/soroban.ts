import {
  getBackoffDelayMs,
  resolveProviderRetryPolicy,
  type ProviderRetryPolicies,
  type RetryPolicy,
} from '../lib/retryPolicy.js'
import { executeSorobanOperation, createMetricsAdapter } from '../lib/timeoutExecutor.js'
import { createDefaultMetricsCollector } from '../observability/timeoutMetrics.js'
import { normalizeTransportError, isAbortError, isNetworkError } from './httpErrors.js'
import { logger } from '../utils/logger.js'

export type SorobanNetwork = 'testnet' | 'mainnet'

export type RetryOptions = RetryPolicy

export interface SorobanClientConfig {
  rpcUrl: string
  network: SorobanNetwork
  contractId: string
  timeoutMs?: number
  retry?: Partial<RetryOptions>
  retryPolicies?: ProviderRetryPolicies
}

export interface ContractEvent {
  id?: string
  type?: string
  ledger?: number
  topic?: string[]
  value?: unknown
  [key: string]: unknown
}

export interface ContractEventsPage {
  events: ContractEvent[]
  cursor: string | null
}

interface SorobanRpcResponse<T> {
  jsonrpc: string
  id: string
  result?: T
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

export interface SorobanClientDependencies {
  fetchFn?: typeof fetch
  sleepFn?: (ms: number) => Promise<void>
  randomFn?: () => number
}

export class SorobanClientError extends Error {
  public readonly code:
    | 'CONFIG_ERROR'
    | 'NETWORK_ERROR'
    | 'TIMEOUT_ERROR'
    | 'HTTP_ERROR'
    | 'RPC_ERROR'
    | 'PARSE_ERROR'

  public readonly status?: number
  public readonly rpcCode?: number
  public readonly details?: unknown
  public readonly attempts: number

  constructor(params: {
    message: string
    code:
      | 'CONFIG_ERROR'
      | 'NETWORK_ERROR'
      | 'TIMEOUT_ERROR'
      | 'HTTP_ERROR'
      | 'RPC_ERROR'
      | 'PARSE_ERROR'
    attempts?: number
    status?: number
    rpcCode?: number
    details?: unknown
    cause?: unknown
  }) {
    super(params.message, { cause: params.cause })
    this.name = 'SorobanClientError'
    this.code = params.code
    this.status = params.status
    this.rpcCode = params.rpcCode
    this.details = params.details
    this.attempts = params.attempts ?? 1
  }
}

const DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 2_000,
  backoffMultiplier: 2,
  jitterStrategy: 'none',
}

export class SorobanClient {
  private readonly rpcUrl: string
  private readonly network: SorobanNetwork
  private readonly contractId: string
  private readonly timeoutMs: number
  private readonly retryOptions: RetryOptions
  private readonly fetchFn: typeof fetch
  private readonly sleepFn: (ms: number) => Promise<void>
  private readonly randomFn: () => number
  private readonly metrics = createMetricsAdapter(createDefaultMetricsCollector())

  constructor(config: SorobanClientConfig, deps: SorobanClientDependencies = {}) {
    this.assertConfig(config)

    this.rpcUrl = config.rpcUrl
    this.network = config.network
    this.contractId = config.contractId
    this.timeoutMs = config.timeoutMs ?? 5_000
    this.retryOptions = resolveProviderRetryPolicy('soroban', DEFAULT_RETRY, {
      providerPolicies: config.retryPolicies,
      overrides: config.retry,
    })
    this.fetchFn = deps.fetchFn ?? fetch
    this.sleepFn = deps.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.randomFn = deps.randomFn ?? Math.random
  }

  /**
   * Fetches the current identity state for an address from the configured contract.
   */
  async getIdentityState(address: string): Promise<unknown> {
    if (!address?.trim()) {
      throw new SorobanClientError({
        code: 'CONFIG_ERROR',
        message: 'Address is required for getIdentityState(address).',
      })
    }

    return this.callRpc<unknown>('getContractData', {
      contractId: this.contractId,
      network: this.network,
      key: { type: 'identity', address },
    })
  }

  /**
   * Fetches contract-scoped events and returns the normalized next cursor.
   */
  async getContractEvents(cursor?: string): Promise<ContractEventsPage> {
    const result = await this.callRpc<{
      events?: ContractEvent[]
      latestCursor?: string
      cursor?: string
    }>('getEvents', {
      network: this.network,
      contractIds: [this.contractId],
      ...(cursor ? { cursor } : {}),
    })

    return {
      events: result.events ?? [],
      cursor: result.latestCursor ?? result.cursor ?? null,
    }
  }

  private assertConfig(config: SorobanClientConfig): void {
    if (!config.rpcUrl?.trim()) {
      throw new SorobanClientError({
        code: 'CONFIG_ERROR',
        message: 'Soroban client configuration requires rpcUrl.',
      })
    }

    if (!config.contractId?.trim()) {
      throw new SorobanClientError({
        code: 'CONFIG_ERROR',
        message: 'Soroban client configuration requires contractId.',
      })
    }

    if (!config.network || (config.network !== 'testnet' && config.network !== 'mainnet')) {
      throw new SorobanClientError({
        code: 'CONFIG_ERROR',
        message: 'Soroban client configuration requires network: testnet | mainnet.',
      })
    }
  }

  private async callRpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
    let attempt = 0
    let lastError: SorobanClientError | null = null

    while (attempt < this.retryOptions.maxAttempts) {
      attempt += 1
      try {
        return await this.executeRpc<T>(method, params, attempt)
      } catch (error) {
        const normalized = this.normalizeError(error, attempt)
        lastError = normalized

        const hasAttemptsRemaining = attempt < this.retryOptions.maxAttempts
        const shouldRetry = hasAttemptsRemaining && this.isRetryable(normalized)

        if (!shouldRetry) {
          throw normalized
        }

        const delay = this.getDelayMs(attempt)
        logger.info(
          `Retrying outbound request provider=soroban attempt=${attempt + 1}/${this.retryOptions.maxAttempts} delayMs=${delay} code=${normalized.code}`,
        )
        await this.sleepFn(delay)
      }
    }

    throw (
      lastError ??
      new SorobanClientError({
        code: 'NETWORK_ERROR',
        message: `Unknown Soroban RPC failure after ${this.retryOptions.maxAttempts} attempts.`,
        attempts: this.retryOptions.maxAttempts,
      })
    )
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
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: `${method}-${attempt}`,
            method,
            params,
          }),
          signal,
        })

        if (!response.ok) {
          throw this.buildHttpError(response.status, attempt)
        }

        let payload: SorobanRpcResponse<T>
        try {
          payload = (await response.json()) as SorobanRpcResponse<T>
        } catch (error) {
          // If the body read was interrupted by an abort (timeout fired while
          // streaming) or a connection reset, surface the real transport error
          // so the retry classifier handles it correctly instead of treating it
          // as a non-retriable PARSE_ERROR.
          const transport = normalizeTransportError(error)
          if (transport !== null) {
            throw new SorobanClientError({
              code: transport.code === 'TIMEOUT' ? 'TIMEOUT_ERROR' : 'NETWORK_ERROR',
              message:
                transport.code === 'TIMEOUT'
                  ? `Soroban RPC response timed out while reading body after ${this.timeoutMs}ms.`
                  : `Soroban RPC transport error reading body: ${transport.message}`,
              attempts: attempt,
              cause: error,
            })
          }
          throw new SorobanClientError({
            code: 'PARSE_ERROR',
            message: 'Unable to parse Soroban RPC response JSON.',
            attempts: attempt,
            cause: error,
          })
        }

        if (payload.error) {
          throw new SorobanClientError({
            code: 'RPC_ERROR',
            message: `Soroban RPC error: ${payload.error.message}`,
            rpcCode: payload.error.code,
            details: payload.error.data,
            attempts: attempt,
          })
        }

        if (payload.result === undefined) {
          throw new SorobanClientError({
            code: 'PARSE_ERROR',
            message: 'Soroban RPC response missing result field.',
            attempts: attempt,
          })
        }

        return payload.result
      },
      { overrideMs: this.timeoutMs, metrics: this.metrics },
    )
  }

  private buildHttpError(status: number, attempts: number): SorobanClientError {
    return new SorobanClientError({
      code: 'HTTP_ERROR',
      message: `Soroban RPC request failed with HTTP ${status}.`,
      status,
      attempts,
    })
  }

  private normalizeError(error: unknown, attempts: number): SorobanClientError {
    if (error instanceof SorobanClientError) {
      return error
    }

    // Use shared detector so DOMException, Error, and cause-chained variants
    // (e.g. undici's TypeError { cause: AbortError }) are all caught.
    if (isAbortError(error)) {
      return new SorobanClientError({
        code: 'TIMEOUT_ERROR',
        message: `Soroban RPC request timed out after ${this.timeoutMs}ms.`,
        attempts,
        cause: error,
      })
    }

    if (isNetworkError(error)) {
      const msg = error instanceof Error ? error.message : 'Unknown transport error'
      return new SorobanClientError({
        code: 'NETWORK_ERROR',
        message: `Soroban RPC transport error: ${msg}`,
        attempts,
        cause: error,
      })
    }

    if (error instanceof Error) {
      return new SorobanClientError({
        code: 'NETWORK_ERROR',
        message: `Soroban RPC transport error: ${error.message}`,
        attempts,
        cause: error,
      })
    }

    return new SorobanClientError({
      code: 'NETWORK_ERROR',
      message: 'Unknown Soroban RPC transport error.',
      attempts,
      details: error,
    })
  }

  private isRetryable(error: SorobanClientError): boolean {
    if (error.code === 'NETWORK_ERROR' || error.code === 'TIMEOUT_ERROR') {
      return true
    }

    if (error.code === 'HTTP_ERROR') {
      return error.status === 408 || error.status === 429 || (error.status !== undefined && error.status >= 500)
    }

    if (error.code === 'RPC_ERROR') {
      return error.rpcCode === -32004 || error.rpcCode === -32005
    }

    return false
  }

  private getDelayMs(attempt: number): number {
    return getBackoffDelayMs(this.retryOptions, attempt, this.randomFn)
  }
}

export function createSorobanClient(
  config: SorobanClientConfig,
  deps?: SorobanClientDependencies,
): SorobanClient {
  return new SorobanClient(config, deps)
}
