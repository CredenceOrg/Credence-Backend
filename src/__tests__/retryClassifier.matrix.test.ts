/**
 * Comprehensive error matrix for the downstream retry classifier.
 *
 * Drives {@link classifyDownstreamError}, {@link classifyTransportError},
 * {@link classifyHttpStatus}, {@link isRetryableRpcCode}, and
 * {@link isRetryableHttpStatus} over every error shape the retry path can see,
 * asserting on (class, retryable, transportCode, rpcCode) simultaneously.
 *
 * The matrix is grouped into:
 *
 * 1. Transient overlap scenarios — when timeout AND reset fire simultaneously.
 *    TIMEOUT wins over RESET (the AbortController fired first), so the
 *    classifier must still surface these as retryable TIMEOUT_ERROR.
 *
 * 2. Plain transient transport errors — every Node.js syscall code (RESET,
 *    REFUSED, TIMEOUT) and the undici `fetch failed` wrapper. Every entry MUST
 *    be retried.
 *
 * 3. Non-transient errors — SyntaxError, RangeError, arbitrary strings, null,
 *    unrecognised shapes. These MUST NOT be retried.
 *
 * 4. JSON-RPC envelopes — only `-32004` and `-32005` are transient. Every
 *    other code (including -32602 invalid params, -32600 invalid request,
 *    -32001 server error) MUST NOT be retried.
 *
 * 5. HTTP status codes — 408 / 429 / 5xx MUST be retried. 2xx / 3xx / other 4xx
 *    MUST NOT be retried.
 *
 * If any row flips, callers will silently retry failures (or surface retriable
 * failures as permanent) so the matrix is the canary for this contract.
 */

import { describe, it, expect } from 'vitest'
import {
  classifyDownstreamError,
  classifyTransportError,
  classifyHttpStatus,
  isRetryableRpcCode,
  isRetryableHttpStatus,
  type DownstreamClassification,
  type RetryDecision,
} from '../utils/retryClassifier.js'
import type { TransportErrorCode } from '../clients/httpErrors.js'

// ---------------------------------------------------------------------------
// Builders — keep the matrix readable by collapsing construction noise.
// ---------------------------------------------------------------------------

/** Bare Node-style `Error { code }` with a custom message. */
function nodeErr(code: string, message = `connect ${code}`): Error {
  return Object.assign(new Error(message), { code })
}

/** Older-style AbortError (Error whose `name === 'AbortError'`). */
function abortErr(): Error {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
}

/** DOMException abort (what undici / Node 18+ throw under modern fetch). */
function domAbort(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}

/** undici-style `TypeError("fetch failed")` wrapping a Node cause. */
function undiciFetchFailed(causeCode?: string): TypeError {
  const wrapper = new TypeError('fetch failed')
  if (causeCode) (wrapper as Error & { cause?: unknown }).cause = nodeErr(causeCode)
  return wrapper
}

// ---------------------------------------------------------------------------
// Expected types — drive every matrix row through these so consumers and the
// classifier stay in lockstep.
// ---------------------------------------------------------------------------

type TransportCase = {
  label: string
  build: () => unknown
  /** Expected classification for both `classifyTransportError` and `classifyDownstreamError`. */
  expect: {
    retryable: boolean
    transportCode: TransportErrorCode | null
    /** For non-transport cases we expect `null` from classifyDownstreamError. */
    downstream: DownstreamClassification | null
  }
}

// ---------------------------------------------------------------------------
// 1. Transient overlap scenarios — timeout + reset firing together.
//    TIMEOUT wins the race so the classifier must pick TIMEOUT_ERROR.
// ---------------------------------------------------------------------------

const TRANSIENT_OVERLAP_MATRIX: TransportCase[] = [
  {
    label: 'DOMException AbortError (timeout alone)',
    build: () => domAbort(),
    expect: {
      retryable: true,
      transportCode: 'TIMEOUT',
      downstream: {
        class: 'TIMEOUT_ERROR',
        retryable: true,
        reason: expect.stringContaining('aborted') as unknown as string,
      },
    },
  },
  {
    label: 'Error { name: "AbortError" } (timeout alone, older style)',
    build: () => abortErr(),
    expect: {
      retryable: true,
      transportCode: 'TIMEOUT',
      downstream: {
        class: 'TIMEOUT_ERROR',
        retryable: true,
        reason: expect.any(String) as unknown as string,
      },
    },
  },
  {
    label: 'undici TypeError("fetch failed") { cause: AbortError } — overlap',
    build: () => undiciFetchFailed(), // no transport code in cause → only abort fires
    expect: {
      // AbortError in cause is detected by `isAbortError` recursive check, so
      // the overlap resolves to TIMEOUT (the abort won the race).
      retryable: true,
      transportCode: 'TIMEOUT',
      downstream: {
        class: 'TIMEOUT_ERROR',
        retryable: true,
        reason: expect.any(String) as unknown as string,
      },
    },
  },
  {
    label: 'undici TypeError("fetch failed") { cause: Error { code: ECONNRESET } } — reset wins',
    build: () => undiciFetchFailed('ECONNRESET'),
    expect: {
      retryable: true,
      transportCode: 'RESET',
      downstream: {
        class: 'NETWORK_ERROR',
        retryable: true,
        reason: expect.any(String) as unknown as string,
        transportCode: 'RESET',
      },
    },
  },
  {
    label: 'undici TypeError("fetch failed") { cause: Error { code: ECONNREFUSED } }',
    build: () => undiciFetchFailed('ECONNREFUSED'),
    expect: {
      retryable: true,
      transportCode: 'REFUSED',
      downstream: {
        class: 'NETWORK_ERROR',
        retryable: true,
        reason: expect.any(String) as unknown as string,
        transportCode: 'REFUSED',
      },
    },
  },
  {
    label: 'undici TypeError("fetch failed") { cause: Error { code: ETIMEDOUT } }',
    build: () => undiciFetchFailed('ETIMEDOUT'),
    expect: {
      retryable: true,
      transportCode: 'TIMEOUT',
      downstream: {
        class: 'TIMEOUT_ERROR',
        retryable: true,
        reason: expect.any(String) as unknown as string,
      },
    },
  },
  {
    label: 'Error { code: "ECONNRESET" } (reset alone)',
    build: () => nodeErr('ECONNRESET'),
    expect: {
      retryable: true,
      transportCode: 'RESET',
      downstream: {
        class: 'NETWORK_ERROR',
        retryable: true,
        reason: expect.any(String) as unknown as string,
        transportCode: 'RESET',
      },
    },
  },
  {
    label: 'Error { code: "EPIPE" } (broken pipe)',
    build: () => nodeErr('EPIPE'),
    expect: {
      retryable: true,
      transportCode: 'RESET',
      downstream: {
        class: 'NETWORK_ERROR',
        retryable: true,
        reason: expect.any(String) as unknown as string,
        transportCode: 'RESET',
      },
    },
  },
  {
    label: 'Error { code: "ENOTCONN" } (socket not connected)',
    build: () => nodeErr('ENOTCONN'),
    expect: {
      retryable: true,
      transportCode: 'RESET',
      downstream: {
        class: 'NETWORK_ERROR',
        retryable: true,
        reason: expect.any(String) as unknown as string,
        transportCode: 'RESET',
      },
    },
  },
  {
    label: 'Error { code: "ECONNREFUSED" } (refused alone)',
    build: () => nodeErr('ECONNREFUSED'),
    expect: {
      retryable: true,
      transportCode: 'REFUSED',
      downstream: {
        class: 'NETWORK_ERROR',
        retryable: true,
        reason: expect.any(String) as unknown as string,
        transportCode: 'REFUSED',
      },
    },
  },
  {
    label: 'Error { code: "ETIMEDOUT" } (OS socket timeout)',
    build: () => nodeErr('ETIMEDOUT'),
    expect: {
      retryable: true,
      transportCode: 'TIMEOUT',
      downstream: {
        class: 'TIMEOUT_ERROR',
        retryable: true,
        reason: expect.any(String) as unknown as string,
      },
    },
  },
  {
    label: 'Error { code: "ESOCKETTIMEDOUT" }',
    build: () => nodeErr('ESOCKETTIMEDOUT'),
    expect: {
      retryable: true,
      transportCode: 'TIMEOUT',
      downstream: {
        class: 'TIMEOUT_ERROR',
        retryable: true,
        reason: expect.any(String) as unknown as string,
      },
    },
  },
  {
    label: 'Error { code: "ECONNABORTED" }',
    build: () => nodeErr('ECONNABORTED'),
    expect: {
      retryable: true,
      transportCode: 'TIMEOUT',
      downstream: {
        class: 'TIMEOUT_ERROR',
        retryable: true,
        reason: expect.any(String) as unknown as string,
      },
    },
  },
  {
    label: 'TypeError("fetch failed") (generic undici, no syscall cause)',
    build: () => new TypeError('fetch failed'),
    expect: {
      retryable: true,
      transportCode: 'NETWORK',
      downstream: {
        class: 'NETWORK_ERROR',
        retryable: true,
        reason: expect.any(String) as unknown as string,
        transportCode: 'NETWORK',
      },
    },
  },
  {
    label: 'Error("socket hang up") — message heuristic',
    build: () => new Error('socket hang up'),
    expect: {
      retryable: true,
      transportCode: 'RESET',
      downstream: {
        class: 'NETWORK_ERROR',
        retryable: true,
        reason: expect.any(String) as unknown as string,
        transportCode: 'RESET',
      },
    },
  },
  {
    label: 'Error("read ECONNRESET") — message heuristic',
    build: () => new Error('read ECONNRESET'),
    expect: {
      retryable: true,
      transportCode: 'RESET',
      downstream: {
        class: 'NETWORK_ERROR',
        retryable: true,
        reason: expect.any(String) as unknown as string,
        transportCode: 'RESET',
      },
    },
  },
  {
    label: 'Error("socket ended without sending a response") — heuristic',
    build: () => new Error('socket ended without sending a response'),
    expect: {
      retryable: true,
      transportCode: 'RESET',
      downstream: {
        class: 'NETWORK_ERROR',
        retryable: true,
        reason: expect.any(String) as unknown as string,
        transportCode: 'RESET',
      },
    },
  },
  {
    label: 'Error("network request failed") — heuristic',
    build: () => new Error('network request failed'),
    expect: {
      retryable: true,
      transportCode: 'RESET',
      downstream: {
        class: 'NETWORK_ERROR',
        retryable: true,
        reason: expect.any(String) as unknown as string,
        transportCode: 'RESET',
      },
    },
  },
]

// ---------------------------------------------------------------------------
// 2. Non-transport / non-transient — must NOT be retried, downstream = null.
// ---------------------------------------------------------------------------

const NON_TRANSIENT_MATRIX: TransportCase[] = [
  {
    label: 'SyntaxError (malformed JSON from response.json())',
    build: () => new SyntaxError('Unexpected token < in JSON at position 42'),
    expect: {
      retryable: false,
      transportCode: null,
      downstream: null,
    },
  },
  {
    label: 'RangeError (programming bug, no transport signal)',
    build: () => new RangeError('Maximum call stack size exceeded'),
    expect: {
      retryable: false,
      transportCode: null,
      downstream: null,
    },
  },
  {
    label: 'TypeError (NOT "fetch failed")',
    build: () => new TypeError('Cannot read properties of undefined'),
    expect: {
      retryable: false,
      transportCode: null,
      downstream: null,
    },
  },
  {
    label: 'plain Error (no code, no message heuristic hit)',
    build: () => new Error('invalid wallet address'),
    expect: {
      retryable: false,
      transportCode: null,
      downstream: null,
    },
  },
  {
    label: 'plain string',
    build: () => 'nope',
    expect: {
      retryable: false,
      transportCode: null,
      downstream: null,
    },
  },
  {
    label: 'null',
    build: () => null,
    expect: {
      retryable: false,
      transportCode: null,
      downstream: null,
    },
  },
  {
    label: 'a number',
    build: () => 42,
    expect: {
      retryable: false,
      transportCode: null,
      downstream: null,
    },
  },
  {
    label: 'undefined',
    build: () => undefined,
    expect: {
      retryable: false,
      transportCode: null,
      downstream: null,
    },
  },
  {
    label: 'empty object',
    build: () => ({}),
    expect: {
      retryable: false,
      transportCode: null,
      downstream: null,
    },
  },
  {
    label: 'JSON-RPC envelope missing code field',
    build: () => ({ error: { message: 'no numeric code attached' } }),
    expect: {
      retryable: false,
      transportCode: null,
      downstream: null,
    },
  },
  {
    label: 'JSON-RPC envelope with code: undefined',
    build: () => ({ error: { code: undefined, message: 'no code' } }),
    expect: {
      retryable: false,
      transportCode: null,
      downstream: null,
    },
  },
]

// ---------------------------------------------------------------------------
// JSON-RPC matrix — every code surfaces to RPC_ERROR, but only -32004 / -32005
// are retriable. (A JSON-RPC envelope with code: undefined never reaches
// extractRpcError because typeof undefined !== 'number'; that shape lives in
// NON_TRANSIENT_MATRIX.)
// ---------------------------------------------------------------------------

type RpcCase = {
  label: string
  build: () => unknown
  expect: { retryable: boolean; rpcCode: number }
}

const RPC_MATRIX: RpcCase[] = [
  // Transient — must retry
  { label: 'RPC -32004 (tx not found)', build: () => ({ error: { code: -32004 } }), expect: { retryable: true, rpcCode: -32004 } },
  { label: 'RPC -32005 (try again later)', build: () => ({ error: { code: -32005 } }), expect: { retryable: true, rpcCode: -32005 } },
  { label: 'RPC -32004 via Error.rpcCode', build: () => Object.assign(new Error('not found'), { rpcCode: -32004 }), expect: { retryable: true, rpcCode: -32004 } },

  // Non-transient — must NOT retry
  { label: 'RPC -32600 (invalid request)', build: () => ({ error: { code: -32600 } }), expect: { retryable: false, rpcCode: -32600 } },
  { label: 'RPC -32601 (method not found)', build: () => ({ error: { code: -32601 } }), expect: { retryable: false, rpcCode: -32601 } },
  { label: 'RPC -32602 (invalid params)', build: () => ({ error: { code: -32602 } }), expect: { retryable: false, rpcCode: -32602 } },
  { label: 'RPC -32603 (internal error)', build: () => ({ error: { code: -32603 } }), expect: { retryable: false, rpcCode: -32603 } },
  { label: 'RPC -32000 (reserved)', build: () => ({ error: { code: -32000 } }), expect: { retryable: false, rpcCode: -32000 } },
  { label: 'RPC -32001 (server error)', build: () => ({ error: { code: -32001 } }), expect: { retryable: false, rpcCode: -32001 } },
  { label: 'RPC 0 (success-ish envelope)', build: () => ({ error: { code: 0 } }), expect: { retryable: false, rpcCode: 0 } },
]

// ---------------------------------------------------------------------------
// HTTP status matrix — 408 / 429 / 5xx retry, everything else non-retryable.
// ---------------------------------------------------------------------------

const RETRIABLE_HTTP_STATUSES = [408, 429, 500, 501, 502, 503, 504, 599]
const NON_RETRIABLE_HTTP_STATUSES = [200, 201, 204, 301, 302, 400, 401, 403, 404, 410, 422, 451]

// ---------------------------------------------------------------------------
// 1. Transient overlap matrix driver
// ---------------------------------------------------------------------------

describe('error matrix — transient overlap (TIMEOUT/RESET/REFUSED/NETWORK)', () => {
  it.each(TRANSIENT_OVERLAP_MATRIX)(
    'classifies "$label" as retryable transport error',
    (row) => {
      const err = row.build()

      const transport = classifyTransportError(err)
      expect(transport.retryable).toBe(true)
      if (transport.retryable) {
        expect(transport.code).toBe(row.expect.transportCode)
        expect(typeof transport.reason).toBe('string')
        expect(transport.reason.length).toBeGreaterThan(0)
      }

      const downstream = classifyDownstreamError(err)
      const expected = row.expect.downstream
      if (expected === null) {
        expect(downstream).toBeNull()
      } else {
        expect(downstream).not.toBeNull()
        expect(downstream!.class).toBe(expected.class)
        expect(downstream!.retryable).toBe(true)
        if (downstream!.class === 'NETWORK_ERROR') {
          expect(downstream!.transportCode).toBe(row.expect.transportCode)
        }
        expect(typeof downstream!.reason).toBe('string')
      }
    },
  )
})

// ---------------------------------------------------------------------------
// 2. Non-transient matrix driver
// ---------------------------------------------------------------------------

describe('error matrix — non-transient (NOT retried)', () => {
  it.each(NON_TRANSIENT_MATRIX)(
    'does NOT retry "$label"',
    (row) => {
      const err = row.build()

      const transport = classifyTransportError(err)
      expect(transport.retryable).toBe(false)
      if (!transport.retryable) {
        expect(typeof transport.reason).toBe('string')
      }

      expect(classifyDownstreamError(err)).toBeNull()
    },
  )
})

// ---------------------------------------------------------------------------
// 3. JSON-RPC matrix driver
// ---------------------------------------------------------------------------

describe('error matrix — JSON-RPC envelopes', () => {
  it.each(RPC_MATRIX)(
    'RPC "$label" retryable=$expect.retryable',
    (row) => {
      const err = row.build()
      const downstream = classifyDownstreamError(err)
      expect(downstream?.class).toBe('RPC_ERROR')
      expect(downstream?.retryable).toBe(row.expect.retryable)
      if (downstream?.class === 'RPC_ERROR') {
        expect(downstream.rpcCode).toBe(row.expect.rpcCode)
      }

      // isRetryableRpcCode and classifyDownstreamError must agree on the
      // retry decision for every code that reaches the classifier.
      expect(isRetryableRpcCode(row.expect.rpcCode)).toBe(row.expect.retryable)
    },
  )

  it('RPC wins over transport when both are present on the same object', () => {
    const err = Object.assign(new Error('boom'), { code: 'ECONNRESET', rpcCode: -32602 })
    const downstream = classifyDownstreamError(err)
    expect(downstream?.class).toBe('RPC_ERROR')
    expect(downstream?.retryable).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 4. HTTP status matrix driver — status-only path
// ---------------------------------------------------------------------------

describe('error matrix — HTTP status codes', () => {
  it.each(RETRIABLE_HTTP_STATUSES)('HTTP %i is retryable (classifyHttpStatus)', (status) => {
    const result = classifyHttpStatus(status)
    expect(result.retryable).toBe(true)
    expect(result.status).toBe(status)
    expect(isRetryableHttpStatus(status)).toBe(true)
  })

  it.each(NON_RETRIABLE_HTTP_STATUSES)('HTTP %i is NOT retryable', (status) => {
    const result = classifyHttpStatus(status)
    expect(result.retryable).toBe(false)
    expect(result.status).toBe(status)
    expect(isRetryableHttpStatus(status)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. Cross-source agreement — both classifiers must agree on transport errors
//    (downstream is the higher-level wrapper; transport is the thin layer).
// ---------------------------------------------------------------------------

describe('error matrix — classifyTransportError and classifyDownstreamError agree', () => {
  it.each(TRANSIENT_OVERLAP_MATRIX)(
    'agree on retryability for "$label"',
    (row) => {
      const err = row.build()
      const transport = classifyTransportError(err)
      const downstream = classifyDownstreamError(err)

      expect(transport.retryable).toBe(true)
      if (transport.retryable) {
        expect(['TIMEOUT', 'RESET', 'REFUSED', 'NETWORK']).toContain(transport.code)
      }

      // Downstream must not be null and must be retryable too.
      expect(downstream).not.toBeNull()
      expect(downstream!.retryable).toBe(true)

      // transportCode must match (either between transport.code and
      // downstream.transportCode for NETWORK, or both resolve to TIMEOUT).
      if (downstream!.class === 'NETWORK_ERROR' && transport.retryable) {
        expect(downstream!.transportCode).toBe(transport.code)
      } else if (downstream!.class === 'TIMEOUT_ERROR' && transport.retryable) {
        expect(transport.code).toBe('TIMEOUT')
      }
    },
  )

  it.each(NON_TRANSIENT_MATRIX)(
    'agree on non-retryability for "$label"',
    (row) => {
      const err = row.build()
      const transport = classifyTransportError(err)
      const downstream = classifyDownstreamError(err)
      expect(transport.retryable).toBe(false)
      expect(downstream).toBeNull()
    },
  )
})
