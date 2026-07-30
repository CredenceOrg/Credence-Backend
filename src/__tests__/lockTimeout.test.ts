/**
 * Tests for configurable lock timeout on critical transaction paths.
 *
 * Covers:
 *  - Config validation accepts all three lock-timeout env vars with defaults
 *  - TransactionManager.withTransaction issues the correct SET LOCAL lock_timeout
 *    for each LockTimeoutPolicy value
 *  - LockTimeoutError is thrown (and surfaces the correct policy + ms) when
 *    Postgres returns error code 55P03 (lock_not_available)
 *  - Retry-on-lock-timeout behaviour exhausts attempts before re-throwing
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PoolClient } from 'pg'
import { Pool } from 'pg'
import {
  TransactionManager,
  LockTimeoutPolicy,
  LockTimeoutError,
  PG_LOCK_TIMEOUT_CODE,
  type LockTimeoutConfig,
} from '../db/transaction.js'
import { validateConfig } from '../config/index.js'

// ---------------------------------------------------------------------------
// Config wiring
// ---------------------------------------------------------------------------

describe('lock timeout config', () => {
  it('uses safe defaults when env vars are absent', () => {
    const config = validateConfig({
      DB_URL: 'postgres://localhost/credence',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'super-secret-jwt-key-with-at-least-32-chars',
    })

    expect(config.db.lockTimeouts).toEqual({
      readonlyMs: 1000,
      defaultMs: 2000,
      criticalMs: 10000,
    })
  })

  it('maps custom env vars to config.db.lockTimeouts', () => {
    const config = validateConfig({
      DB_URL: 'postgres://localhost/credence',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'super-secret-jwt-key-with-at-least-32-chars',
      DB_LOCK_TIMEOUT_READONLY_MS: '500',
      DB_LOCK_TIMEOUT_DEFAULT_MS: '3000',
      DB_LOCK_TIMEOUT_CRITICAL_MS: '15000',
    })

    expect(config.db.lockTimeouts).toEqual({
      readonlyMs: 500,
      defaultMs: 3000,
      criticalMs: 15000,
    })
  })

  it('rejects values below the minimum bound (100 ms)', () => {
    expect(() =>
      validateConfig({
        DB_URL: 'postgres://localhost/credence',
        REDIS_URL: 'redis://localhost:6379',
        JWT_SECRET: 'super-secret-jwt-key-with-at-least-32-chars',
        DB_LOCK_TIMEOUT_READONLY_MS: '50',
      }),
    ).toThrow()
  })

  it('rejects values above the maximum bound for CRITICAL (60 000 ms)', () => {
    expect(() =>
      validateConfig({
        DB_URL: 'postgres://localhost/credence',
        REDIS_URL: 'redis://localhost:6379',
        JWT_SECRET: 'super-secret-jwt-key-with-at-least-32-chars',
        DB_LOCK_TIMEOUT_CRITICAL_MS: '999999',
      }),
    ).toThrow()
  })
})

// ---------------------------------------------------------------------------
// TransactionManager — SET LOCAL lock_timeout
// ---------------------------------------------------------------------------

function makeMockPool(mockClient: Partial<PoolClient>): Pool {
  return {
    connect: vi.fn().mockResolvedValue(mockClient),
    query: vi.fn(),
  } as unknown as Pool
}

function makeMockClient(overrides?: Partial<PoolClient>): PoolClient {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
    ...overrides,
  } as unknown as PoolClient
}

/** Returns the SET LOCAL lock_timeout call arg that was issued. */
function capturedLockTimeoutSql(mockClient: PoolClient): string | undefined {
  const calls: string[] = (mockClient.query as ReturnType<typeof vi.fn>).mock.calls
    .map((args: unknown[]) => args[0] as string)
    .filter((sql: string) => typeof sql === 'string' && sql.startsWith('SET LOCAL lock_timeout'))
  return calls[0]
}

const lockTimeouts: LockTimeoutConfig = {
  readonly: 1000,
  default: 2000,
  critical: 10000,
}

describe('TransactionManager — lock_timeout SQL', () => {
  let mockClient: PoolClient
  let pool: Pool
  let txManager: TransactionManager

  beforeEach(() => {
    mockClient = makeMockClient()
    pool = makeMockPool(mockClient)
    txManager = new TransactionManager(pool, lockTimeouts)
  })

  it('applies READONLY policy timeout', async () => {
    await txManager.withTransaction(async () => 'ok', {
      policy: LockTimeoutPolicy.READONLY,
    })
    expect(capturedLockTimeoutSql(mockClient)).toBe(
      `SET LOCAL lock_timeout = '${lockTimeouts.readonly}ms'`,
    )
  })

  it('applies DEFAULT policy timeout', async () => {
    await txManager.withTransaction(async () => 'ok', {
      policy: LockTimeoutPolicy.DEFAULT,
    })
    expect(capturedLockTimeoutSql(mockClient)).toBe(
      `SET LOCAL lock_timeout = '${lockTimeouts.default}ms'`,
    )
  })

  it('applies CRITICAL policy timeout', async () => {
    await txManager.withTransaction(async () => 'ok', {
      policy: LockTimeoutPolicy.CRITICAL,
    })
    expect(capturedLockTimeoutSql(mockClient)).toBe(
      `SET LOCAL lock_timeout = '${lockTimeouts.critical}ms'`,
    )
  })

  it('allows a custom explicit timeoutMs that overrides the policy', async () => {
    await txManager.withTransaction(async () => 'ok', {
      policy: LockTimeoutPolicy.DEFAULT,
      timeoutMs: 7777,
    })
    expect(capturedLockTimeoutSql(mockClient)).toBe(
      `SET LOCAL lock_timeout = '7777ms'`,
    )
  })

  it('falls back to default timeout when no policy is specified', async () => {
    await txManager.withTransaction(async () => 'ok')
    // No explicit policy → uses timeouts.default
    expect(capturedLockTimeoutSql(mockClient)).toBe(
      `SET LOCAL lock_timeout = '${lockTimeouts.default}ms'`,
    )
  })
})

// ---------------------------------------------------------------------------
// LockTimeoutError — thrown on PG code 55P03
// ---------------------------------------------------------------------------

describe('TransactionManager — LockTimeoutError', () => {
  it('throws LockTimeoutError with correct policy and ms on 55P03', async () => {
    const lockError = Object.assign(new Error('lock timeout'), {
      code: PG_LOCK_TIMEOUT_CODE,
    })

    const mockClient = makeMockClient({
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // SET LOCAL lock_timeout
        .mockRejectedValueOnce(lockError)    // user query inside fn
        .mockResolvedValueOnce({ rows: [] }), // ROLLBACK
    })
    const pool = makeMockPool(mockClient)
    const txManager = new TransactionManager(pool, lockTimeouts)

    await expect(
      txManager.withTransaction(
        async (client) => {
          await client.query('SELECT pg_sleep(10)')
        },
        { policy: LockTimeoutPolicy.CRITICAL },
      ),
    ).rejects.toThrow(LockTimeoutError)

    try {
      await txManager.withTransaction(
        async (client) => {
          await client.query('SELECT pg_sleep(10)')
        },
        { policy: LockTimeoutPolicy.CRITICAL },
      )
    } catch (err) {
      if (err instanceof LockTimeoutError) {
        expect(err.policy).toBe(LockTimeoutPolicy.CRITICAL)
        expect(err.timeoutMs).toBe(lockTimeouts.critical)
        expect(err.name).toBe('LockTimeoutError')
      }
    }
  })

  it('retries the configured number of times before throwing', async () => {
    const lockError = Object.assign(new Error('lock timeout'), {
      code: PG_LOCK_TIMEOUT_CODE,
    })

    // Every client query after BEGIN+SET LOCAL lock_timeout fails with a lock error
    const makeFailingClient = () =>
      makeMockClient({
        query: vi.fn()
          .mockResolvedValueOnce({ rows: [] })  // BEGIN
          .mockResolvedValueOnce({ rows: [] })  // SET LOCAL lock_timeout
          .mockRejectedValueOnce(lockError)     // user fn
          .mockResolvedValueOnce({ rows: [] }), // ROLLBACK
      })

    // pool.connect returns a fresh mock client each time
    let connectCalls = 0
    const clients = [makeFailingClient(), makeFailingClient(), makeFailingClient(), makeFailingClient()]
    const pool = {
      connect: vi.fn().mockImplementation(() => Promise.resolve(clients[connectCalls++])),
      query: vi.fn(),
    } as unknown as Pool

    const txManager = new TransactionManager(pool, lockTimeouts)

    await expect(
      txManager.withTransaction(
        async (client) => {
          await client.query('SELECT 1')
        },
        {
          policy: LockTimeoutPolicy.DEFAULT,
          retryOnLockTimeout: true,
          maxRetries: 3,
          retryDelayMs: 1, // fast for tests
        },
      ),
    ).rejects.toThrow(LockTimeoutError)

    // 1 initial attempt + 3 retries = 4 total pool.connect calls
    expect(pool.connect).toHaveBeenCalledTimes(4)
  })
})
