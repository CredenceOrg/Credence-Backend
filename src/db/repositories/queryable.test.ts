import { describe, expect, it, vi } from 'vitest'
import type { QueryResult, QueryResultRow } from 'pg'
import type { Queryable } from './queryable.js'

type UserRow = QueryResultRow & { id: string; email: string }

function result<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
  return {
    command: 'SELECT',
    fields: [],
    oid: 0,
    rowCount: rows.length,
    rows,
    _parsers: [],
  }
}

function queryableReturning<R extends QueryResultRow>(response: QueryResult<R>): Queryable {
  return {
    query: async <T extends QueryResultRow = QueryResultRow>() => response as QueryResult<T>,
  }
}

describe('Queryable', () => {
  it('supports typed rows and readonly parameter lists', async () => {
    const db: Queryable = queryableReturning(
      result<UserRow>([{ id: 'user-1', email: 'user@example.com' }]),
    )
    const params = ['user-1'] as const

    const response = await db.query<UserRow>(
      'SELECT id, email FROM users WHERE id = $1',
      params,
    )

    expect(response.rows).toEqual([{ id: 'user-1', email: 'user@example.com' }])
    expect(response.rowCount).toBe(1)
  })

  it('preserves an empty result as a successful boundary response', async () => {
    const db: Queryable = queryableReturning(result<UserRow>([]))

    const response = await db.query<UserRow>('SELECT id, email FROM users WHERE false', [])

    expect(response.rows).toEqual([])
    expect(response.rowCount).toBe(0)
  })

  it('does not invent runtime validation for query text or parameters', async () => {
    const query = vi.fn(async (text: string, params?: readonly unknown[]) =>
      result([{ text, params }]),
    )
    const db: Queryable = { query }

    const response = await db.query('   ', [])

    expect(query).toHaveBeenCalledWith('   ', [])
    expect(response.rows).toEqual([{ text: '   ', params: [] }])
  })

  it('propagates a rejected database operation without changing the error', async () => {
    const error = new Error('database unavailable')
    const db: Queryable = {
      query: async () => {
        throw error
      },
    }

    await expect(db.query('SELECT 1')).rejects.toBe(error)
  })

  it('allows a caller to retry after a transient rejection', async () => {
    const error = new Error('connection reset')
    const query = vi
      .fn<Queryable['query']>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(result<UserRow>([{ id: 'user-2', email: 'retry@example.com' }]))
    const db: Queryable = { query }

    await expect(db.query<UserRow>('SELECT id, email FROM users WHERE id = $1', ['user-2']))
      .rejects.toBe(error)
    const recovered = await db.query<UserRow>('SELECT id, email FROM users WHERE id = $1', ['user-2'])

    expect(recovered.rows).toEqual([{ id: 'user-2', email: 'retry@example.com' }])
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('keeps concurrent query calls independent', async () => {
    const query = vi.fn(async (text: string, params?: readonly unknown[]) =>
      result([{ text, params }]),
    )
    const db: Queryable = { query }

    const responses = await Promise.all([
      db.query('SELECT $1 AS value', ['first']),
      db.query('SELECT $1 AS value', ['second']),
    ])

    expect(responses.map((response) => response.rows[0])).toEqual([
      { text: 'SELECT $1 AS value', params: ['first'] },
      { text: 'SELECT $1 AS value', params: ['second'] },
    ])
    expect(query).toHaveBeenCalledTimes(2)
  })
})
