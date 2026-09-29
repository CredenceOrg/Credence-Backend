import { describe, it, expect } from 'vitest'
import {
  isAbortError,
  isNetworkError,
  normalizeTransportError,
  isPermissionError,
  isStaleError,
  getHttpStatus,
  classifyRecovery,
  TransportError
} from './httpErrors.js'
import { normalizeError, type AppError } from '../lib/errors.js'

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
// TransportError Invariants
// ---------------------------------------------------------------------------

describe('TransportError Invariants', () => {
  it('safely serializes toJSON without leaking cause or stack', () => {
    const cause = new Error('Super secret DB credential leaked')
    const error = new TransportError('TIMEOUT', 'Connection failed', cause)
    
    const serialized = JSON.stringify(error)
    expect(serialized).not.toContain('Super secret')
    expect(serialized).not.toContain('stack')
    
    const parsed = JSON.parse(serialized)
    expect(parsed).toEqual({
      name: 'TransportError',
      code: 'TIMEOUT',
      message: 'Connection failed'
    })
  })
})

// ---------------------------------------------------------------------------
// isAbortError / isNetworkError
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
})

describe('isNetworkError', () => {
  it('detects ECONNRESET', () => {
    expect(isNetworkError(makeNodeError('ECONNRESET'))).toBe(true)
  })
  it('detects undici TypeError with no cause as generic network error', () => {
    expect(isNetworkError(makeUndiciError())).toBe(true)
  })
  it('protects against CPU exhaustion on massive error strings', () => {
    const hugeMessage = 'econnreset' + 'x'.repeat(5 * 1024 * 1024)
    expect(isNetworkError(new Error(hugeMessage))).toBe(true) // Slice ensures fast completion
  })
})

// ---------------------------------------------------------------------------
// normalizeTransportError
// ---------------------------------------------------------------------------

describe('normalizeTransportError', () => {
  it('classifies DOMException AbortError as TIMEOUT', () => {
    const result = normalizeTransportError(makeAbortError('DOMException'))
    expect(result).toBeInstanceOf(TransportError)
    expect(result?.code).toBe('TIMEOUT')
  })

  it('handles thrown getters gracefully', () => {
    const maliciousErr = {
      get code() { throw new Error('trap') },
      message: 'boom'
    }
    expect(normalizeTransportError(maliciousErr)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// getHttpStatus
// ---------------------------------------------------------------------------

describe('getHttpStatus boundary checks', () => {
  it('extracts status from flat object', () => {
    expect(getHttpStatus({ status: 404 })).toBe(404)
    expect(getHttpStatus({ statusCode: 500 })).toBe(500)
  })

  it('extracts status from nested response object', () => {
    expect(getHttpStatus({ response: { status: 429 } })).toBe(429)
  })

  it('handles circular references safely', () => {
    const err: any = { message: 'circular' }
    err.response = err
    expect(getHttpStatus(err)).toBeUndefined()
  })

  it('handles throwing getters safely', () => {
    const err = {
      get status() { throw new Error('trap') }
    }
    expect(getHttpStatus(err)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// isPermissionError / isStaleError
// ---------------------------------------------------------------------------

describe('isPermissionError', () => {
  it('identifies EACCES and EPERM', () => {
    expect(isPermissionError(makeNodeError('EACCES'))).toBe(true)
    expect(isPermissionError(makeNodeError('EPERM'))).toBe(true)
  })

  it('identifies 401 and 403 HTTP status', () => {
    expect(isPermissionError({ status: 401 })).toBe(true)
    expect(isPermissionError({ response: { status: 403 } })).toBe(true)
  })
})

describe('isStaleError', () => {
  it('identifies 409, 410, 412 HTTP statuses', () => {
    expect(isStaleError({ status: 409 })).toBe(true)
    expect(isStaleError({ statusCode: 412 })).toBe(true)
  })

  it('identifies string patterns', () => {
    expect(isStaleError(new Error('Record is stale'))).toBe(true)
    expect(isStaleError(new Error('Precondition Failed on update'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// classifyRecovery
// ---------------------------------------------------------------------------

describe('classifyRecovery', () => {
  it('fails immediately for permission errors', () => {
    expect(classifyRecovery({ status: 403 })).toEqual({ action: 'fail', reason: 'PERMISSION' })
  })

  it('requests reread for stale states', () => {
    expect(classifyRecovery({ status: 409 })).toEqual({ action: 'reread', reason: 'STALE' })
  })

  it('retries transport failures', () => {
    expect(classifyRecovery(makeNodeError('ECONNRESET'))).toEqual({ action: 'retry', reason: 'RESET' })
    expect(classifyRecovery(makeAbortError('DOMException'))).toEqual({ action: 'retry', reason: 'TIMEOUT' })
  })

  it('retries safe HTTP status errors', () => {
    expect(classifyRecovery({ status: 502 })).toEqual({ action: 'retry', reason: 'HTTP_STATUS' })
    expect(classifyRecovery({ status: 429 })).toEqual({ action: 'retry', reason: 'HTTP_STATUS' })
  })

  it('fails safely on unknown application errors', () => {
    expect(classifyRecovery(new Error('Unrecognized schema'))).toEqual({ action: 'fail', reason: 'UNKNOWN' })
    expect(classifyRecovery(null)).toEqual({ action: 'fail', reason: 'UNKNOWN' })
  })

  it('handles concurrency consistently across 100 simultaneous calls', async () => {
    const error = makeNodeError('ECONNRESET')
    const results = await Promise.all(
      Array.from({ length: 100 }, () => Promise.resolve().then(() => classifyRecovery(error)))
    )
    results.forEach(res => {
      expect(res).toEqual({ action: 'retry', reason: 'RESET' })
    })
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
  })

  it('normalizes a thrown plain object deterministically', () => {
    const a = normalizeError({ weird: true })
    expect(a.code).toBe('UNKNOWN')
  })

  it('classifies AbortError as TIMEOUT and retryable', () => {
    const result = normalizeError(makeAbortError('DOMException'))
    expect(result.code).toBe('TIMEOUT')
    expect(result.retryable).toBe(true)
  })
})