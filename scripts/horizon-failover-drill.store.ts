// scripts/horizon-failover-drill.store.ts
//
// Minimal in-memory `Queryable` shim that understands just enough SQL to
// run `LeaseManager` end-to-end without Postgres.  Used by both the
// failover drill and its unit tests.
//
import type { QueryResult, QueryResultRow } from 'pg'
import type { Queryable } from '../src/db/repositories/queryable.js'

interface LeaseRecord {
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
  expireLease(streamName: string): void
  /** Direct read for assertions. */
  read(streamName: string): LeaseRecord | undefined
  /** Returns all rows (handy for diagnostics). */
  snapshot(): LeaseRecord[]
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
      const sql = text.trim()

      // INSERT … ON CONFLICT (acquire)
      if (sql.startsWith('INSERT INTO listener_leases')) {
        const [streamName, ownerId, expires, heartbeat] = params as [
          string, string, Date, Date,
        ]
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
        const isHeartbeat = sql.includes('lease_expires_at = $3') && sql.includes('heartbeat_at')
        const isCursor    = sql.includes('paging_token = $3')
        const isRelease   = sql.includes('lease_expires_at = heartbeat_at')

        if (isRelease) {
          const [streamName, ownerId] = params as [string, string, Date]
          const r = rows.get(streamName)
          if (r && r.owner_id === ownerId) {
            r.lease_expires_at = r.heartbeat_at
            r.updated_at = params[2] as Date
            return ok<R>([] as R[], 1)
          }
          return ok<R>([] as R[], 0)
        }

        if (isHeartbeat) {
          const [streamName, ownerId, expires, now, fencing] = params as [
            string, string, Date, Date, number,
          ]
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
          const [streamName, ownerId, token, now, fencing] = params as [
            string, string, string, Date, number,
          ]
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
      }

      // SELECT … FROM listener_leases (peek)
      if (sql.startsWith('SELECT') && sql.includes('FROM listener_leases')) {
        const [streamName] = params as [string]
        const r = rows.get(streamName)
        return ok((r ? [r] : []) as unknown as R[])
      }

      throw new Error(`InMemoryLeaseStore: unsupported SQL\n${sql}`)
    },

    expireLease(streamName: string): void {
      const r = rows.get(streamName)
      if (r) {
        const past = new Date(Date.now() - 60_000)
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
  }

  return store
}
