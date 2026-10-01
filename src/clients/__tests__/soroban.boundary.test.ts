/**
 * Boundary and recovery coverage for the Soroban configuration/constant surface.
 *
 * The runtime constants that govern Soroban outbound behaviour are spread across
 * three modules — the client's defaults (src/clients/soroban.ts), the shared
 * timeout budget and retry caps (src/lib/timeouts.ts, src/lib/retryPolicy.ts),
 * and the env schema (src/config/index.ts). These tests pin the edges of each:
 * clamping, malformed input, retry exhaustion, breaker recovery, and the
 * transport-error classification that decides whether a failure is retried.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SorobanClient, SorobanClientError } from '../soroban.js'
import { resetCircuitBreakers } from '../circuitBreaker.js'
import { DEFAULT_TIMEOUT_BUDGETS, TIMEOUT_HARD_CAPS } from '../../lib/timeouts.js'
import { RETRY_POLICY_HARD_CAPS } from '../../lib/retryPolicy.js'

const RPC_URL = 'https://soroban-boundary.stellar.org'
const NETWORK = 'testnet' as const
const CONTRACT_ID = 'CBOUNDARYTEST'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    rpcUrl: RPC_URL,
    network: NETWORK,
    contractId: CONTRACT_ID,
    ...overrides,
  } as ConstructorParameters<typeof SorobanClient>[0]
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function rpcResult(result: unknown, id = 'getIdentityState-1'): Response {
  return jsonResponse({ jsonrpc: '2.0', id, result })
}

/** No-op sleep: keeps retry tests free of wall-clock waits. */
const instantSleep = (): Promise<void> => Promise.resolve()

/** Sleep that advances fake timers, so backoff delays stay observable. */
function fakeTimerSleep() {
  return vi.fn((ms: number) => {
    vi.advanceTimersByTime(ms)
    return Promise.resolve()
  })
}

/**
 * fetch mock that never settles, mimicking a hung RPC node. Records the
 * AbortSignal per call and rejects with a real AbortError when the client's
 * timeout budget fires, the way undici does.
 */
function hangingFetch(signals: AbortSignal[]) {
  return vi.fn((_url: string, init: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init.signal as AbortSignal
      signals.push(signal)
      signal.addEventListener(
        'abort',
        () => reject(new DOMException('The operation was aborted.', 'AbortError')),
        { once: true },
      )
    })
  })
}

/** Parses the JSON-RPC body of the nth fetch call. */
function requestBody(fetchMock: ReturnType<typeof vi.fn>, call = 0): any {
  return JSON.parse((fetchMock.mock.calls[call][1] as RequestInit).body as string)
}

// ─── Environment isolation ───────────────────────────────────────────────────

const ENV_KEYS = [
  'DB_URL',
  'SOROBAN_CIRCUIT_BREAKER_FAILURE_THRESHOLD',
  'SOROBAN_CIRCUIT_BREAKER_COOLDOWN_MS',
] as const

let savedEnv: Record<string, string | undefined> = {}

/**
 * Forces validateConfig() to throw so the client's env-fallback branch is
 * taken, then applies the given breaker env values. Restored in afterEach.
 */
function setEnv(values: Record<string, string>): void {
  process.env.DB_URL = 'not-a-valid-url' // guarantees validateConfig() throws
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value
  }
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of ENV_KEYS) {
    delete process.env[key]
  }
  resetCircuitBreakers()
  vi.clearAllMocks()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  resetCircuitBreakers()
  vi.useRealTimers()
})

// ─── Address validation ───────────────────────────────────────────────────────

describe('getIdentityState — address validation boundaries', () => {
  const cases: Array<[string, unknown]> = [
    ['empty string', ''],
    ['whitespace only', '   '],
    ['tab/newline only', '\t\n'],
    ['undefined', undefined],
    ['null', null],
  ]

  for (const [label, address] of cases) {
    it(`rejects ${label} with a CONFIG_ERROR before issuing any request`, async () => {
      const fetchMock = vi.fn()
      const client = new SorobanClient(baseConfig(), {
        fetchFn: fetchMock as never,
        sleepFn: instantSleep,
      })

      const error = await client
        .getIdentityState(address as string)
        .then(() => null)
        .catch((e) => e)

      expect(error).toBeInstanceOf(SorobanClientError)
      expect(error.code).toBe('CONFIG_ERROR')
      // Fail fast: an invalid address must never reach the network, so a bad
      // input cannot consume RPC quota or trip the breaker for the host.
      expect(fetchMock).not.toHaveBeenCalled()
    })
  }

  it('rejects invalid input without consuming a circuit-breaker failure slot', async () => {
    const fetchMock = vi.fn().mockResolvedValue(rpcResult({ state: 'active' }))
    const client = new SorobanClient(
      baseConfig({ circuitBreaker: { failureThreshold: 1, cooldownPeriodMs: 60_000 } }),
      { fetchFn: fetchMock as never, sleepFn: instantSleep },
    )

    for (let i = 0; i < 10; i += 1) {
      await client.getIdentityState('  ').catch(() => undefined)
    }

    // A validation error is not a host failure: the breaker must stay CLOSED.
    await expect(client.getIdentityState('GVALID')).resolves.toEqual({ state: 'active' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('forwards a well-formed address verbatim without mutating it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(rpcResult({ state: 'active' }))
    const client = new SorobanClient(baseConfig(), {
      fetchFn: fetchMock as never,
      sleepFn: instantSleep,
    })

    const address = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
    await client.getIdentityState(address)

    const body = requestBody(fetchMock)
    expect(body.method).toBe('getContractData')
    expect(body.params.key).toEqual({ type: 'identity', address })
    expect(body.params.contractId).toBe(CONTRACT_ID)
    expect(body.params.network).toBe(NETWORK)
  })

  it('scopes the JSON-RPC id to the attempt number', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(rpcResult({ state: 'active' }, 'getContractData-2'))
    const sleepFn = fakeTimerSleep()
    vi.useFakeTimers()

    const client = new SorobanClient(baseConfig({ retry: { maxAttempts: 3 } }), {
      fetchFn: fetchMock as never,
      sleepFn,
    })
    await client.getIdentityState('GA')

    // The id is derived from the JSON-RPC method and the attempt counter, so a
    // retried request is distinguishable in RPC-side logs.
    expect(requestBody(fetchMock, 0).id).toBe('getContractData-1')
    expect(requestBody(fetchMock, 1).id).toBe('getContractData-2')
  })
})

// ─── Cursor and pagination boundaries ─────────────────────────────────────────

describe('getContractEvents — cursor boundaries and pagination recovery', () => {
  function eventsClient(fetchMock: ReturnType<typeof vi.fn>) {
    return new SorobanClient(baseConfig(), {
      fetchFn: fetchMock as never,
      sleepFn: instantSleep,
    })
  }

  it('omits the cursor param entirely when no cursor is supplied', async () => {
    const fetchMock = vi.fn().mockResolvedValue(rpcResult({ events: [] }, 'getEvents-1'))
    await eventsClient(fetchMock).getContractEvents()

    const body = requestBody(fetchMock)
    expect(body.params).not.toHaveProperty('cursor')
    expect(body.params.contractIds).toEqual([CONTRACT_ID])
  })

  it('omits the cursor param for an empty-string cursor (falsy boundary)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(rpcResult({ events: [] }, 'getEvents-1'))
    await eventsClient(fetchMock).getContractEvents('')

    // An empty cursor is not a valid "start from the beginning" marker for the
    // RPC; sending it would be forwarded verbatim and rejected upstream.
    expect(requestBody(fetchMock).params).not.toHaveProperty('cursor')
  })

  it('forwards a non-empty cursor verbatim', async () => {
    const fetchMock = vi.fn().mockResolvedValue(rpcResult({ events: [] }, 'getEvents-1'))
    await eventsClient(fetchMock).getContractEvents('000000000429-00000001')

    expect(requestBody(fetchMock).params.cursor).toBe('000000000429-00000001')
  })

  it('prefers latestCursor over the legacy cursor field', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        rpcResult({ events: [], latestCursor: 'cursor-new', cursor: 'cursor-old' }, 'getEvents-1'),
      )

    const page = await eventsClient(fetchMock).getContractEvents()

    expect(page.cursor).toBe('cursor-new')
  })

  it('falls back to cursor when latestCursor is absent', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(rpcResult({ events: [], cursor: 'cursor-legacy' }, 'getEvents-1'))

    const page = await eventsClient(fetchMock).getContractEvents()

    expect(page.cursor).toBe('cursor-legacy')
  })

  it('returns a null cursor when the response carries none', async () => {
    const fetchMock = vi.fn().mockResolvedValue(rpcResult({ events: [] }, 'getEvents-1'))

    const page = await eventsClient(fetchMock).getContractEvents()

    expect(page.cursor).toBeNull()
  })

  it('normalizes a missing events array to an empty list', async () => {
    const fetchMock = vi.fn().mockResolvedValue(rpcResult({ latestCursor: null }, 'getEvents-1'))

    const page = await eventsClient(fetchMock).getContractEvents()

    expect(page.events).toEqual([])
  })

  it('normalizes a null events array to an empty list', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(rpcResult({ events: null, latestCursor: null }, 'getEvents-1'))

    const page = await eventsClient(fetchMock).getContractEvents()

    expect(page.events).toEqual([])
  })

  it('normalizes a non-array events payload to an empty list', async () => {
    // A malformed RPC node must not hand callers a non-iterable value.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(rpcResult({ events: 'not-an-array' }, 'getEvents-1'))

    const page = await eventsClient(fetchMock).getContractEvents()

    expect(page.events).toEqual([])
  })

  it('preserves every field of a returned event without loss', async () => {
    const events = [
      { id: 'evt-1', type: 'bond', ledger: 42, topic: ['a', 'b'], value: { amount: 7 } },
      { id: 'evt-2', type: 'attestation', ledger: 43, extra: { nested: true } },
    ]
    const fetchMock = vi
      .fn()
      .mockResolvedValue(rpcResult({ events, latestCursor: 'c1' }, 'getEvents-1'))

    const page = await eventsClient(fetchMock).getContractEvents()

    expect(page.events).toEqual(events)
  })

  it('handles a large event page without truncation', async () => {
    const events = Array.from({ length: 250 }, (_, i) => ({ id: `evt-${i}`, ledger: i }))
    const fetchMock = vi
      .fn()
      .mockResolvedValue(rpcResult({ events, latestCursor: 'c' }, 'getEvents-1'))

    const page = await eventsClient(fetchMock).getContractEvents()

    expect(page.events).toHaveLength(250)
    expect(page.events[249].id).toBe('evt-249')
  })

  it('round-trips page 1 cursor into the page 2 request', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rpcResult({ events: [{ id: 'a' }], latestCursor: 'page-2' }, 'getEvents-1'))
      .mockResolvedValueOnce(rpcResult({ events: [{ id: 'b' }], latestCursor: 'page-3' }, 'getEvents-2'))
    const client = eventsClient(fetchMock)

    const first = await client.getContractEvents()
    const second = await client.getContractEvents(first.cursor ?? undefined)

    expect(requestBody(fetchMock, 1).params.cursor).toBe('page-2')
    expect(second.events).toEqual([{ id: 'b' }])
  })

  it('resumes from a stale cursor after a transient failure', async () => {
    const sleepFn = fakeTimerSleep()
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(rpcResult({ events: [{ id: 'b' }], latestCursor: 'c' }, 'getEvents-2'))
    const client = new SorobanClient(baseConfig({ retry: { maxAttempts: 2 } }), {
      fetchFn: fetchMock as never,
      sleepFn,
    })

    const page = await client.getContractEvents('stale-cursor')

    // The retry must re-send the same cursor — never a reset or dropped one,
    // which would silently re-read ledger 1 and duplicate or skip events.
    expect(requestBody(fetchMock, 1).params.cursor).toBe('stale-cursor')
    expect(page.events).toEqual([{ id: 'b' }])
  })
})

// ─── Timeout budget boundaries ───────────────────────────────────────────────

describe('Soroban timeout budget boundaries', () => {
  const budget = DEFAULT_TIMEOUT_BUDGETS.soroban

  async function captureAbortTime(
    timeoutMs: number | undefined,
  ): Promise<{ abortedAt: number; error: SorobanClientError }> {
    const signals: AbortSignal[] = []
    vi.useFakeTimers()
    const client = new SorobanClient(
      baseConfig({
        timeoutMs,
        retry: { maxAttempts: 1 },
        circuitBreaker: { failureThreshold: 1, cooldownPeriodMs: 60_000 },
      }),
      { fetchFn: hangingFetch(signals) as never, sleepFn: instantSleep },
    )

    const settled = client.getIdentityState('GA').catch((e) => e)
    await vi.advanceTimersByTimeAsync(0)
    expect(signals).toHaveLength(1)

    // Step in 1ms increments up to the expected budget to find the exact
    // virtual millisecond at which the signal aborts.
    const ceiling = Math.min(budget.maxMs, TIMEOUT_HARD_CAPS.soroban.maxMs) + 5
    let abortedAt = -1
    for (let t = 1; t <= ceiling; t += 1) {
      await vi.advanceTimersByTimeAsync(1)
      if (signals[0].aborted) {
        abortedAt = t
        break
      }
    }

    const error = await settled
    return { abortedAt, error }
  }

  it('clamps a below-minimum timeout up to the budget floor', async () => {
    const { abortedAt } = await captureAbortTime(1)
    expect(abortedAt).toBe(budget.minMs)
    expect(budget.minMs).toBe(100)
  })

  it('honors a timeout set exactly at the budget floor', async () => {
    const { abortedAt } = await captureAbortTime(budget.minMs)
    expect(abortedAt).toBe(budget.minMs)
  })

  it('uses the budget default when no timeout is supplied', async () => {
    const { abortedAt } = await captureAbortTime(undefined)
    expect(abortedAt).toBe(budget.defaultMs)
  })

  it('clamps an above-maximum timeout down to the budget ceiling', async () => {
    const { abortedAt } = await captureAbortTime(600_000)
    expect(abortedAt).toBe(budget.maxMs)
  })

  it('never exceeds the hard cap even for absurd timeout values', async () => {
    const { abortedAt } = await captureAbortTime(Number.MAX_SAFE_INTEGER)
    expect(abortedAt).toBeLessThanOrEqual(TIMEOUT_HARD_CAPS.soroban.maxMs)
    expect(abortedAt).toBeLessThanOrEqual(budget.maxMs)
  })

  it('classifies a genuine RPC timeout as TIMEOUT_ERROR', async () => {
    const signals: AbortSignal[] = []
    vi.useFakeTimers()
    const client = new SorobanClient(
      baseConfig({ timeoutMs: 100, retry: { maxAttempts: 1 } }),
      { fetchFn: hangingFetch(signals) as never, sleepFn: instantSleep },
    )

    const settled = client.getIdentityState('GA').catch((e) => e)
    await vi.advanceTimersByTimeAsync(200)
    const error = await settled

    // Regression: the abort race used to reject with a plain Error, so genuine
    // timeouts were reported as NETWORK_ERROR and were indistinguishable from
    // connection failures in logs and metrics.
    expect(error).toBeInstanceOf(SorobanClientError)
    expect(error.code).toBe('TIMEOUT_ERROR')
    expect(error.message).toContain('timed out')
  })

  it('surfaces the effective timeout in the error message for diagnosis', async () => {
    const signals: AbortSignal[] = []
    vi.useFakeTimers()
    const client = new SorobanClient(
      baseConfig({ timeoutMs: 600_000, retry: { maxAttempts: 1 } }),
      { fetchFn: hangingFetch(signals) as never, sleepFn: instantSleep },
    )

    const settled = client.getIdentityState('GA').catch((e) => e)
    await vi.advanceTimersByTimeAsync(16_000)
    const error = await settled

    // The message must report the clamped budget actually applied, not the
    // requested one, or operators cannot reconcile the failure with config.
    expect(error.message).toContain(`${budget.maxMs}ms`)
  })

  it('does not leave a pending timeout timer after a fast success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(rpcResult({ state: 'active' }))
    vi.useFakeTimers()
    const client = new SorobanClient(baseConfig({ timeoutMs: 5_000 }), {
      fetchFn: fetchMock as never,
      sleepFn: instantSleep,
    })

    await client.getIdentityState('GA')
    // A leaked timer would abort an already-completed request's signal and keep
    // the event loop alive; with 5s still pending, clearing worked.
    expect(vi.getTimerCount()).toBe(0)
  })
})

// ─── Retry policy caps ────────────────────────────────────────────────────────

describe('Soroban retry policy boundaries', () => {
  it('caps maxAttempts at the hard limit and stops issuing requests', async () => {
    const sleepFn = fakeTimerSleep()
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    const client = new SorobanClient(
      baseConfig({ retry: { maxAttempts: 999 } }),
      { fetchFn: fetchMock as never, sleepFn },
    )

    await expect(client.getIdentityState('GA')).rejects.toThrow(SorobanClientError)

    expect(fetchMock).toHaveBeenCalledTimes(RETRY_POLICY_HARD_CAPS.maxAttempts)
    expect(sleepFn).toHaveBeenCalledTimes(RETRY_POLICY_HARD_CAPS.maxAttempts - 1)
  })

  it('treats a non-positive maxAttempts as a single attempt', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    const client = new SorobanClient(baseConfig({ retry: { maxAttempts: 0 } }), {
      fetchFn: fetchMock as never,
      sleepFn: instantSleep,
    })

    await expect(client.getIdentityState('GA')).rejects.toThrow(SorobanClientError)

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('caps an unbounded base delay at the hard limit', async () => {
    const sleepFn = fakeTimerSleep()
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(rpcResult({ state: 'active' }, 'getIdentityState-2'))
    const client = new SorobanClient(
      baseConfig({
        retry: {
          maxAttempts: 2,
          baseDelayMs: 10_000_000,
          maxDelayMs: 10_000_000,
          backoffMultiplier: 2,
          jitterStrategy: 'none',
        },
      }),
      { fetchFn: fetchMock as never, sleepFn },
    )

    await client.getIdentityState('GA')

    expect(sleepFn).toHaveBeenCalledWith(RETRY_POLICY_HARD_CAPS.baseDelayMs)
  })

  it('holds the first backoff at the configured base delay', async () => {
    const sleepFn = fakeTimerSleep()
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(rpcResult({ state: 'active' }, 'getIdentityState-2'))
    const client = new SorobanClient(
      baseConfig({ retry: { maxAttempts: 2, baseDelayMs: 50, maxDelayMs: 5_000 } }),
      { fetchFn: fetchMock as never, sleepFn },
    )

    await client.getIdentityState('GA')

    expect(sleepFn).toHaveBeenCalledWith(50)
  })

  it('clamps the backoff ceiling when maxDelayMs sits below baseDelayMs', async () => {
    const sleepFn = fakeTimerSleep()
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(rpcResult({ state: 'active' }, 'getIdentityState-2'))
    // enforceRetryPolicyCaps guarantees maxDelayMs >= baseDelayMs; without it
    // the sleep could be zero and hot-loop the retry storm.
    const client = new SorobanClient(
      baseConfig({ retry: { maxAttempts: 2, baseDelayMs: 900, maxDelayMs: 5 } }),
      { fetchFn: fetchMock as never, sleepFn },
    )

    await client.getIdentityState('GA')

    expect(sleepFn).toHaveBeenCalledWith(900)
  })
})

// ─── Malformed responses and body-read failures ───────────────────────────────

describe('Soroban malformed-response and body-read recovery', () => {
  function client(fetchMock: ReturnType<typeof vi.fn>, maxAttempts = 1) {
    return new SorobanClient(baseConfig({ retry: { maxAttempts } }), {
      fetchFn: fetchMock as never,
      sleepFn: fakeTimerSleep(),
    })
  }

  it('reports a non-JSON body as PARSE_ERROR without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('<html>502 Bad Gateway</html>'))
    vi.useFakeTimers()

    const error = await client(fetchMock)
      .getIdentityState('GA')
      .then(() => null)
      .catch((e) => e)

    expect(error.code).toBe('PARSE_ERROR')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports a response missing the result field as PARSE_ERROR', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ jsonrpc: '2.0', id: 'x' }))
    vi.useFakeTimers()

    const error = await client(fetchMock)
      .getIdentityState('GA')
      .then(() => null)
      .catch((e) => e)

    expect(error.code).toBe('PARSE_ERROR')
    expect(error.message).toContain('missing result')
  })

  it('treats an explicit null result as a valid empty state, not a parse failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue(rpcResult(null))
    vi.useFakeTimers()

    // `undefined` means malformed; `null` is a legitimate "no state" answer and
    // must not be retried as a broken response.
    await expect(client(fetchMock).getIdentityState('GA')).resolves.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports a connection reset during body read as NETWORK_ERROR and retries', async () => {
    vi.useFakeTimers()
    const resetError = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.reject(resetError),
      })
      .mockResolvedValueOnce(rpcResult({ state: 'active' }, 'getIdentityState-2'))

    const result = await client(fetchMock, 2).getIdentityState('GA')

    expect(result).toEqual({ state: 'active' })
  })

  it('reports an abort during body read as TIMEOUT_ERROR, not PARSE_ERROR', async () => {
    vi.useFakeTimers()
    const abortError = new DOMException('aborted', 'AbortError')
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.reject(abortError),
    })

    const error = await client(fetchMock)
      .getIdentityState('GA')
      .then(() => null)
      .catch((e) => e)

    // A body read interrupted by the timeout must stay retryable; misreading it
    // as PARSE_ERROR would make a real timeout look like a permanent fault.
    expect(error.code).toBe('TIMEOUT_ERROR')
  })

  it('surfaces RPC error code, message, and data without leaking internals', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        jsonrpc: '2.0',
        id: 'x',
        error: { code: -32602, message: 'Invalid params', data: { field: 'address' } },
      }),
    )
    vi.useFakeTimers()

    const error = await client(fetchMock)
      .getIdentityState('GA')
      .then(() => null)
      .catch((e) => e)

    expect(error.code).toBe('RPC_ERROR')
    expect(error.rpcCode).toBe(-32602)
    expect(error.message).toContain('Invalid params')
    expect(error.details).toEqual({ field: 'address' })
  })
})

// ─── Retryable classification boundaries ──────────────────────────────────────

describe('Soroban retryable HTTP status boundaries', () => {
  async function failWithStatus(status: number, maxAttempts = 3) {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status }))
    vi.useFakeTimers()
    const client = new SorobanClient(baseConfig({ retry: { maxAttempts } }), {
      fetchFn: fetchMock as never,
      sleepFn: fakeTimerSleep(),
    })
    const error = await client
      .getIdentityState('GA')
      .then(() => null)
      .catch((e) => e)
    return { error, calls: fetchMock.mock.calls.length }
  }

  it.each([408, 429, 500, 502, 503, 599])(
    'retries HTTP %i',
    async (status) => {
      const { error, calls } = await failWithStatus(status)
      expect(calls).toBe(3)
      expect(error.code).toBe('HTTP_ERROR')
      expect(error.status).toBe(status)
    },
  )

  it.each([400, 401, 403, 404, 409, 499])(
    'does not retry HTTP %i',
    async (status) => {
      const { error, calls } = await failWithStatus(status)
      expect(calls).toBe(1)
      expect(error.code).toBe('HTTP_ERROR')
    },
  )

  it('treats 500 as the retriable boundary and 499 as permanent', async () => {
    const fiveHundred = await failWithStatus(500)
    const fourNinetyNine = await failWithStatus(499)

    expect(fiveHundred.calls).toBe(3)
    expect(fourNinetyNine.calls).toBe(1)
  })

  it.each([-32004, -32005])('retries transient RPC error %i', async (rpcCode) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ jsonrpc: '2.0', id: 'x', error: { code: rpcCode, message: 'busy' } }),
      )
      .mockResolvedValueOnce(rpcResult({ state: 'active' }, 'getIdentityState-2'))
    vi.useFakeTimers()
    const client = new SorobanClient(baseConfig({ retry: { maxAttempts: 3 } }), {
      fetchFn: fetchMock as never,
      sleepFn: fakeTimerSleep(),
    })

    await expect(client.getIdentityState('GA')).resolves.toEqual({ state: 'active' })
  })

  it('does not retry an RPC error with no code', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ jsonrpc: '2.0', id: 'x', error: { message: 'unknown' } }),
    )
    vi.useFakeTimers()
    const client = new SorobanClient(baseConfig({ retry: { maxAttempts: 3 } }), {
      fetchFn: fetchMock as never,
      sleepFn: fakeTimerSleep(),
    })

    await expect(client.getIdentityState('GA')).rejects.toThrow(SorobanClientError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

// ─── Circuit breaker configuration boundaries ─────────────────────────────────

describe('Soroban circuit breaker configuration boundaries', () => {
  it('applies built-in defaults when no env configuration exists', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    const client = new SorobanClient(baseConfig({ retry: { maxAttempts: 1 } }), {
      fetchFn: fetchMock as never,
      sleepFn: instantSleep,
    })

    for (let i = 0; i < 5; i += 1) {
      await client.getIdentityState('GA').catch(() => undefined)
    }
    const sixth = await client.getIdentityState('GA').catch((e) => e)

    // Default threshold is 5: five failures trip it, the sixth never hits network.
    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(sixth.message).toContain('circuit breaker is OPEN')
  })

  it('honours a valid env threshold', async () => {
    setEnv({
      SOROBAN_CIRCUIT_BREAKER_FAILURE_THRESHOLD: '2',
      SOROBAN_CIRCUIT_BREAKER_COOLDOWN_MS: '60000',
    })
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    const client = new SorobanClient(baseConfig({ retry: { maxAttempts: 1 } }), {
      fetchFn: fetchMock as never,
      sleepFn: instantSleep,
    })

    await client.getIdentityState('GA').catch(() => undefined)
    await client.getIdentityState('GA').catch(() => undefined)
    const third = await client.getIdentityState('GA').catch((e) => e)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(third.message).toContain('circuit breaker is OPEN')
  })

  const malformed: Array<[string, string]> = [
    ['non-numeric', 'abc'],
    ['empty string', ''],
    ['whitespace', '   '],
    ['zero', '0'],
    ['negative', '-3'],
    ['fractional', '2.5'],
    ['infinity', 'Infinity'],
  ]

  for (const [label, value] of malformed) {
    it(`falls back to the default threshold for a ${label} env value`, async () => {
      setEnv({ SOROBAN_CIRCUIT_BREAKER_FAILURE_THRESHOLD: value })
      const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
      const client = new SorobanClient(baseConfig({ retry: { maxAttempts: 1 } }), {
        fetchFn: fetchMock as never,
        sleepFn: instantSleep,
      })

      for (let i = 0; i < 5; i += 1) {
        await client.getIdentityState('GA').catch(() => undefined)
      }
      const sixth = await client.getIdentityState('GA').catch((e) => e)

      // Regression: Number('abc') is NaN, and `failureCount >= NaN` is always
      // false, which silently disabled the breaker for a failing host. Falling
      // back to the default keeps the safeguard enforcing.
      expect(fetchMock).toHaveBeenCalledTimes(5)
      expect(sixth.message).toContain('circuit breaker is OPEN')
    })
  }

  it('falls back to the default cooldown for a malformed env value', async () => {
    setEnv({
      SOROBAN_CIRCUIT_BREAKER_FAILURE_THRESHOLD: '1',
      SOROBAN_CIRCUIT_BREAKER_COOLDOWN_MS: 'not-a-number',
    })
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    const client = new SorobanClient(baseConfig({ retry: { maxAttempts: 1 } }), {
      fetchFn: fetchMock as never,
      sleepFn: instantSleep,
    })

    await client.getIdentityState('GA').catch(() => undefined)
    const second = await client.getIdentityState('GA').catch((e) => e)

    // Default cooldown is 10s, so the breaker must still be OPEN immediately
    // rather than flapping into HALF_OPEN on a NaN comparison.
    expect(second.message).toContain('circuit breaker is OPEN')
  })

  it('lets explicit client config override env values', async () => {
    setEnv({
      SOROBAN_CIRCUIT_BREAKER_FAILURE_THRESHOLD: '1',
      SOROBAN_CIRCUIT_BREAKER_COOLDOWN_MS: '60000',
    })
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    const client = new SorobanClient(
      baseConfig({
        retry: { maxAttempts: 1 },
        circuitBreaker: { failureThreshold: 3, cooldownPeriodMs: 60_000 },
      }),
      { fetchFn: fetchMock as never, sleepFn: instantSleep },
    )

    for (let i = 0; i < 3; i += 1) {
      await client.getIdentityState('GA').catch(() => undefined)
    }
    const fourth = await client.getIdentityState('GA').catch((e) => e)

    // Explicit config wins: the env threshold of 1 must not apply.
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fourth.message).toContain('circuit breaker is OPEN')
  })

  it('isolates breakers per host so one bad node cannot affect another', async () => {
    vi.useFakeTimers()
    const badFetch = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    const goodFetch = vi.fn().mockResolvedValue(rpcResult({ state: 'active' }, 'getIdentityState-1'))

    const bad = new SorobanClient(
      baseConfig({ rpcUrl: 'https://bad.stellar.org', retry: { maxAttempts: 1 } }),
      { fetchFn: badFetch as never, sleepFn: instantSleep },
    )
    const good = new SorobanClient(
      baseConfig({ rpcUrl: 'https://good.stellar.org', retry: { maxAttempts: 1 } }),
      { fetchFn: goodFetch as never, sleepFn: instantSleep },
    )

    for (let i = 0; i < 6; i += 1) {
      await bad.getIdentityState('GA').catch(() => undefined)
    }

    await expect(good.getIdentityState('GA')).resolves.toEqual({ state: 'active' })
  })

  it('uses a stable breaker key for a malformed rpcUrl', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    // A non-URL rpcUrl still produces a usable host key rather than throwing,
    // so the breaker still protects the endpoint.
    const client = new SorobanClient(
      baseConfig({
        rpcUrl: 'not a url',
        retry: { maxAttempts: 1 },
        circuitBreaker: { failureThreshold: 1, cooldownPeriodMs: 60_000 },
      }),
      { fetchFn: fetchMock as never, sleepFn: instantSleep },
    )

    await client.getIdentityState('GA').catch(() => undefined)
    const second = await client.getIdentityState('GA').catch((e) => e)

    expect(second.message).toContain('circuit breaker is OPEN')
  })
})

// ─── Retry observability and exhaustion ───────────────────────────────────────

describe('Soroban retry observability and exhaustion', () => {
  it('records one retry event per attempt with the applied delay', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    const onRetryAttempt = vi.fn()
    const onRetryExhausted = vi.fn()
    const onSuccess = vi.fn()
    const client = new SorobanClient(
      baseConfig({
        retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000, backoffMultiplier: 2 },
      }),
      {
        fetchFn: fetchMock as never,
        sleepFn: fakeTimerSleep(),
        retryObserver: { onRetryAttempt, onRetryExhausted, onSuccess },
      },
    )

    await client.getIdentityState('GA').catch(() => undefined)

    expect(onRetryAttempt).toHaveBeenCalledTimes(2)
    expect(onRetryAttempt).toHaveBeenNthCalledWith(1, {
      provider: 'soroban',
      attempt: 1,
      delayMs: 100,
      errorCode: 'NETWORK_ERROR',
    })
    expect(onRetryAttempt).toHaveBeenNthCalledWith(2, {
      provider: 'soroban',
      attempt: 2,
      delayMs: 200,
      errorCode: 'NETWORK_ERROR',
    })
    expect(onRetryExhausted).toHaveBeenCalledTimes(1)
    expect(onRetryExhausted).toHaveBeenCalledWith({
      provider: 'soroban',
      attempts: 3,
      errorCode: 'NETWORK_ERROR',
    })
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it('reports the attempt count on the exhausted error', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    const client = new SorobanClient(baseConfig({ retry: { maxAttempts: 4 } }), {
      fetchFn: fetchMock as never,
      sleepFn: fakeTimerSleep(),
    })

    const error = await client
      .getIdentityState('GA')
      .then(() => null)
      .catch((e) => e)

    expect(error.attempts).toBe(4)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('reports success on the recovering attempt and no exhaustion', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(rpcResult({ state: 'active' }, 'getIdentityState-2'))
    const onRetryExhausted = vi.fn()
    const onSuccess = vi.fn()
    const client = new SorobanClient(baseConfig({ retry: { maxAttempts: 3 } }), {
      fetchFn: fetchMock as never,
      sleepFn: fakeTimerSleep(),
      retryObserver: { onRetryExhausted, onSuccess },
    })

    await client.getIdentityState('GA')

    expect(onSuccess).toHaveBeenCalledTimes(1)
    expect(onSuccess.mock.calls[0][0].provider).toBe('soroban')
    expect(onSuccess.mock.calls[0][0].attempt).toBe(2)
    expect(onRetryExhausted).not.toHaveBeenCalled()
  })

  it('emits no exhaustion event for a first-try success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(rpcResult({ state: 'active' }))
    const onRetryExhausted = vi.fn()
    const onSuccess = vi.fn()
    const client = new SorobanClient(baseConfig(), {
      fetchFn: fetchMock as never,
      sleepFn: instantSleep,
      retryObserver: { onRetryExhausted, onSuccess },
    })

    await client.getIdentityState('GA')

    expect(onSuccess.mock.calls[0][0].attempt).toBe(1)
    expect(onRetryExhausted).not.toHaveBeenCalled()
  })

  it('emits exhaustion exactly once when retries are exhausted', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    const onRetryExhausted = vi.fn()
    const client = new SorobanClient(baseConfig({ retry: { maxAttempts: 5 } }), {
      fetchFn: fetchMock as never,
      sleepFn: fakeTimerSleep(),
      retryObserver: { onRetryExhausted },
    })

    await client.getIdentityState('GA').catch(() => undefined)

    expect(onRetryExhausted).toHaveBeenCalledTimes(1)
    expect(onRetryExhausted.mock.calls[0][0].attempts).toBe(5)
  })
})

// ─── Concurrency ──────────────────────────────────────────────────────────────

describe('Soroban concurrent execution', () => {
  it('serves concurrent reads without cross-talk between requests', async () => {
    const responses: Record<string, unknown> = {
      GA1: { state: 'one' },
      GA2: { state: 'two' },
      GA3: { state: 'three' },
    }
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      return rpcResult(responses[body.params.key.address], body.id)
    })
    const client = new SorobanClient(baseConfig(), {
      fetchFn: fetchMock as never,
      sleepFn: instantSleep,
    })

    const [a, b, c] = await Promise.all([
      client.getIdentityState('GA1'),
      client.getIdentityState('GA2'),
      client.getIdentityState('GA3'),
    ])

    expect([a, b, c]).toEqual([{ state: 'one' }, { state: 'two' }, { state: 'three' }])
  })

  it('does not let a single failure leak into sibling in-flight requests', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      if (body.params.key.address === 'GABAD') {
        return new Response(null, { status: 400 })
      }
      return rpcResult({ state: 'ok' }, body.id)
    })
    const client = new SorobanClient(baseConfig(), {
      fetchFn: fetchMock as never,
      sleepFn: instantSleep,
    })

    const results = await Promise.allSettled([
      client.getIdentityState('GAOK1'),
      client.getIdentityState('GABAD'),
      client.getIdentityState('GAOK2'),
    ])

    expect(results[0].status).toBe('fulfilled')
    expect(results[1].status).toBe('rejected')
    expect(results[2].status).toBe('fulfilled')
  })

  it('isolates failures to one host when a sibling host is also failing', async () => {
    vi.useFakeTimers()
    const badFetch = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    const bad = new SorobanClient(
      baseConfig({ rpcUrl: 'https://a.stellar.org', retry: { maxAttempts: 1 } }),
      { fetchFn: badFetch as never, sleepFn: instantSleep },
    )
    const good = new SorobanClient(
      baseConfig({ rpcUrl: 'https://b.stellar.org', retry: { maxAttempts: 1 } }),
      { fetchFn: vi.fn().mockResolvedValue(rpcResult({ state: 'ok' })) as never, sleepFn: instantSleep },
    )

    const settled = await Promise.allSettled([
      bad.getIdentityState('GA'),
      good.getIdentityState('GA'),
    ])

    expect(settled[0].status).toBe('rejected')
    expect(settled[1].status).toBe('fulfilled')
  })
})
