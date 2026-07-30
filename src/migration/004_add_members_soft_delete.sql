-- =============================================================================
-- Migration: 003_add_member_soft_delete
-- Description: Create org_members table with soft-delete support.
--
-- Soft-delete design
-- ------------------
-- Hard deletion destroys auditability and makes recovery impossible.
-- Instead we set `deleted_at` to the current timestamp; all application
-- queries filter on `deleted_at IS NULL` by default.
--
-- Unique-constraint strategy
-- --------------------------
-- A standard UNIQUE(org_id, user_id) would block re-inviting a member whose
-- record has been soft-deleted.  We use a PostgreSQL PARTIAL UNIQUE INDEX
-- instead:
--
--   UNIQUE (org_id, user_id) WHERE deleted_at IS NULL
--
-- This enforces uniqueness only among active (non-deleted) members, so:
--   - Duplicate active invites are rejected.
--   - After soft-delete, the same user can be re-invited (a new row is
--     inserted and the old row is retained for audit history).
--
-- Rollback notes
-- --------------
-- Run the DOWN section to fully revert this migration.
-- All data in org_members will be permanently lost on rollback.
-- =============================================================================

-- ============================================================
-- UP
-- ============================================================

CREATE TABLE IF NOT EXISTS org_members (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID        NOT NULL,
  user_id      UUID        NOT NULL,
  email        TEXT        NOT NULL,
  role         TEXT        NOT NULL DEFAULT 'member'
                           CHECK (role IN ('owner', 'admin', 'member')),

  -- Soft-delete columns
  deleted_at   TIMESTAMPTZ NULL,         -- NULL = active; non-NULL = soft-deleted
  deleted_by   UUID        NULL,         -- ID of the admin who performed the delete

  -- Audit timestamps
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Partial unique index: enforce uniqueness only for active (non-deleted) rows.
-- Allows the same user to be re-invited to the same org after being removed.
CREATE UNIQUE INDEX IF NOT EXISTS uq_org_members_active
  ON org_members (org_id, user_id)
  WHERE deleted_at IS NULL;

-- Standard indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_org_members_org_id
  ON org_members (org_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_org_members_user_id
  ON org_members (user_id)
  WHERE deleted_at IS NULL;

-- Trigger to keep updated_at current automatically
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_org_members_updated_at
  BEFORE UPDATE ON org_members
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- DOWN  (run to rollback — ALL member data will be lost)
-- ============================================================
-- DROP TRIGGER IF EXISTS trg_org_members_updated_at ON org_members;
-- DROP FUNCTION IF EXISTS set_updated_at();
-- DROP INDEX IF EXISTS idx_org_members_user_id;
-- DROP INDEX IF EXISTS idx_org_members_org_id;
-- DROP INDEX IF EXISTS uq_org_members_active;
-- DROP TABLE IF EXISTS org_members;