# Governance Dispute Submissions

The governance API now supports dispute submissions against slash requests.

## Endpoint

`POST /api/governance/disputes`

Authentication: JWT Bearer token required.

### Request body

```json
{
  "slash_request_id": "slash-123",
  "identity": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2",
  "evidence": ["tx:abc123", "ipfs://QmEvidenceCid"],
  "stake": "100.25"
}
```

Fields:

- `slash_request_id` (string, required)
- `identity` (Stellar address, required)
- `evidence` (non-empty string array, required)
- `stake` (numeric string, optional)

### Response

`201 Created`

```json
{
  "dispute": {
    "id": "dispute-123",
    "slash_request_id": "slash-123",
    "identity": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2",
    "evidence": ["tx:abc123"],
    "stake": "100.25",
    "status": "submitted",
    "submitted_at": "2026-02-25T00:00:00.000Z"
  },
  "arbitration": {
    "event": "governance.dispute_submitted",
    "queued": true
  }
}
```

### Error mapping

- `400` invalid payload
- `401` missing/invalid JWT
- `404` slash request not found
- `409` slash request not disputable / duplicate dispute / identity mismatch
- `422` dispute deadline passed

## Database schema requirements

### `slash_requests`

```sql
CREATE TABLE IF NOT EXISTS slash_requests (
  id TEXT PRIMARY KEY,
  identity TEXT NOT NULL,
  status TEXT NOT NULL,
  disputable_until TIMESTAMPTZ NOT NULL
);
```

### `disputes`

```sql
CREATE TABLE IF NOT EXISTS disputes (
  id TEXT PRIMARY KEY,
  slash_request_id TEXT NOT NULL REFERENCES slash_requests(id),
  identity TEXT NOT NULL,
  evidence JSONB NOT NULL,
  stake TEXT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'submitted',
  UNIQUE (slash_request_id, identity)
);
```

## Internal arbitration event

After DB commit, the service emits:

- `type`: `governance.dispute_submitted`
- `dispute_id`
- `slash_request_id`
- `identity`
- `submitted_at`
- `stake`
- `evidence_count`
