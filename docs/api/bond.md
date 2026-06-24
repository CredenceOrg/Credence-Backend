# Bond API — Lifecycle Guide

Full spec: [`docs/openapi.yaml`](../openapi.yaml) → paths `/api/bond` and `/api/bond/{address}`.

## Status values

| Status | Meaning |
|---|---|
| `unbonded` | No bond ever posted (zero amount, no start) |
| `active` | Bond is live and unpenalised |
| `slashed` | Bond is live but has incurred a penalty |
| `inactive` | Bond was previously active and has since been withdrawn |

---

## Lifecycle: create → top-up → withdraw → slash

### 1. Create a bond

```http
POST /api/bond
Content-Type: application/json

{
  "address": "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
  "bondedAmount": "1000000000000000000",
  "bondDuration": 2592000
}
```

**201 response:**

```json
{
  "address": "0x742d35cc6634c0532925a3b844bc454e4438f44e",
  "bondedAmount": "1000000000000000000",
  "bondStart": "2024-01-15T10:00:00.000Z",
  "bondDuration": 2592000,
  "active": true,
  "slashedAmount": "0",
  "status": "active"
}
```

### 2. Top up an existing bond

Same endpoint. `bondedAmount` is the new total, not a delta.

```http
POST /api/bond
Content-Type: application/json

{
  "address": "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
  "bondedAmount": "2000000000000000000",
  "bondDuration": 2592000
}
```

### 3. Check bond status

```http
GET /api/bond/0x742d35Cc6634C0532925a3b844Bc454e4438f44e
```

**200 response** — same shape as above.

**Errors:**

| Status | Body |
|---|---|
| 400 | `{ "error": "Invalid address format…" }` |
| 404 | `{ "error": "No bond record found for address…" }` |

### 4. Withdraw (go inactive)

Withdrawal is processed via the Horizon listener (`src/listeners/horizonWithdrawalEvents.ts`). After the on-chain withdrawal is detected, `active` flips to `false` and `status` becomes `inactive`. Poll `GET /api/bond/:address` to observe the transition.

### 5. Slash

A governance slash event (see `docs/governance-slashing-votes.md`) increments `slashedAmount`. While the bond remains active after a partial slash, `status` becomes `slashed`. A full slash followed by withdrawal yields `status: inactive`.

---

## Error responses

All errors follow:

```json
{ "error": "<human-readable message>" }
```

Schema: `BondError` in `docs/openapi.yaml#/components/schemas/BondError`.

## Address formats

Both Ethereum (`0x` + 40 hex chars) and Stellar (`G` + 55 base32 chars) addresses are accepted. Addresses are normalised to lower-case in all responses.
