-- Migration: Create slash_requests table
-- Version: 001
-- Description: Initial schema for slash request governance system

BEGIN;

-- Create enum types
DO $$ BEGIN
  CREATE TYPE slash_status AS ENUM ('pending', 'approved', 'rejected', 'executed');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('verifier', 'admin', 'user');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Create slash_requests table
CREATE TABLE IF NOT EXISTS slash_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_address VARCHAR(56) NOT NULL,
  amount DECIMAL(20, 7) NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL CHECK (LENGTH(reason) >= 10),
  evidence_ref TEXT NOT NULL,
  status slash_status NOT NULL DEFAULT 'pending',
  submitted_by VARCHAR(56) NOT NULL,
  submitted_at TIMESTAMP NOT NULL DEFAULT NOW(),
  reviewed_by VARCHAR(56),
  reviewed_at TIMESTAMP,
  review_notes TEXT,
  executed_at TIMESTAMP,
  execution_tx_hash VARCHAR(64),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT valid_stellar_target CHECK (target_address ~ '^G[A-Z2-7]{55}$'),
  CONSTRAINT valid_stellar_submitter CHECK (submitted_by ~ '^G[A-Z2-7]{55}$'),
  CONSTRAINT valid_stellar_reviewer CHECK (reviewed_by IS NULL OR reviewed_by ~ '^G[A-Z2-7]{55}$'),
  CONSTRAINT valid_status_transition CHECK (
    (status = 'pending' AND reviewed_by IS NULL) OR
    (status IN ('approved', 'rejected') AND reviewed_by IS NOT NULL) OR
    (status = 'executed' AND reviewed_by IS NOT NULL AND execution_tx_hash IS NOT NULL)
  )
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_slash_requests_status ON slash_requests(status);
CREATE INDEX IF NOT EXISTS idx_slash_requests_target ON slash_requests(target_address);
CREATE INDEX IF NOT EXISTS idx_slash_requests_submitter ON slash_requests(submitted_by);
CREATE INDEX IF NOT EXISTS idx_slash_requests_created_at ON slash_requests(created_at DESC);

-- Create update trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger
DROP TRIGGER IF EXISTS update_slash_requests_updated_at ON slash_requests;
CREATE TRIGGER update_slash_requests_updated_at
  BEFORE UPDATE ON slash_requests
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

COMMIT;
