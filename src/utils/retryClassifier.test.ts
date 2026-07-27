import { describe, it, expect } from 'vitest'
import {
  classifyDownstreamError,
  classifyTransportError,
  classifyHttpStatus,
  isRetryableRpcCode,
  RETRYABLE_RPC_ERROR_CODES,
  type DownstreamClassification,
  type RetryDecision,
} from './retryClassifier.js'

/** Build an undici-style `TypeError("fetch failed")` wrapping a syscall cause. */
function fetchFailed(code: string): Error {
  const cause = Object.assign(new Error(`connect ${code}`), { code })
  return Object.assign(new TypeError('fetch failed'), { cause })
}

/** Build a plain Node-style Error with a syscall code attached. */
function nodeError(code: string, message = `connect ${code}`): Error {
  return Object.assign(new Error(message), { code })
}

/** Build an Error whose `name` is `AbortError` (older-style abort). */
function abortError(): Error {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
}

/** Build an undici-style abort that wraps an AbortError as a `cause`. */
function undiciWrappedAbort(): TypeError {
  const cause = Object.assign(new Error('Aborted'), { name: 'AbortError' })
  const wrapper = Object.assign(new TypeError('fetch failed'), { cause })
  return wrapper
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

  it('returns null for null', () => {
    expect(classifyDownstreamError(null)).toBeNull()
  })

  it('returns null for an empty object', () => {
    expect(classifyDownstreamError({})).toBeNull()
  })

  it('returns null for a JSON-RPC envelope missing code', () => {
    expect(classifyDownstreamError({ error: { message: 'no code' } })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// classifyTransportError — direct thin wrapper around the same source of truth
// ---------------------------------------------------------------------------

describe('classifyTransportError', () => {
  it('returns a retryable TIMEOUT for a bare AbortError', () => {
    expect(classifyTransportError(abortError())).toEqual<RetryDecision>({
      retryable: true,
      code: 'TIMEOUT',
      reason: expect.any(String) as unknown as string,
    })
  })

  it('returns a retryable TIMEOUT for undici TypeError wrapping an AbortError', () => {
    const result = classifyTransportError(undiciWrappedAbort())
    expect(result.retryable).toBe(true)
    if (result.retryable) {
      expect(result.code).toBe('TIMEOUT')
    }
  })

  it('returns a retryable RESET for ECONNRESET', () => {
    const result = classifyTransportError(nodeError('ECONNRESET'))
    expect(result.retryable).toBe(true)
    if (result.retryable) {
      expect(result.code).toBe('RESET')
      expect(result.reason).toBe('connect ECONNRESET')
    }
  })

  it('returns a retryable REFUSED for ECONNREFUSED', () => {
    const result = classifyTransportError(fetchFailed('ECONNREFUSED'))
    expect(result.retryable).toBe(true)
    if (result.retryable) {
      expect(result.code).toBe('REFUSED')
    }
  })

  it('returns a retryable NETWORK for generic undici fetch failure', () => {
    const result = classifyTransportError(new TypeError('fetch failed'))
    expect(result.retryable).toBe(true)
    if (result.retryable) {
      expect(result.code).toBe('NETWORK')
    }
  })

  it('returns retryable: false for a SyntaxError (parse, not transport)', () => {
    const result = classifyTransportError(new SyntaxError('Unexpected token'))
    expect(result.retryable).toBe(false)
  })

  it('returns retryable: false for a RangeError (application bug)', () => {
    const result = classifyTransportError(new RangeError('out of range'))
    expect(result.retryable).toBe(false)
    if (!result.retryable) {
      expect(result.reason).toBe('out of range')
    }
  })

  it('returns retryable: false for a plain string', () => {
    const result = classifyTransportError('boom')
    expect(result.retryable).toBe(false)
    if (!result.retryable) {
      expect(result.reason).toBe('boom')
    }
  })

  it('returns retryable: false for null', () => {
    expect(classifyTransportError(null)).toEqual({ retryable: false, reason: 'null' })
  })

  it('propagates the transport message as `reason` for retryable outcomes', () => {
    const result = classifyTransportError(nodeError('EPIPE'))
    expect(result.retryable).toBe(true)
    if (result.retryable) {
      expect(result.code).toBe('RESET')
      expect(typeof result.reason).toBe('string')
      expect(result.reason.length).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// classifyHttpStatus — status-only classification for status-code only errors
// ---------------------------------------------------------------------------

describe('classifyHttpStatus', () => {
  it.each([408, 429, 500, 502, 503, 504])('retries %i', (status) => {
    const result = classifyHttpStatus(status)
    expect(result).toEqual({
      retryable: true,
      status,
      reason: `HTTP ${status}`,
    })
  })

  it.each([200, 201, 301, 302, 400, 401, 403, 404, 410, 422, 451])(
    'does not retry %i',
    (status) => {
      const result = classifyHttpStatus(status)
      expect(result).toEqual({
        retryable: false,
        status,
        reason: `HTTP ${status}`,
      })
    },
  )

  it('uses a developer-supplied reason when provided', () => {
    const result = classifyHttpStatus(503, 'upstream overloaded')
    expect(result).toEqual({ retryable: true, status: 503, reason: 'upstream overloaded' })
  })

  it('returns a non-retryable classification with a custom reason', () => {
    const result = classifyHttpStatus(404, 'wallet not found')
    expect(result).toEqual({ retryable: false, status: 404, reason: 'wallet not found' })
  })
})
