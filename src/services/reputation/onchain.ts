/**
 * Canonical on-chain identity state used by reputation services.
 */
export interface OnchainIdentityState {
  address: string
  bondedAmount: string
  bondStart: number | null
  bondDuration: number | null
  active: boolean
  attestationCount?: number
  slashed?: boolean
}

/**
 * Request payload for Soroban identity state reads.
 */
export interface SorobanReadRequest {
  rpcUrl: string
  contractId: string
  methodName: string
  address: string
}

/**
 * Minimal Soroban RPC client abstraction for contract reads.
 */
export interface SorobanRpcClient {
  readIdentityState(request: SorobanReadRequest): Promise<unknown>
}

/**
 * Configuration for OnchainReputationService.
 */
export interface OnchainServiceOptions {
  rpcUrl: string
  contractId: string
  methodName?: string
  timeoutMs?: number
  cacheTtlMs?: number
  rpcClient?: SorobanRpcClient
}

/**
 * Supported error codes emitted by OnchainReputationService.
 */
export type OnchainErrorCode =
  | 'INVALID_ADDRESS'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'DECODE_ERROR'
  | 'RPC_ERROR'

/**
 * Error type for on-chain fetch failures.
 */
export class OnchainError extends Error {
  constructor(public readonly code: OnchainErrorCode, message: string) {
    super(message)
    this.name = 'OnchainError'
  }
}

interface CacheEntry {
  expiresAt: number
  value: OnchainIdentityState | null
}

const DEFAULT_METHOD_NAME = 'get_identity_state'
const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_CACHE_TTL_MS = 15000

/**
 * Reads identity/bond state from Soroban RPC with timeout and TTL caching.
 */
export class OnchainReputationService {
  private readonly methodName: string
  private readonly timeoutMs: number
  private readonly cacheTtlMs: number
  private readonly rpcClient: SorobanRpcClient
  private readonly cache = new Map<string, CacheEntry>()

  constructor(private readonly options: OnchainServiceOptions) {
    this.methodName = options.methodName ?? DEFAULT_METHOD_NAME
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    this.rpcClient = options.rpcClient ?? new HttpSorobanRpcClient()
  }

  /**
   * Fetches on-chain state for an identity address.
   */
  async getIdentityState(address: string): Promise<OnchainIdentityState | null> {
    const normalizedAddress = normalizeAndValidateAddress(address)
    const cached = this.cache.get(normalizedAddress)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value
    }

    try {
      const rawState = await withTimeout(
        this.rpcClient.readIdentityState({
          rpcUrl: this.options.rpcUrl,
          contractId: this.options.contractId,
          methodName: this.methodName,
          address: normalizedAddress,
        }),
        this.timeoutMs
      )

      const decoded = decodeIdentityState(normalizedAddress, rawState)
      this.cache.set(normalizedAddress, {
        expiresAt: Date.now() + this.cacheTtlMs,
        value: decoded,
      })
      return decoded
    } catch (error) {
      if (error instanceof OnchainError) {
        throw error
      }
      if (error instanceof Error && error.message === 'timeout') {
        throw new OnchainError('TIMEOUT', `on-chain request timed out after ${this.timeoutMs}ms`)
      }
      if (error instanceof Error && isNetworkError(error)) {
        throw new OnchainError('NETWORK_ERROR', `network error: ${error.message}`)
      }
      throw new OnchainError('RPC_ERROR', 'failed to fetch on-chain identity state')
    }
  }

  /**
   * Clears all cache entries, or one address cache entry if provided.
   */
  clearCache(address?: string): void {
    if (!address) {
      this.cache.clear()
      return
    }
    const normalizedAddress = normalizeAndValidateAddress(address)
    this.cache.delete(normalizedAddress)
  }
}

/**
 * Default Soroban RPC HTTP client.
 * Uses a generic contract-read JSON-RPC payload; adapt params/method to your RPC deployment.
 */
export class HttpSorobanRpcClient implements SorobanRpcClient {
  async readIdentityState(request: SorobanReadRequest): Promise<unknown> {
    let response: Response
    try {
      response = await fetch(request.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'soroban_getIdentityState',
          params: {
            contractId: request.contractId,
            function: request.methodName,
            args: [request.address],
          },
        }),
      })
    } catch (error) {
      if (error instanceof Error) {
        throw new OnchainError('NETWORK_ERROR', `network error: ${error.message}`)
      }
      throw new OnchainError('NETWORK_ERROR', 'network error')
    }

    if (!response.ok) {
      throw new OnchainError('RPC_ERROR', `rpc responded with status ${response.status}`)
    }

    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new OnchainError('DECODE_ERROR', 'invalid JSON response from RPC')
    }

    if (!body || typeof body !== 'object') {
      throw new OnchainError('DECODE_ERROR', 'invalid RPC response shape')
    }

    const record = body as { result?: unknown; error?: { message?: string } }
    if (record.error) {
      throw new OnchainError('RPC_ERROR', record.error.message ?? 'RPC error')
    }

    return record.result ?? null
  }
}

function decodeIdentityState(
  address: string,
  payload: unknown
): OnchainIdentityState | null {
  if (payload === null || payload === undefined) {
    return null
  }

  if (typeof payload !== 'object') {
    throw new OnchainError('DECODE_ERROR', 'identity state must be an object')
  }

  const record = payload as Record<string, unknown>
  const bondedAmount = toStringValue(
    firstDefined(record.bondedAmount, record.bonded_amount),
    'bondedAmount'
  )
  const bondStart = toNullableInteger(
    firstDefined(record.bondStart, record.bond_start),
    'bondStart'
  )
  const bondDuration = toNullableInteger(
    firstDefined(record.bondDuration, record.bond_duration),
    'bondDuration'
  )
  const active = toBoolean(record.active, 'active')

  const state: OnchainIdentityState = {
    address,
    bondedAmount,
    bondStart,
    bondDuration,
    active,
  }

  const attestationCountValue = firstDefined(
    record.attestationCount,
    record.attestation_count
  )
  if (attestationCountValue !== undefined) {
    state.attestationCount = toInteger(attestationCountValue, 'attestationCount')
  }

  if (record.slashed !== undefined) {
    state.slashed = toBoolean(record.slashed, 'slashed')
  }

  return state
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined)
}

function toStringValue(value: unknown, field: string): string {
  if (value === null || value === undefined) {
    throw new OnchainError('DECODE_ERROR', `${field} is required`)
  }
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value)
  }
  throw new OnchainError('DECODE_ERROR', `${field} must be string-compatible`)
}

function toNullableInteger(value: unknown, field: string): number | null {
  if (value === null || value === undefined) {
    return null
  }
  return toInteger(value, field)
}

function toInteger(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    return Number.parseInt(value, 10)
  }
  throw new OnchainError('DECODE_ERROR', `${field} must be an integer`)
}

function toBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new OnchainError('DECODE_ERROR', `${field} must be a boolean`)
  }
  return value
}

function normalizeAndValidateAddress(address: string): string {
  const trimmed = address.trim()
  if (!/^G[A-Z2-7]{55}$/.test(trimmed)) {
    throw new OnchainError('INVALID_ADDRESS', 'invalid Stellar identity address')
  }
  return trimmed
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error('timeout')), timeoutMs)
    }),
  ])
}

function isNetworkError(error: Error): boolean {
  const message = error.message.toLowerCase()
  return message.includes('fetch') || message.includes('network')
}
