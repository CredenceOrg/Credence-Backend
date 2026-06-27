import { describe, it, expect } from 'vitest'
import {
  classifyDownstreamError,
  isRetryableRpcCode,
  RETRYABLE_RPC_ERROR_CODES,
  type DownstreamClassification,
} from './retryClassifier.js'

/** Build an undici-style `TypeError("fetch failed")` wrapping a syscall cause. */
function fetchFailed(code: string): Error {
  const cause = Object.assign(new Error(`connect ${code}`), { code })
  return Object.assign(new TypeError('fetch failed'), { cause })
}

describe('isRetryableRpcCode', () => {
  it('is true for every code in the shared retriable set', () => {
    for (const code of RETRYABLE_RPC_ERROR_CODES) {
      expect(isRetryableRpcCode(code)).toBe(true)
    }
  })

  it('is false for non-transient RPC codes and undefined', () => {
    expect(isRetryableRpcCode(-32602)).toBe(false) // invalid params
    expect(isRetryableRpcCode(-32000)).toBe(false)
    expect(isRetryableRpcCode(undefined)).toBe(false)
  })
})

describe('classifyDownstreamError — TIMEOUT_ERROR', () => {
  it('classifies an AbortError as a retryable timeout', () => {
    const err = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    })
    const result = classifyDownstreamError(err)
    expect(result).toEqual<DownstreamClassification>({
      class: 'TIMEOUT_ERROR',
      retryable: true,
      reason: expect.any(String) as unknown as string,
    })
  })

  it('classifies an OS socket timeout (ETIMEDOUT) as a timeout', () => {
    const err = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })
    const result = classifyDownstreamError(err)
    expect(result?.class).toBe('TIMEOUT_ERROR')
    expect(result?.retryable).toBe(true)
  })
})

describe('classifyDownstreamError — NETWORK_ERROR', () => {
  it('classifies a connection reset as a retryable network error', () => {
    const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
    const result = classifyDownstreamError(err)
    expect(result).toMatchObject({
      class: 'NETWORK_ERROR',
      retryable: true,
      transportCode: 'RESET',
    })
  })

  it('classifies a refused connection as a network error', () => {
    const result = classifyDownstreamError(fetchFailed('ECONNREFUSED'))
    expect(result).toMatchObject({ class: 'NETWORK_ERROR', transportCode: 'REFUSED' })
  })

  it('classifies a generic undici fetch failure as a network error', () => {
    const result = classifyDownstreamError(new TypeError('fetch failed'))
    expect(result).toMatchObject({ class: 'NETWORK_ERROR', transportCode: 'NETWORK' })
  })
})

describe('classifyDownstreamError — RPC_ERROR', () => {
  it('classifies a transient JSON-RPC envelope as a retryable RPC error', () => {
    const err = { error: { code: -32004, message: 'Transaction not found' } }
    const result = classifyDownstreamError(err)
    expect(result).toEqual<DownstreamClassification>({
      class: 'RPC_ERROR',
      retryable: true,
      reason: 'Transaction not found',
      rpcCode: -32004,
    })
  })

  it('classifies a non-transient JSON-RPC envelope as a non-retryable RPC error', () => {
    const err = { error: { code: -32602, message: 'Invalid params' } }
    const result = classifyDownstreamError(err)
    expect(result).toMatchObject({ class: 'RPC_ERROR', retryable: false, rpcCode: -32602 })
  })

  it('classifies an error object carrying a numeric rpcCode as an RPC error', () => {
    const err = Object.assign(new Error('Not found'), { rpcCode: -32005 })
    const result = classifyDownstreamError(err)
    expect(result).toMatchObject({ class: 'RPC_ERROR', retryable: true, rpcCode: -32005 })
  })

  it('takes precedence over transport inspection when both could apply', () => {
    // String `code` (transport-style) is ignored; numeric `rpcCode` wins.
    const err = Object.assign(new Error('boom'), { code: 'ECONNRESET', rpcCode: -32602 })
    const result = classifyDownstreamError(err)
    expect(result?.class).toBe('RPC_ERROR')
  })
})

describe('classifyDownstreamError — unrecognised', () => {
  it('returns null for a non-transport application error', () => {
    expect(classifyDownstreamError(new SyntaxError('Unexpected token'))).toBeNull()
  })

  it('returns null for a plain string', () => {
    expect(classifyDownstreamError('nope')).toBeNull()
  })
})
