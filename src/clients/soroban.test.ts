import assert from 'node:assert/strict'
import test from 'node:test'

import { createSorobanClient, SorobanClient, SorobanClientError } from './soroban.js'

const baseConfig = {
  rpcUrl: 'https://rpc.testnet.stellar.org',
  network: 'testnet' as const,
  contractId: 'CDUMMYCONTRACTID',
}

test('throws config error for invalid network', () => {
  assert.throws(
    () =>
      new SorobanClient({
        ...baseConfig,
        network: 'devnet' as never,
      }),
    (error: unknown) => {
      assert.ok(error instanceof SorobanClientError)
      assert.equal(error.code, 'CONFIG_ERROR')
      return true
    },
  )
})

test('throws config error for missing rpcUrl', () => {
  assert.throws(
    () =>
      new SorobanClient({
        ...baseConfig,
        rpcUrl: '',
      }),
    (error: unknown) => {
      assert.ok(error instanceof SorobanClientError)
      assert.equal(error.code, 'CONFIG_ERROR')
      return true
    },
  )
})

test('throws config error for missing contractId', () => {
  assert.throws(
    () =>
      new SorobanClient({
        ...baseConfig,
        contractId: '',
      }),
    (error: unknown) => {
      assert.ok(error instanceof SorobanClientError)
      assert.equal(error.code, 'CONFIG_ERROR')
      return true
    },
  )
})

test('getIdentityState validates address input', async () => {
  const client = new SorobanClient(baseConfig, {
    fetchFn: async () =>
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'unused',
          result: {},
        }),
        { status: 200 },
      ),
  })

  await assert.rejects(client.getIdentityState('  '), (error: unknown) => {
    assert.ok(error instanceof SorobanClientError)
    assert.equal(error.code, 'CONFIG_ERROR')
    return true
  })
})

test('getIdentityState issues RPC request and returns result', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []

  const client = new SorobanClient(baseConfig, {
    fetchFn: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        method: string
        params: Record<string, unknown>
      }
      calls.push({ method: body.method, params: body.params })

      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: '1',
          result: { address: 'GABC', score: 87 },
        }),
        { status: 200 },
      )
    },
  })

  const result = await client.getIdentityState('GABC')
  assert.deepEqual(result, { address: 'GABC', score: 87 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.method, 'getContractData')
  assert.deepEqual(calls[0]?.params.key, { type: 'identity', address: 'GABC' })
})

test('getContractEvents returns normalized cursor and events', async () => {
  const client = new SorobanClient(baseConfig, {
    fetchFn: async () =>
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: '2',
          result: {
            events: [{ id: 'evt-1', ledger: 100 }],
            latestCursor: 'cursor-2',
          },
        }),
        { status: 200 },
      ),
  })

  const result = await client.getContractEvents('cursor-1')
  assert.deepEqual(result, {
    events: [{ id: 'evt-1', ledger: 100 }],
    cursor: 'cursor-2',
  })
})

test('getContractEvents returns empty defaults when payload omits fields', async () => {
  const client = new SorobanClient(baseConfig, {
    fetchFn: async () =>
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: '4',
          result: {},
        }),
        { status: 200 },
      ),
  })

  const result = await client.getContractEvents()
  assert.deepEqual(result, { events: [], cursor: null })
})

test('retries transient HTTP failures with backoff and then succeeds', async () => {
  const sleepCalls: number[] = []
  let attempt = 0

  const client = new SorobanClient(
    {
      ...baseConfig,
      retry: {
        maxAttempts: 3,
        baseDelayMs: 10,
        backoffMultiplier: 2,
        maxDelayMs: 100,
      },
    },
    {
      fetchFn: async () => {
        attempt += 1
        if (attempt < 3) {
          return new Response('unavailable', { status: 503 })
        }

        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: '3',
            result: { events: [], latestCursor: 'final-cursor' },
          }),
          { status: 200 },
        )
      },
      sleepFn: async (ms) => {
        sleepCalls.push(ms)
      },
    },
  )

  const result = await client.getContractEvents()
  assert.equal(attempt, 3)
  assert.deepEqual(sleepCalls, [10, 20])
  assert.equal(result.cursor, 'final-cursor')
})

test('retries on HTTP 429 and caps backoff at maxDelayMs', async () => {
  const sleepCalls: number[] = []
  let attempt = 0

  const client = new SorobanClient(
    {
      ...baseConfig,
      retry: {
        maxAttempts: 3,
        baseDelayMs: 100,
        backoffMultiplier: 2,
        maxDelayMs: 150,
      },
    },
    {
      fetchFn: async () => {
        attempt += 1
        if (attempt < 3) {
          return new Response('rate limited', { status: 429 })
        }

        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 'rate-limit-success',
            result: { events: [], cursor: 'done' },
          }),
          { status: 200 },
        )
      },
      sleepFn: async (ms) => {
        sleepCalls.push(ms)
      },
    },
  )

  const result = await client.getContractEvents()
  assert.equal(attempt, 3)
  assert.deepEqual(sleepCalls, [100, 150])
  assert.equal(result.cursor, 'done')
})

test('does not retry non-retryable HTTP errors', async () => {
  let attempt = 0

  const client = new SorobanClient(baseConfig, {
    fetchFn: async () => {
      attempt += 1
      return new Response('bad request', { status: 400 })
    },
  })

  await assert.rejects(client.getContractEvents(), (error: unknown) => {
    assert.ok(error instanceof SorobanClientError)
    assert.equal(error.code, 'HTTP_ERROR')
    assert.equal(error.attempts, 1)
    return true
  })

  assert.equal(attempt, 1)
})

test('retries on retryable RPC codes and succeeds', async () => {
  let attempt = 0

  const client = new SorobanClient(
    {
      ...baseConfig,
      retry: {
        maxAttempts: 3,
        baseDelayMs: 1,
        backoffMultiplier: 2,
        maxDelayMs: 5,
      },
    },
    {
      fetchFn: async () => {
        attempt += 1
        if (attempt < 3) {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: `${attempt}`,
              error: { code: -32004, message: 'temporarily unavailable' },
            }),
            { status: 200 },
          )
        }

        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 'ok',
            result: { events: [] },
          }),
          { status: 200 },
        )
      },
      sleepFn: async () => {
        return
      },
    },
  )

  const result = await client.getContractEvents()
  assert.equal(attempt, 3)
  assert.deepEqual(result.events, [])
})

test('does not retry non-retryable RPC errors', async () => {
  let attempt = 0

  const client = new SorobanClient(baseConfig, {
    fetchFn: async () => {
      attempt += 1
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'rpc-error',
          error: { code: -1, message: 'bad invocation', data: { reason: 'invalid args' } },
        }),
        { status: 200 },
      )
    },
  })

  await assert.rejects(client.getContractEvents(), (error: unknown) => {
    assert.ok(error instanceof SorobanClientError)
    assert.equal(error.code, 'RPC_ERROR')
    assert.equal(error.attempts, 1)
    assert.deepEqual(error.details, { reason: 'invalid args' })
    return true
  })

  assert.equal(attempt, 1)
})

test('retries on timeout and surfaces timeout error when exhausted', async () => {
  const client = new SorobanClient(
    {
      ...baseConfig,
      timeoutMs: 5,
      retry: {
        maxAttempts: 2,
        baseDelayMs: 1,
        backoffMultiplier: 2,
        maxDelayMs: 5,
      },
    },
    {
      fetchFn: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const abortError = new Error('Aborted')
            abortError.name = 'AbortError'
            reject(abortError)
          })
        }),
      sleepFn: async () => {
        return
      },
    },
  )

  await assert.rejects(client.getContractEvents(), (error: unknown) => {
    assert.ok(error instanceof SorobanClientError)
    assert.equal(error.code, 'TIMEOUT_ERROR')
    assert.equal(error.attempts, 2)
    return true
  })
})

test('retries on transport errors and throws network error after max attempts', async () => {
  let attempt = 0

  const client = new SorobanClient(
    {
      ...baseConfig,
      retry: {
        maxAttempts: 2,
        baseDelayMs: 1,
        backoffMultiplier: 2,
        maxDelayMs: 5,
      },
    },
    {
      fetchFn: async () => {
        attempt += 1
        throw new Error('socket hang up')
      },
      sleepFn: async () => {
        return
      },
    },
  )

  await assert.rejects(client.getContractEvents(), (error: unknown) => {
    assert.ok(error instanceof SorobanClientError)
    assert.equal(error.code, 'NETWORK_ERROR')
    assert.equal(error.attempts, 2)
    return true
  })
  assert.equal(attempt, 2)
})

test('normalizes unknown throwables as network errors', async () => {
  const client = new SorobanClient(baseConfig, {
    fetchFn: async () => {
      throw 'boom'
    },
    sleepFn: async () => {
      return
    },
  })

  await assert.rejects(client.getContractEvents(), (error: unknown) => {
    assert.ok(error instanceof SorobanClientError)
    assert.equal(error.code, 'NETWORK_ERROR')
    assert.equal(error.details, 'boom')
    return true
  })
})

test('surfaces parse error when response JSON is invalid', async () => {
  const client = new SorobanClient(baseConfig, {
    fetchFn: async () =>
      new Response('not-json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  })

  await assert.rejects(client.getContractEvents(), (error: unknown) => {
    assert.ok(error instanceof SorobanClientError)
    assert.equal(error.code, 'PARSE_ERROR')
    return true
  })
})

test('does not retry parse errors from invalid payload shape', async () => {
  let calls = 0

  const client = new SorobanClient(baseConfig, {
    fetchFn: async () => {
      calls += 1
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'no-result',
        }),
        { status: 200 },
      )
    },
  })

  await assert.rejects(client.getContractEvents(), (error: unknown) => {
    assert.ok(error instanceof SorobanClientError)
    assert.equal(error.code, 'PARSE_ERROR')
    assert.equal(error.attempts, 1)
    return true
  })

  assert.equal(calls, 1)
})

test('uses createSorobanClient factory and default global fetch dependency', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'factory',
        result: { events: [], cursor: 'factory-cursor' },
      }),
      { status: 200 },
    )

  try {
    const client = createSorobanClient(baseConfig)
    const page = await client.getContractEvents()
    assert.equal(page.cursor, 'factory-cursor')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('uses default sleep dependency during retry flow', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0

  globalThis.fetch = async () => {
    calls += 1
    if (calls === 1) {
      return new Response('temporarily unavailable', { status: 503 })
    }

    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'default-sleep',
        result: { events: [], cursor: null },
      }),
      { status: 200 },
    )
  }

  try {
    const client = createSorobanClient({
      ...baseConfig,
      retry: {
        maxAttempts: 2,
        baseDelayMs: 0,
        backoffMultiplier: 2,
        maxDelayMs: 0,
      },
    })

    const result = await client.getContractEvents()
    assert.equal(calls, 2)
    assert.equal(result.cursor, null)
  } finally {
    globalThis.fetch = originalFetch
  }
})
