-- migrations/002_create_bonds.sql
-- Idempotent migration: creates the bonds table if it does not exist.
-- Depends on: 001_create_identities
-- UP

BEGIN;

CREATE TABLE IF NOT EXISTS bonds (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id     UUID          NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  bonded_amount   NUMERIC(36,18) NOT NULL CHECK (bonded_amount >= 0),
  bond_start      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  bond_duration   INTERVAL      NOT NULL,
  bond_end        TIMESTAMPTZ   GENERATED ALWAYS AS (bond_start + bond_duration) STORED,
  slashed_amount  NUMERIC(36,18) NOT NULL DEFAULT 0 CHECK (slashed_amount >= 0),
  active          BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT slashed_lte_bonded CHECK (slashed_amount <= bonded_amount)
);

-- Index for fast look-ups by identity
CREATE INDEX IF NOT EXISTS idx_bonds_identity_id ON bonds(identity_id);
-- Index for active bond queries
CREATE INDEX IF NOT EXISTS idx_bonds_active ON bonds(identity_id) WHERE active = TRUE;

DROP TRIGGER IF EXISTS bonds_updated_at ON bonds;
CREATE TRIGGER bonds_updated_at
  BEFORE UPDATE ON bonds
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE  bonds                IS 'Bond records representing staked/locked value tied to an identity.';
COMMENT ON COLUMN bonds.id             IS 'Surrogate UUID primary key.';
COMMENT ON COLUMN bonds.identity_id    IS 'Foreign key to identities.id – the bonding participant.';
COMMENT ON COLUMN bonds.bonded_amount  IS 'Total amount bonded (18-decimal precision for token values).';
COMMENT ON COLUMN bonds.bond_start     IS 'Timestamp when the bond period began.';
COMMENT ON COLUMN bonds.bond_duration  IS 'Duration of the bond (PostgreSQL INTERVAL, e.g. ''30 days'').';
COMMENT ON COLUMN bonds.bond_end       IS 'Computed expiry: bond_start + bond_duration.';
COMMENT ON COLUMN bonds.slashed_amount IS 'Cumulative amount slashed from this bond.';
COMMENT ON COLUMN bonds.active         IS 'Whether the bond is still active (not expired or withdrawn).';
COMMENT ON COLUMN bonds.created_at     IS 'Row creation timestamp.';
COMMENT ON COLUMN bonds.updated_at     IS 'Row last-update timestamp.';

INSERT INTO schema_migrations (version)
VALUES ('002_create_bonds')
ON CONFLICT DO NOTHING;

COMMIT;

-- DOWN
-- BEGIN;
-- DROP TRIGGER IF EXISTS bonds_updated_at ON bonds;
-- DROP INDEX  IF EXISTS idx_bonds_active;
-- DROP INDEX  IF EXISTS idx_bonds_identity_id;
-- DROP TABLE  IF EXISTS bonds;
-- DELETE FROM schema_migrations WHERE version = '002_create_bonds';
-- COMMIT;