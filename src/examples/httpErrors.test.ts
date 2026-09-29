import { describe, it, expect } from 'vitest'
import {
  isAbortError,
  isNetworkError,
  normalizeTransportError,
  isRetryableHttpStatus,
  isRetryableTransportCode,
} from './httpErrors.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAbortError(variant: 'DOMException' | 'Error' | 'wrapped'): unknown {
  if (variant === 'DOMException') {
    return new DOMException('The operation was aborted.', 'AbortError')
  }
  if (variant === 'Error') {
    const e = new Error('Aborted')
    e.name = 'AbortError'
    return e
  }
  // undici-style: TypeError wrapping an AbortError as cause
  const cause = new Error('Aborted')
  cause.name = 'AbortError'
  const wrapper = new TypeError('fetch failed')
  ;(wrapper as any).cause = cause
  return wrapper
}

function makeNodeError(code: string, message = `connect ${code}`): Error {
  const e = new Error(message)
  ;(e as any).code = code
  return e
}

function makeUndiciError(causeCode?: string): TypeError {
  const wrapper = new TypeError('fetch failed')
  if (causeCode) {
    ;(wrapper as any).cause = makeNodeError(causeCode)
  }
  return wrapper
}

// ---------------------------------------------------------------------------
// isAbortError
// ---------------------------------------------------------------------------

describe('isAbortError', () => {
  it('detects DOMException AbortError', () => {
    expect(isAbortError(makeAbortError('DOMException'))).toBe(true)
  })

  it('detects Error with name AbortError', () => {
    expect(isAbortError(makeAbortError('Error'))).toBe(true)
  })

  it('detects undici TypeError wrapping AbortError in cause', () => {
    expect(isAbortError(makeAbortError('wrapped'))).toBe(true)
  })

  it('returns false for plain Error', () => {
    expect(isAbortError(new Error('socket hang up'))).toBe(false)
  })

  it('returns false for ECONNRESET', () => {
    expect(isAbortError(makeNodeError('ECONNRESET'))).toBe(false)
  })

  it('returns false for non-Error values', () => {
    expect(isAbortError('string')).toBe(false)
    expect(isAbortError(null)).toBe(false)
    expect(isAbortError(42)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isNetworkError
// ---------------------------------------------------------------------------

describe('isNetworkError', () => {
  it('detects ECONNRESET', () => {
    expect(isNetworkError(makeNodeError('ECONNRESET'))).toBe(true)
  })

  it('detects EPIPE', () => {
    expect(isNetworkError(makeNodeError('EPIPE'))).toBe(true)
  })

  it('detects ECONNREFUSED', () => {
    expect(isNetworkError(makeNodeError('ECONNREFUSED'))).toBe(true)
  })

  it('detects ETIMEDOUT', () => {
    expect(isNetworkError(makeNodeError('ETIMEDOUT'))).toBe(true)
  })

  it('detects undici TypeError with ECONNRESET cause', () => {
    expect(isNetworkError(makeUndiciError('ECONNRESET'))).toBe(true)
  })

  it('detects undici TypeError with no cause as generic network error', () => {
    expect(isNetworkError(makeUndiciError())).toBe(true)
  })

  it('detects socket hang up by message heuristic', () => {
    expect(isNetworkError(new Error('socket hang up'))).toBe(true)
  })

  it('detects "connection reset" message heuristic', () => {
    expect(isNetworkError(new Error('read ECONNRESET'))).toBe(true)
  })

  it('returns false for AbortError (timeout is its own category)', () => {
    expect(isNetworkError(makeAbortError('DOMException'))).toBe(false)
    expect(isNetworkError(makeAbortError('Error'))).toBe(false)
    expect(isNetworkError(makeAbortError('wrapped'))).toBe(false)
  })

  it('returns false for plain application Error', () => {
    expect(isNetworkError(new Error('JSON parse error'))).toBe(false)
  })

  it('returns false for non-Error values', () => {
    expect(isNetworkError(null)).toBe(false)
    expect(isNetworkError('boom')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// normalizeTransportError
// ---------------------------------------------------------------------------

describe('normalizeTransportError', () => {
  it('classifies DOMException AbortError as TIMEOUT', () => {
    const result = normalizeTransportError(makeAbortError('DOMException'))
    expect(result?.code).toBe('TIMEOUT')
  })

  it('classifies Error AbortError as TIMEOUT', () => {
    const result = normalizeTransportError(makeAbortError('Error'))
    expect(result?.code).toBe('TIMEOUT')
  })

  it('classifies undici wrapped AbortError as TIMEOUT', () => {
    const result = normalizeTransportError(makeAbortError('wrapped'))
    expect(result?.code).toBe('TIMEOUT')
  })

  it('classifies ECONNRESET as RESET', () => {
    const result = normalizeTransportError(makeNodeError('ECONNRESET'))
    expect(result?.code).toBe('RESET')
  })

  it('classifies EPIPE as RESET', () => {
    const result = normalizeTransportError(makeNodeError('EPIPE'))
    expect(result?.code).toBe('RESET')
  })

  it('classifies ECONNREFUSED as REFUSED', () => {
    const result = normalizeTransportError(makeNodeError('ECONNREFUSED'))
    expect(result?.code).toBe('REFUSED')
  })

  it('classifies ETIMEDOUT as TIMEOUT', () => {
    const result = normalizeTransportError(makeNodeError('ETIMEDOUT'))
    expect(result?.code).toBe('TIMEOUT')
  })

  it('classifies undici TypeError with ECONNRESET cause as RESET', () => {
    const result = normalizeTransportError(makeUndiciError('ECONNRESET'))
    expect(result?.code).toBe('RESET')
  })

  it('classifies undici TypeError with ECONNREFUSED cause as REFUSED', () => {
    const result = normalizeTransportError(makeUndiciError('ECONNREFUSED'))
    expect(result?.code).toBe('REFUSED')
  })

  it('classifies generic undici TypeError as NETWORK', () => {
    const result = normalizeTransportError(makeUndiciError())
    expect(result?.code).toBe('NETWORK')
  })

  it('classifies socket hang up heuristic as RESET', () => {
    const result = normalizeTransportError(new Error('socket hang up'))
    expect(result?.code).toBe('RESET')
  })

  it('returns null for a real JSON parse error', () => {
    const result = normalizeTransportError(new SyntaxError('Unexpected token < in JSON'))
    expect(result).toBeNull()
  })

  it('returns null for a plain application Error', () => {
    const result = normalizeTransportError(new Error('invalid address'))
    expect(result).toBeNull()
  })

  it('returns null for non-Error throws', () => {
    expect(normalizeTransportError('boom')).toBeNull()
    expect(normalizeTransportError(null)).toBeNull()
    expect(normalizeTransportError(42)).toBeNull()
  })

  it('includes cause on every result', () => {
    const orig = makeAbortError('Error')
    const result = normalizeTransportError(orig)
    expect(result?.cause).toBe(orig)
  })

  // ---------------------------------------------------------------------------
  // Overlap scenarios: timeout fires AND socket resets at the same time
  // ---------------------------------------------------------------------------

  it('timeout+reset overlap: AbortError wins → TIMEOUT', () => {
    // AbortController fires just before ECONNRESET arrives; the DOMException
    // AbortError should take precedence and be classified as TIMEOUT.
    const overlap = makeAbortError('DOMException')
    const result = normalizeTransportError(overlap)
    expect(result?.code).toBe('TIMEOUT')
  })

  it('timeout+reset overlap: undici TypeError with AbortError cause → TIMEOUT', () => {
    // undici may emit TypeError("fetch failed") { cause: AbortError } when both
    // the abort signal and a reset arrive simultaneously.
    const result = normalizeTransportError(makeAbortError('wrapped'))
    expect(result?.code).toBe('TIMEOUT')
  })

  it('timeout+reset overlap: ECONNRESET with stale AbortController → RESET', () => {
    // Connection reset arrives before the abort fires; error has ECONNRESET code.
    const result = normalizeTransportError(makeNodeError('ECONNRESET', 'read ECONNRESET'))
    expect(result?.code).toBe('RESET')
  })
})

// ---------------------------------------------------------------------------
// isRetryableHttpStatus
// ---------------------------------------------------------------------------

describe('isRetryableHttpStatus', () => {
  it.each([408, 429, 500, 502, 503, 504])('retries %d', (status) => {
    expect(isRetryableHttpStatus(status)).toBe(true)
  })

  it.each([200, 201, 301, 400, 401, 403, 404, 422])('does not retry %d', (status) => {
    expect(isRetryableHttpStatus(status)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isRetryableTransportCode
// ---------------------------------------------------------------------------

describe('isRetryableTransportCode', () => {
  it.each(['TIMEOUT', 'RESET', 'REFUSED', 'NETWORK'] as const)(
    'retries %s',
    (code) => {
      expect(isRetryableTransportCode(code)).toBe(true)
    }
  )
})

// ---------------------------------------------------------------------------
// Integration: soroban.ts body-read reclassification regression
// ---------------------------------------------------------------------------

describe('body-read transport error classification (soroban regression)', () => {
  it('AbortError thrown from response.json() is a transport error, not a parse error', () => {
    // When AbortController fires while streaming the response body, response.json()
    // throws an AbortError. This must NOT be classified as PARSE_ERROR (non-retriable).
    const abortDuringBodyRead = makeAbortError('DOMException')
    const transport = normalizeTransportError(abortDuringBodyRead)
    expect(transport).not.toBeNull()
    expect(transport?.code).toBe('TIMEOUT')
  })

  it('ECONNRESET thrown from response.json() is a transport error, not a parse error', () => {
    const resetDuringBodyRead = makeNodeError('ECONNRESET', 'read ECONNRESET')
    const transport = normalizeTransportError(resetDuringBodyRead)
    expect(transport).not.toBeNull()
    expect(transport?.code).toBe('RESET')
  })

  it('SyntaxError from malformed JSON is not a transport error → parse error path', () => {
    const badJson = new SyntaxError('Unexpected token } in JSON at position 42')
    const transport = normalizeTransportError(badJson)
    expect(transport).toBeNull()
  })
})
