import { MigrationBuilder } from 'node-pg-migrate'

/**
 * Migration: horizon_events
 *
 * Durable, versioned ledger of every Horizon transition that was *committed*
 * to the application database (bond creation, and later withdrawal /
 * attestation streams).  Each row is a complete record of one chain event,
 * written in the SAME transaction that mutates identity/bond state and
 * advances the stream cursor, so:
 *
 *   - A record only ever exists for a committed transition.  If the
 *     surrounding transaction rolls back (provider fault, constraint
 *     violation, crash before COMMIT), no event record survives — there is
 *     no "event without state" and no "state without event" window.
 *   - `event_id` (the Horizon operation id) is the correlation identifier
 *     that ties the chain event to the resulting database state.
 *   - `paging_token` is the monotonic ordering key for the stream.
 *   - `payload` is the complete, validated event payload (JSONB), so the
 *     record is reviewable without re-querying Horizon.
 *   - `state_hash` is a deterministic hash of the identity state that the
 *     event produced; the reconciliation verifier recomputes it to detect
 *     drift (parity check).
 *
 * Idempotency: the UNIQUE index on (stream_name, event_id) makes repeated
 * delivery of the same Horizon operation a no-op (`ON CONFLICT DO NOTHING`),
 * so at-least-once replays never duplicate records and never re-run the
 * side effects.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('horizon_events', {
    id: { type: 'bigserial', primaryKey: true },
    stream_name: { type: 'text', notNull: true },
    // Horizon operation id — correlation identifier between chain and DB.
    event_id: { type: 'text', notNull: true },
    // Monotonic ordering key for the stream (Horizon paging token).
    paging_token: { type: 'text', notNull: true },
    // Ledger sequence (chain version) extracted from the paging token when
    // available; NULL when the token is opaque.
    ledger_seq: { type: 'bigint' },
    event_type: { type: 'text', notNull: true },
    // Complete, validated event payload for reviewability.
    payload: { type: 'jsonb', notNull: true },
    // Deterministic hash of the identity state produced by this event.
    state_hash: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  })

  // Idempotency: one ledger row per (stream, chain event).
  pgm.createIndex('horizon_events', ['stream_name', 'event_id'], {
    unique: true,
    name: 'uq_horizon_events_stream_event',
  })

  // Ordered scan for reconciliation / replay (documented ordering).
  pgm.createIndex('horizon_events', ['stream_name', 'paging_token'], {
    name: 'idx_horizon_events_stream_paging',
  })
  pgm.createIndex('horizon_events', ['stream_name', 'created_at'], {
    name: 'idx_horizon_events_stream_created',
  })

  pgm.sql(`
    COMMENT ON TABLE horizon_events IS
      'Versioned ledger of Horizon transitions committed to the database; written transactionally with state mutations';
    COMMENT ON COLUMN horizon_events.event_id IS
      'Horizon operation id — correlation identifier linking the chain event to committed state';
    COMMENT ON COLUMN horizon_events.state_hash IS
      'Deterministic hash of the identity state produced by this event; used by parity reconciliation';
  `)
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('horizon_events')
}
