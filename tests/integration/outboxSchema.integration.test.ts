// Integration tests for outbox schema creation and validation
import { createTestDatabase, type TestDatabase } from './testDatabase.js';
import { createOutboxSchema, dropOutboxSchema, OUTBOX_TABLE_SCHEMA, OUTBOX_INDEXES } from '../../src/db/outbox/schema.js';
import { query } from 'pg';

describe('Outbox Schema', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
    // Ensure clean state
    await db.pool.query('DROP TABLE IF EXISTS event_outbox CASCADE');
    await db.pool.query('DROP INDEX IF EXISTS event_outbox_status_created_idx');
    await db.pool.query('DROP INDEX IF EXISTS event_outbox_aggregate_idx');
    await db.pool.query('DROP INDEX IF EXISTS event_outbox_processed_at_idx');
    await db.pool.query('DROP INDEX IF EXISTS event_outbox_consumer_idx');
    await db.pool.query('DROP INDEX IF EXISTS event_outbox_lease_expires_idx');
    await db.pool.query('DROP INDEX IF EXISTS event_outbox_next_attempt_idx');
  });

  afterAll(async () => {
    await db.pool.query('DROP TABLE IF EXISTS event_outbox CASCADE');
    await db.close();
  });

  it('creates table with required columns and constraints', async () => {
    await createOutboxSchema(db.pool);
    const colsRes = await db.pool.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_name = 'event_outbox'`
    );
    const columns = colsRes.rows.map((r: any) => r.column_name);
    const expected = [
      'id',
      'aggregate_type',
      'aggregate_id',
      'event_type',
      'payload',
      'status',
      'retry_count',
      'max_retries',
      'consumer_id',
      'lease_expires_at',
      'next_attempt_at',
      'created_at',
      'processed_at',
      'error_message',
      'trace_id',
      'span_id',
      'tracestate',
      'shard_count',
      'shard_id',
      'correlation_id',
      'publish_idempotency_key',
    ];
    expected.forEach((col) => {
      expect(columns).toContain(col);
    });
    // Check status CHECK constraint includes dead_letter
    const constraintRes = await db.pool.query(
      `SELECT conname, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'event_outbox'::regclass AND contype = 'c'`
    );
    const statusConstraint = constraintRes.rows.find((r: any) =>
      r.definition.includes('status')
    );
    expect(statusConstraint).toBeDefined();
    expect(statusConstraint.definition).toMatch(/dead_letter/);
  });

  it('creates expected indexes', async () => {
    await createOutboxSchema(db.pool);
    const idxRes = await db.pool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'event_outbox'`
    );
    const idxNames = idxRes.rows.map((r: any) => r.indexname);
    const expectedIdx = [
      'event_outbox_status_created_idx',
      'event_outbox_aggregate_idx',
      'event_outbox_processed_at_idx',
      'event_outbox_consumer_idx',
      'event_outbox_lease_expires_idx',
      'event_outbox_next_attempt_idx',
    ];
    expectedIdx.forEach((idx) => {
      expect(idxNames).toContain(idx);
    });
  });

  it('dropOutboxSchema removes the table', async () => {
    await createOutboxSchema(db.pool);
    await dropOutboxSchema(db.pool);
    const check = await db.pool.query(
      `SELECT to_regclass('public.event_outbox') AS tbl`
    );
    expect(check.rows[0].tbl).toBeNull();
  });
});
