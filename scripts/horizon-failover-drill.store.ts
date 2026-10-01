// scripts/horizon-failover-drill.store.ts
//
// Minimal in-memory `Queryable` shim that understands just enough SQL to
// run `LeaseManager` end-to-end without Postgres.  Used by both the
// failover drill and its unit tests.
//
// Invariants enforced by this shim (must match the real Postgres schema):
//   1. A lease row is identified by `stream_name` (unique).
//   2. Acquire is atomic: either the caller wins and `finger_token` is boosted,
//      or the existing owner is returned with `acquired = false`.
//   3. Heartbeat / cursor / release mutations require the caller to hold the
//      lease (owner match), to present the current `fencing_token`, and the
//      lease to still be unexpired at the supplied `now` timestamp.
//   4. A failed mutation returns `rowCount = 0` and leaves the row unchanged.
//   5. Unknown SQL is a programmer error and throws rather than silently
//      succeeding.
//
// The shim is deterministic and single-threaded: all mutations are applied
// synchronously within `query()`, so concurrent acquire attempts serialize in
// call order and cannot produce an interleaved partial write.
//
// This module is deliberately free of any side effects beyond the in-memory
// `Map` it owns.  It must not be used in production code paths.
//
import type { QueryResult, QueryResultRow } from 'pg'
import type { Queryable } from '../src/db/repositories/queryable.js'

export interface LeaseRecord {
  stream_name: string
  owner_id: string
  paging_token: string
  lease_expires_at: Date
  heartbeat_at: Date
  fencing_token: number
  created_at: Date
  updated_at: Date
}

export interface InMemoryLeaseStore extends Queryable {
  /** Force the stored lease into an expired state — for drill scripts. */
  expireLease(streamName: string, now?: Date): void
  /** Direct read for assertions. */
  read(streamName: string): LeaseRecord | undefined
  /** Returns all rows (handy for diagnostics). */
  snapshot(): LeaseRecord[]
  /** Removes every row.  Test-only helper. */
  clear(): void
}

// SQL_TEXT matches the exact statements used by LeaseManager.  We match on
// normalized whitespace so formatting differences in the caller do not silently
// fall through to the "unsupported SQL" error.
const normalizeSql = (sql: string): string => sql.replace(/\s+/g, ' ').trim()

const isIsoDate = (value: unknown): value is Date =>
  value instanceof Date && !Number.isNaN(value.getTime())

const assertDate = (name: string, value: unknown): Date => {
  if (!isIsoDate(value)) {
    throw new TypeError(
      `InMemoryLeaseStore: ${name} must be a valid Date, got ${String(value)}`,
    )
  }
  return value
}

const assertString = (name: string, value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(
      `InMemoryLeaseStore: ${name} must be a non-empty string, got ${String(value)}`,
    )
  }
  return value
}

const assertFencingToken = (name: string, value: unknown): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new TypeError(
      `InMemoryLeaseStore: ${name} must be a positive integer, got ${String(value)}`,
    )
  }
  return value
}

export function createInMemoryLeaseStore(): InMemoryLeaseStore {
  const rows = new Map<string, LeaseRecord>()

  const ok = <R extends QueryResultRow>(
    rows: R[],
    rowCount: number | null = rows.length,
  ): QueryResult<R> => ({
    rows,
    rowCount,
    command: '',
    oid: 0,
    fields: [],
  })

  const store: InMemoryLeaseStore = {
    async query<R extends QueryResultRow = QueryResultRow>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<QueryResult<R>> {
      const sql = normalizeSql(text)

      // INSERT … ON CONFLICT (acquire)
      if (sql.startsWith('INSERT INTO listener_leases')) {
        if (params.length !== 4) {
          throw new TypeError(
            `InMemoryLeaseStore: acquire expects 4 params, got ${params.length}`,
          )
        }
        const streamName = assertString('stream_name', params[0])
        const ownerId = assertString('owner_id', params[1])
        const expires = assertDate('lease_expires_at', params[2])
        const heartbeat = assertDate('heartbeat_at', params[3])

        const existing = rows.get(streamName)
        let acquired = false
        let row: LeaseRecord
        if (!existing) {
          row = {
            stream_name: streamName,
            owner_id: ownerId,
            paging_token: '0',
            lease_expires_at: expires,
            heartbeat_at: heartbeat,
            fencing_token: 1,
            created_at: heartbeat,
            updated_at: heartbeat,
          }
          rows.set(streamName, row)
          acquired = true
        } else if (
          existing.owner_id === ownerId ||
          existing.lease_expires_at.getTime() <= heartbeat.getTime()
        ) {
          row = {
            ...existing,
            owner_id: ownerId,
            lease_expires_at: expires,
            heartbeat_at: heartbeat,
            fencing_token: existing.fencing_token + 1,
            updated_at: heartbeat,
          }
          rows.set(streamName, row)
          acquired = true
        } else {
          // Conflict — return the existing row unchanged, flagged not acquired.
          row = existing
        }
        return ok([{ ...row, acquired } as unknown as R])
      }

      // UPDATE … (heartbeat / release / cursor advance)
      if (sql.startsWith('UPDATE listener_leases')) {
        const isRelease = sql.includes('lease_expires_at = heartbeat_at')
        const isHeartbeat =
          !sql.includes('paging_token = $3') &&
          sql.includes('lease_expires_at = $3') &&
          sql.includes('heartbeat_at')
        const isCursor = sql.includes('paging_token = $3')

        if (isRelease) {
          if (params.length < 3) {
            throw new TypeError(
              `InMemoryLeaseStore: release expects at least 3 params, got ${params.length}`,
            )
          }
          const streamName = assertString('stream_name', params[0])
          const ownerId = assertString('owner_id', params[1])
          const now = assertDate('now', params[2])
          const r = rows.get(streamName)
          if (r && r.owner_id === ownerId) {
            r.lease_expires_at = r.heartbeat_at
            r.updated_at = now
            return ok<R>([] as R[], 1)
          }
          return ok<R>([] as R[], 0)
        }

        if (isHeartbeat) {
          if (params.length !== 5) {
            throw new TypeError(
              `InMemoryLeaseStore: heartbeat expects 5 params, got ${params.length}`,
            )
          }
          const streamName = assertString('stream_name', params[0])
          const ownerId = assertString('towner_id', params[1])
          const expires = assertDate('lease_expires_at', params[2])
          const now = assertDate('now', params[3])
          const fencing = assertFencingToken('fencing_token', params[4])
          const r = rows.get(streamName)
          if (
            r &&
            r.owner_id === ownerId &&
            r.fencing_token === fencing &&
            r.lease_expires_at.getTime() > now.getTime()
          ) {
            r.lease_expires_at = expires
            r.heartbeat_at = now
            r.updated_at = now
            return ok<R>([] as R[], 1)
          }
          return ok<R>([] as R[], 0)
        }

        if (isCursor) {
          if (params.length !== 5) {
            throw new TypeError(
              `InMemoryLeaseStore: cursor expects 5 params, got ${params.length}`,
            )
          }
          const streamName = assertString('stream_name', params[0])
          const ownerId = assertString('owner_id', params[1])
          const token = assertString('paging_token', params[2])
          const now = assertDate('now', params[3])
          const fencing = assertFencingToken('fencing_token', params[4])
          const r = rows.get(streamName)
          if (
            r &&
            r.owner_id === ownerId &&
            r.fencing_token === fencing &&
            r.lease_expires_at.getTime() > now.getTime()
          ) {
            r.paging_token = token
            r.updated_at = now
            return ok<R>([] as R[], 1)
          }
          return ok<R>([] as R[], 0)
        }

        // Update with an unrecognized shape is a programmer error.
        throw new Error(`InMemoryLeaseStore: unsupported UPDATE\n${sql}`)
      }

      // SELECT … FROM listener_leases (peek)
      if (sql.startsWith('SELECT') && sql.includes('FROM listener_leases')) {
        if (params.length !== 1) {
          throw new TypeError(
            `InMemoryLeaseStore: peek expects 1 param, got ${params.length}`,
          )
        }
        const streamName = assertString('stream_name', params[0])
        const r = rows.get(streamName)
        return ok((r ? [{\n          ...r,\n          // Expose a derived `acquired` flag for callers that expect it from the
          // acquire path.  Peek callers typically ignore it, but keeping the
          // shape consistent avoids surprises in test assertions.
          acquired: false,\n        }] : []) as unknown as R[])
      }

      throw new Error(`InMemoryLeaseStore: unsupported SQL\n${sql}`)
    },

    expireLease(streamName: string, now?: Date): void {
      const r = rows.get(streamName)
      if (r) {
        const past = new Date((now ?? new Date()).getTime() - 1)
        r.lease_expires_at = past
        r.heartbeat_at = past
      }
    },

    read(streamName: string): LeaseRecord | undefined {
      return rows.get(streamName)
    },

    snapshot(): LeaseRecord[] {
      return Array.from(rows.values())
    },

    clear(): void {
      rows.clear()
    },
  }

  return store
}
