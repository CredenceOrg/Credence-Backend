-- Slash Requests Schema
-- Supports governance flow for slashing malicious actors

-- Enum types for status and role
CREATE TYPE slash_status AS ENUM ('pending', 'approved', 'rejected', 'executed');
CREATE TYPE user_role AS ENUM ('verifier', 'admin', 'user');

-- Slash requests table
CREATE TABLE IF NOT EXISTS slash_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Identity being slashed
  target_address VARCHAR(56) NOT NULL,
  
  -- Request details
  amount DECIMAL(20, 7) NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL CHECK (LENGTH(reason) >= 10),
  evidence_ref TEXT NOT NULL,
  
  -- Status tracking
  status slash_status NOT NULL DEFAULT 'pending',
  
  -- Submitter info (verifier only)
  submitted_by VARCHAR(56) NOT NULL,
  submitted_at TIMESTAMP NOT NULL DEFAULT NOW(),
  
  -- Review info
  reviewed_by VARCHAR(56),
  reviewed_at TIMESTAMP,
  review_notes TEXT,
  
  -- Execution info
  executed_at TIMESTAMP,
  execution_tx_hash VARCHAR(64),
  
  -- Timestamps
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  
  -- Constraints
  CONSTRAINT valid_stellar_target CHECK (target_address ~ '^G[A-Z2-7]{55}$'),
  CONSTRAINT valid_stellar_submitter CHECK (submitted_by ~ '^G[A-Z2-7]{55}$'),
  CONSTRAINT valid_stellar_reviewer CHECK (reviewed_by IS NULL OR reviewed_by ~ '^G[A-Z2-7]{55}$'),
  CONSTRAINT valid_status_transition CHECK (
    (status = 'pending' AND reviewed_by IS NULL) OR
    (status IN ('approved', 'rejected') AND reviewed_by IS NOT NULL) OR
    (status = 'executed' AND reviewed_by IS NOT NULL AND execution_tx_hash IS NOT NULL)
  )
);

-- Indexes for common queries
CREATE INDEX idx_slash_requests_status ON slash_requests(status);
CREATE INDEX idx_slash_requests_target ON slash_requests(target_address);
CREATE INDEX idx_slash_requests_submitter ON slash_requests(submitted_by);
CREATE INDEX idx_slash_requests_created_at ON slash_requests(created_at DESC);

-- Trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_slash_requests_updated_at
  BEFORE UPDATE ON slash_requests
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Comments for documentation
COMMENT ON TABLE slash_requests IS 'Tracks slash requests for malicious actors in the governance system';
COMMENT ON COLUMN slash_requests.target_address IS 'Stellar address of the identity being slashed';
COMMENT ON COLUMN slash_requests.amount IS 'Amount to slash from the bond (in XLM)';
COMMENT ON COLUMN slash_requests.reason IS 'Detailed reason for the slash request (min 10 chars)';
COMMENT ON COLUMN slash_requests.evidence_ref IS 'Reference to evidence (URL, IPFS hash, etc.)';
COMMENT ON COLUMN slash_requests.status IS 'Current status: pending, approved, rejected, executed';
COMMENT ON COLUMN slash_requests.submitted_by IS 'Stellar address of the verifier who submitted the request';
