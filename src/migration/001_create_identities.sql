-- migrations/001_create_identities.sql
-- Idempotent migration: creates the identities table if it does not exist.
-- UP

BEGIN;

CREATE TABLE IF NOT EXISTS identities (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  address       VARCHAR(255)  NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Automatically keep updated_at current on every row update
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS identities_updated_at ON identities;
CREATE TRIGGER identities_updated_at
  BEFORE UPDATE ON identities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE  identities            IS 'On-chain identities registered in the Credence protocol.';
COMMENT ON COLUMN identities.id         IS 'Surrogate UUID primary key.';
COMMENT ON COLUMN identities.address    IS 'Blockchain wallet address uniquely identifying the participant.';
COMMENT ON COLUMN identities.created_at IS 'Timestamp when the identity was first registered.';
COMMENT ON COLUMN identities.updated_at IS 'Timestamp of the most recent update to this row.';

-- Migration tracking
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     VARCHAR(64)  PRIMARY KEY,
  applied_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

INSERT INTO schema_migrations (version)
VALUES ('001_create_identities')
ON CONFLICT DO NOTHING;

COMMIT;

-- DOWN
-- BEGIN;
-- DROP TRIGGER IF EXISTS identities_updated_at ON identities;
-- DROP TABLE IF EXISTS identities;
-- DELETE FROM schema_migrations WHERE version = '001_create_identities';
-- COMMIT;