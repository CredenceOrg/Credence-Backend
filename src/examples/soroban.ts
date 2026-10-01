/**
 * Minimal SorobanClientError for use by src/examples/circuitBreaker.ts.
 *
 * The full implementation lives in src/clients/soroban.ts; this file provides
 * the same public interface so the examples package can import it without
 * pulling in the full client dependency tree.
 */
export class SorobanClientError extends Error {
  public readonly code:
    | 'CONFIG_ERROR'
    | 'LIMIT_ERROR'
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
      | 'LIMIT_ERROR'
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
