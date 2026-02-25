# Governance: Slashing Votes

Slashing votes implement multi-sig governance approval for slash requests.
A slash request must accumulate **N of M** approve votes before it is executed.

## Multi-Sig Threshold

| Parameter      | Default | Meaning                                    |
|----------------|---------|--------------------------------------------|
| `threshold`    | 3       | Approve votes required to pass             |
| `totalSigners` | 5       | Total eligible voters (M in "N of M")      |

A request is **approved** when `approveCount >= threshold`.
A request is **rejected** when the remaining voters can no longer reach the threshold,
or when a reject majority makes approval impossible.

Once resolved (approved or rejected) no further votes are accepted.

---

## Endpoints

### Create a slash request

```
POST /api/governance/slash-requests
```

**Body**

```json
{
  "targetAddress": "0xAbC123",
  "reason": "Double-signing detected",
  "requestedBy": "validator-node-7",
  "threshold": 3,
  "totalSigners": 5
}
```

`threshold` and `totalSigners` are optional (defaults: 3 / 5).

**Response `201`**

```json
{
  "id": "a1b2c3d4e5f6a7b8",
  "targetAddress": "0xAbC123",
  "reason": "Double-signing detected",
  "requestedBy": "validator-node-7",
  "createdAt": "2026-02-24T10:00:00.000Z",
  "votes": [],
  "status": "pending",
  "threshold": 3,
  "totalSigners": 5
}
```

---

### Submit a vote

```
POST /api/governance/slash-requests/:id/votes
```

**Body**

```json
{ "voterId": "signer-1", "choice": "approve" }
```

`choice` must be `"approve"` or `"reject"`.

**Response `201`**

```json
{
  "slashRequestId": "a1b2c3d4e5f6a7b8",
  "voterId": "signer-1",
  "choice": "approve",
  "approveCount": 1,
  "rejectCount": 0,
  "status": "pending"
}
```

**Error responses**

| Status | Reason                                       |
|--------|----------------------------------------------|
| 404    | Slash request not found                      |
| 409    | Request already resolved, or duplicate vote  |

---

### Get a slash request

```
GET /api/governance/slash-requests/:id
```

**Response `200`** — full slash request object including all votes.

---

### List slash requests

```
GET /api/governance/slash-requests
GET /api/governance/slash-requests?status=pending
GET /api/governance/slash-requests?status=approved
GET /api/governance/slash-requests?status=rejected
```

---

## Duplicate Vote Protection

Each `voterId` may vote **at most once** per slash request.
A second vote from the same voter returns `409 Conflict`.

## Example Flow (3-of-5)

```
POST /api/governance/slash-requests          → id=abc, status=pending
POST /api/governance/slash-requests/abc/votes  voterId=s1, choice=approve  → approveCount=1, pending
POST /api/governance/slash-requests/abc/votes  voterId=s2, choice=approve  → approveCount=2, pending
POST /api/governance/slash-requests/abc/votes  voterId=s3, choice=approve  → approveCount=3, approved ✓
POST /api/governance/slash-requests/abc/votes  voterId=s4, choice=approve  → 409 already approved
```
