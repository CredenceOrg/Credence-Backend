-- Migration: Add version column for optimistic locking
-- Defaulting to 1 ensures existing rows can be updated immediately
ALTER TABLE identities ADD COLUMN version INTEGER NOT NULL DEFAULT 1;