import type { Queryable } from '../db/repositories/queryable.js'

export async function up(db: Queryable): Promise<void> {
    // Add next_attempt_at column and allow 'dead_letter' in status check
    await db.query(`
    DO $$
    DECLARE
      c record;
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'event_outbox' AND column_name = 'next_attempt_at') THEN
        ALTER TABLE event_outbox ADD COLUMN next_attempt_at TIMESTAMPTZ;
      END IF;

      -- Drop any existing CHECK constraints on the table, then add a named one allowing dead_letter
      FOR c IN SELECT conname FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid WHERE rel.relname = 'event_outbox' AND con.contype = 'c' LOOP
        BEGIN
          EXECUTE format('ALTER TABLE event_outbox DROP CONSTRAINT %I', c.conname);
        EXCEPTION WHEN OTHERS THEN
          NULL;
        END;
      END LOOP;

      BEGIN
        EXECUTE 'ALTER TABLE event_outbox ADD CONSTRAINT event_outbox_status_check CHECK (status IN (''pending'', ''processing'', ''published'', ''failed'', ''dead_letter''))';
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;

      BEGIN
        EXECUTE 'CREATE INDEX IF NOT EXISTS event_outbox_next_attempt_idx ON event_outbox (next_attempt_at) WHERE status = ''pending''';
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
    END$$;
  `)
}

export async function down(db: Queryable): Promise<void> {
    // Attempt to revert changes (best-effort)
    await db.query(`
    DO $$
    DECLARE
      c record;
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'event_outbox' AND column_name = 'next_attempt_at') THEN
        ALTER TABLE event_outbox DROP COLUMN IF EXISTS next_attempt_at;
      END IF;

      FOR c IN SELECT conname FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid WHERE rel.relname = 'event_outbox' AND con.contype = 'c' LOOP
        BEGIN
          EXECUTE format('ALTER TABLE event_outbox DROP CONSTRAINT %I', c.conname);
        EXCEPTION WHEN OTHERS THEN
          NULL;
        END;
      END LOOP;

      BEGIN
        EXECUTE 'ALTER TABLE event_outbox ADD CONSTRAINT event_outbox_status_check CHECK (status IN (''pending'', ''processing'', ''published'', ''failed''))';
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;

      BEGIN
        EXECUTE 'DROP INDEX IF EXISTS event_outbox_next_attempt_idx';
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
    END$$;
  `)
}
