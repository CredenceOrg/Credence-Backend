import { describe, it, expect } from 'vitest'
import {
  isAbortError,
  isNetworkError,
  normalizeTransportError,
  isRetryableHttpStatus,
  isRetryableTransportCode,
} from './httpErrors.js'
import { normalizeError, isRetryableError, type AppError } from '../lib/errors.js'

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

  it('returns false for undefined', () => {
    expect(isAbortError(undefined)).toBe(false)
  })

  it('returns false for a plain object with name AbortError but not an Error', () => {
    expect(isAbortError({ name: 'AbortError' })).toBe(false)
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

  it('returns false for undefined', () => {
    expect(isNetworkError(undefined)).toBe(false)
  })

  it('returns false for a plain object with a network-like code but not an Error', () => {
    expect(isNetworkError({ code: 'ECONNRESET' })).toBe(false)
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

  it('returns null for undefined', () => {
    expect(normalizeTransportError(undefined)).toBeNull()
  })

  it('returns null for a plain object with a network-like code but not an Error', () => {
    expect(normalizeTransportError({ code: 'ECONNRESET' })).toBeNull()
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

  it('timeout+reset overlap: undici TypeError with ECONNRESET cause → RESET', () => {
    // Reset arrives first; undici wraps it as TypeError("fetch failed") with
    // an ECONNRESET cause. Must be classified as RESET, not TIMEOUT.
    const result = normalizeTransportError(makeUndiciError('ECONNRESET'))
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

  it('does not retry boundary statuses below the retryable set', () => {
    expect(isRetryableHttpStatus(0)).toBe(false)
    expect(isRetryableHttpStatus(199)).toBe(false)
    expect(isRetryableHttpStatus(600)).toBe(false)
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

  it('does not retry non-transport codes', () => {
    expect(isRetryableTransportCode('PARSE_ERROR' as any)).toBe(false)
    expect(isRetryableTransportCode('UNKNOWN' as any)).toBe(false)
    expect(isRetryableTransportCode('' as any)).toBe(false)
  })
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

  it('ETIMEDOUT thrown from response.json() is a transport error, not a parse error', () => {
    const timeoutDuringBodyRead = makeNodeError('ETIMEDOUT', 'connect ETIMEDOUT')
    const transport = normalizeTransportError(timeoutDuringBodyRead)
    expect(transport).not.toBeNull()
    expect(transport?.code).toBe('TIMEOUT')
  })
})

// ---------------------------------------------------------------------------
// normalizeError: boundary and recovery coverage for src/lib/errors.ts
// ---------------------------------------------------------------------------

describe('normalizeError boundary cases', () => {
  it('passes through an already-normalized AppError unchanged (idempotent)', () => {
    const original: AppError = {
      code: 'TIMEOUT',
      message: 'request timed out',
      retryable: true,
    }
    const result = normalizeError(original)
    expect(result).toEqual(original)
    expect(result).toBe(original)
  })

  it('is idempotent when applied twice to a raw Error', () => {
    const raw = makeNodeError('ECONNRESET')
    const once = normalizeError(raw)
    const twice = normalizeError(once)
    expect(twice).toEqual(once)
  })

  it('normalizes null to a deterministic non-retryable UNKNOWN error', () => {
    const result = normalizeError(null)
    expect(result.code).toBe('UNKNOWN')
    expect(result.retryable).toBe(false)
    expect(typeof result.message).toBe('string')
    expect(result.message.length).toBeGreaterThan(0)
  })

  it('normalizes undefined to a deterministic non-retryable UNKNOWN error', () => {
    const result = normalizeError(undefined)
    expect(result.code).toBe('UNKNOWN')
    expect(result.retryable).toBe(false)
  })

  it('normalizes a thrown string without leaking it verbatim', () => {
    const result = normalizeError('boom')
    expect(result.code).toBe('UNKNOWN')
    expect(result.retryable).toBe(false)
    expect(result.message).not.toBe('boom')
  })

  it('normalizes a thrown number deterministically', () => {
    const a = normalizeError(42)
    const b = normalizeError(42)
    expect(a).toEqual(b)
    expect(a.code).toBe('UNKNOWN')
  })

  it('normalizes a thrown plain object deterministically', () => {
    const a = normalizeError({ weird: true })
    const b = normalizeError({ weird: true })
    expect(a).toEqual(b)
    expect(a.code).toBe('UNKNOWN')
  })

  it('normalizes a thrown boolean deterministically', () => {
    const a = normalizeError(true)
    const b = normalizeError(true)
    expect(a).toEqual(b)
    expect(a.code).toBe('UNKNOWN')
    expect(a.retryable).toBe(false)
  })

  it('classifies AbortError as TIMEOUT and retryable', () => {
    const result = normalizeError(makeAbortError('DOMException'))
    expect(result.code).toBe('TIMEOUT')
    expect(result.retryable).toBe(true)
  })

  it('classifies ECONNRESET as RESET and retryable', () => {
    const result = normalizeError(makeNodeError('ECONNRESET'))
    expect(result.code).toBe('RESET')
    expect(result.retryable).toBe(true)
  })

  it('classifies ECONNREFUSED as REFUSED and retryable', () => {
    const result = normalizeError(makeNodeError('ECONNREFUSED'))
    expect(result.code).toBe('REFUSED')
    expect(result.retryable).toBe(true)
  })

  it('classifies a SyntaxError as a non-retryable PARSE_ERROR', () => {
    const result = normalizeError(new SyntaxError('Unexpected token < in JSON'))
    expect(result.code).toBe('PARSE_ERROR')
    expect(result.retryable).toBe(false)
  })

  it('classifies a generic application Error as non-retryable UNKNOWN', () => {
    const result = normalizeError(new Error('invalid address'))
    expect(result.code).toBe('UNKNOWN')
    expect(result.retryable).toBe(false)
  })

  it('does not expose the original error message verbatim for unknown errors', () => {
    const secret = 'internal-token-abc123'
    const result = normalizeError(new Error(secret))
    expect(result.message).not.toContain(secret)
  })

  it('preserves the original error as cause for diagnosability', () => {
    const orig = makeNodeError('ECONNRESET')
    const result = normalizeError(orig)
    expect(result.cause).toBe(orig)
  })

  it('handles a deeply nested undici wrapper without unbounded recursion', () => {
    const inner = makeNodeError('ECONNRESET')
    const mid = new TypeError('fetch failed')
    ;(mid as any).cause = inner
    const outer = new TypeError('fetch failed')
    ;(outer as any).cause = mid
    const result = normalizeError(outer)
    expect(result.code).toBe('RESET')
    expect(result.retryable).toBe(true)
  })

  it('handles a self-referential cause without infinite recursion', () => {
    const cyclic = new TypeError('fetch failed')
    ;(cyclic as any).cause = cyclic
    const result = normalizeError(cyclic)
    expect(result.code).toBe('NETWORK')
  })

  it('handles a mutual cycle in cause chain without infinite recursion', () => {
    const a = new TypeError('fetch failed')
    const b = new TypeError('fetch failed')
    ;(a as any).cause = b
    ;(b as any).cause = a
    const result = normalizeError(a)
    expect(result.code).toBe('NETWORK')
    expect(result.retryable).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// isRetryableError: recovery semantics
// ---------------------------------------------------------------------------

describe('isRetryableError recovery semantics', () => {
  it('returns true for transport errors (TIMEOUT/RESET/REFUSED/NETWORK)', () => {
    expect(isRetryableError(normalizeError(makeAbortError('DOMException')))).toBe(true)
    expect(isRetryableError(normalizeError(makeNodeError('ECONNRESET')))).toBe(true)
    expect(isRetryableError(normalizeError(makeNodeError('ECONNREFUSED')))).toBe(true)
    expect(isRetryableError(normalizeError(makeUndiciError()))).toBe(true)
  })

  it('returns false for parse errors', () => {
    expect(isRetryableError(normalizeError(new SyntaxError('bad json')))).toBe(false)
  })

  it('returns false for unknown errors', () => {
    expect(isRetryableError(normalizeError(new Error('nope')))).toBe(false)
    expect(isRetryableError(normalizeError(null))).toBe(false)
  })

  it('returns false for undefined and thrown primitives', () => {
    expect(isRetryableError(normalizeError(undefined))).toBe(false)
    expect(isRetryableError(normalizeError('boom'))).toBe(false)
    expect(isRetryableError(normalizeError(42))).toBe(false)
  })

  it('agrees with the retryable flag on the normalized error', () => {
    const samples: unknown[] = [
      makeAbortError('DOMException'),
      makeNodeError('ECONNRESET'),
      new SyntaxError('bad json'),
      new Error('nope'),
      null,
    ]
    for (const sample of samples) {
      const normalized = normalizeError(sample)
      expect(isRetryableError(normalized)).toBe(normalized.retryable)
    }
  })
})

// ---------------------------------------------------------------------------
// Determinism and concurrency: repeated normalization must be stable
// ---------------------------------------------------------------------------

describe('normalizeError determinism under repeated/concurrent use', () => {
  it('produces structurally equal results across repeated calls', () => {
    const raw = makeNodeError('ECONNRESET')
    const results = Array.from({ length: 50 }, () => normalizeError(raw))
    for (const r of results) {
      expect(r.code).toBe('RESET')
      expect(r.retryable).toBe(true)
    }
    const first = results[0]
    for (const r of results) {
      expect(r.code).toBe(first.code)
      expect(r.retryable).toBe(first.retryable)
      expect(r.message).toBe(first.message)
    }
  })

  it('does not mutate the input error when normalizing', () => {
    const raw = makeNodeError('ECONNRESET')
    const before = { code: (raw as any).code, message: raw.message, name: raw.name }
    normalizeError(raw)
    expect((raw as any).code).toBe(before.code)
    expect(raw.message).toBe(before.message)
    expect(raw.name).toBe(before.name)
  })

  it('does not mutate an already-normalized AppError', () => {
    const original: AppError = { code: 'TIMEOUT', message: 'x', retryable: true }
    const snapshot = { ...original }
    normalizeError(original)
    expect(original).toEqual(snapshot)
  })

  it('handles concurrent normalization of distinct errors without cross-talk', async () => {
    const inputs: unknown[] = [
      makeAbortError('DOMException'),
      makeNodeError('ECONNRESET'),
      makeNodeError('ECONNREFUSED'),
      new SyntaxError('bad json'),
      new Error('nope'),
      null,
    ]
    const expected = inputs.map((i) => normalizeError(i).code)
    const results = await Promise.all(
      inputs.map((i) => Promise.resolve().then(() => normalizeError(i).code))
    )
    expect(results).toEqual(expected)
  })

  it('produces stable results for boundary inputs across repeated calls', () => {
    const boundaryInputs: unknown[] = [null, undefined, 0, '', false, {}, []]
    const first = boundaryInputs.map((i) => normalizeError(i))
    const second = boundaryInputs.map((i) => normalizeError(i))
    for (let idx = 0; idx < first.length; idx++) {
      expect(second[idx]).toEqual(first[idx])
      expect(first[idx].code).toBe('UNKNOWN')
      expect(first[idx].retryable).toBe(false)
    }
  })

  it('does not mutate a raw Error even when it has a cause chain', () => {
    const inner = makeNodeError('ECONNRESET')
    const outer = new TypeError('fetch failed')
    ;(outer as any).cause = inner
    const beforeOuterCause = (outer as any).cause
    const beforeInnerCode = (inner as any).code
    normalizeError(outer)
    expect((outer as any).cause).toBe(beforeOuterCause)
    expect((inner as any).code).toBe(beforeInnerCode)
  })
})
