# Usage-Based Billing

Credence uses a credit-based usage metering system to bill for API endpoints. Each authenticated request consumes credits from the caller's monthly pool.

## How It Works

1. Every authenticated API request passes through the **cost meter middleware** (`src/middleware/costMeter.ts`).
2. The middleware resolves an **endpoint cost weight** from the request path.
3. Credits are **deducted atomically** from the caller's `org_credits` balance using optimistic locking.
4. The remaining balance is returned in the `X-Credits-Remaining` response header.
5. If the balance is insufficient, the request is rejected with **402 InsufficientCredits**.

## Endpoint Cost Weights

Cost weights are configured in `src/config/index.ts` under `endpointCostWeights`. The default configuration:

```json
{
  "default": 1,
  "/bulk/verify": 10,
  "/reports": 5
}
```

- **default** – weight applied when no specific pattern matches (currently `1`).
- **`/bulk/verify`** – expensive bulk verification endpoint (weight `10`).
- **`/reports`** – report generation and status polling (weight `5`).

All other authenticated endpoints consume **1 credit** per request.

### Override via Environment

Set `ENDPOINT_COST_WEIGHTS` as a JSON string in your environment:

```bash
ENDPOINT_COST_WEIGHTS='{"default":1,"/bulk/verify":20,"/reports":10}'
```

## Credit Pool

- Each organization receives a **monthly credit allowance** configured by `DEFAULT_MONTHLY_CREDITS` (default: `10000`).
- Credits are stored in the `org_credits` table with **optimistic locking** (version column) to prevent race conditions under concurrent requests.
- When an org has no row in `org_credits`, it is initialized with the full monthly allowance on the first metered request.

## Response Headers

| Header | Description |
|---|---|
| `X-Credits-Remaining` | Credits remaining in the monthly pool after this request |

## 402 InsufficientCredits

When the credit pool is exhausted, the API responds with:

```json
{
  "error": "InsufficientCredits",
  "message": "Monthly credit budget exhausted. Required: 10, Remaining: 3",
  "creditsRequired": 10,
  "creditsRemaining": 3,
  "creditsDeficit": 7
}
```

- **creditsRequired** – The cost weight of the attempted endpoint.
- **creditsRemaining** – Actual balance at time of rejection.
- **creditsDeficit** – How many additional credits are needed (`creditsRequired - creditsRemaining`).

## Refunds

If a handler returns a **5xx** status code (server error), the deducted credits are automatically refunded and an audit row with `transaction_type = 'refund'` is inserted into `credit_transactions`.

Client errors (**4xx**) do **not** trigger refunds — the request was processed and consumed credits.

## Audit Trail

All credit movements are recorded in the `credit_transactions` table:

| Column | Description |
|---|---|
| `id` | Auto-incrementing primary key |
| `org_id` | Organization UUID |
| `transaction_type` | `deduct`, `refund`, or `top_up` |
| `amount` | Number of credits moved |
| `credits_remaining_before` | Balance before the transaction |
| `credits_remaining_after` | Balance after the transaction |
| `endpoint` | API path that triggered the transaction |
| `cost_weight` | Weight of the endpoint at time of transaction |
| `request_id` | Correlation ID for request tracing |
| `created_at` | Transaction timestamp |

## Database Schema

### `org_credits`

```sql
CREATE TABLE org_credits (
  org_id            UUID        PRIMARY KEY,
  credits_remaining BIGINT      NOT NULL DEFAULT 0,
  version           INTEGER     NOT NULL DEFAULT 1,
  last_top_up_at    TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### `credit_transactions`

```sql
CREATE TABLE credit_transactions (
  id                      BIGSERIAL    PRIMARY KEY,
  org_id                  UUID         NOT NULL,
  transaction_type        VARCHAR(20)  NOT NULL,
  amount                  BIGINT       NOT NULL,
  credits_remaining_before BIGINT      NOT NULL,
  credits_remaining_after BIGINT       NOT NULL,
  endpoint                TEXT,
  cost_weight             INTEGER,
  request_id              TEXT,
  failure_reason          TEXT,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
```

## Testing

Run the cost meter tests:

```bash
npx vitest run src/middleware/__tests__/costMeter.test.ts
```

Tests cover:
- Basic deduction and header output
- 402 rejection at zero balance
- Free-tier endpoints (weight 0)
- Unauthenticated request bypass
- New org initialization
- Multiple sequential deductions
- Refund on 5xx handler errors
- No refund on 4xx client errors
- Refund on `next(err)` error path
- Concurrent deduct race conditions (optimistic locking)
- Audit trail creation for deduct and refund transactions

## Decimal Arithmetic

Fee, split, and balance math must never round-trip through IEEE-754
`Number`. `src/lib/decimalMath.ts` is a BigInt-backed toolkit that accepts
and returns decimal strings (e.g. `"10.50"`) so precision is never silently
lost. It backs the fee engine (`src/services/billing/feeEngine.ts`) and is
the required path for any new money-related arithmetic.

| Function | Behavior |
|---|---|
| `roundToScale(value, scale, mode?)` | Round a decimal string to `scale` fractional digits. |
| `multiplyDecimals(a, b)` | Exact product; no rounding. Result scale is the sum of input scales. |
| `addDecimals(a, b)` | Exact sum; no rounding. Scales are aligned to the larger input scale. |
| `subtractDecimals(a, b)` | Exact difference; no rounding. Scales are aligned to the larger input scale. |
| `divideDecimals(a, b, scale, mode?)` | Quotient rounded to a caller-specified scale. Throws `DivisionByZeroError` when `b` is zero. |
| `compareDecimals(a, b)` | Returns `-1 \| 0 \| 1` without ever coercing to `Number`. |

All functions are sign-aware and never return a trailing `-0` (e.g.
`subtractDecimals("3", "3")` is `"0"`, not `"-0"`).

### Rounding modes

`RoundingMode` (`HALF_UP`, `HALF_DOWN`, `HALF_EVEN`, `DOWN`, `UP`) is shared
across `roundToScale` and `divideDecimals`. The default for both is
`RoundingMode.HALF_UP` (`DEFAULT_ROUNDING_MODE`), matching standard
financial rounding.

### Examples

```ts
import {
  addDecimals,
  subtractDecimals,
  divideDecimals,
  compareDecimals,
  RoundingMode,
  DivisionByZeroError,
} from '../src/lib/decimalMath.js'

addDecimals('10.50', '2.25')                    // "12.75"
subtractDecimals('100.01', '0.01')              // "100.00"
divideDecimals('1', '3', 6)                     // "0.333333" (repeating decimal, HALF_UP)
divideDecimals('10', '3', 2, RoundingMode.DOWN) // "3.33"
compareDecimals('1.50', '1.5')                  // 0 (trailing zeros don't matter)

try {
  divideDecimals('1', '0', 2)
} catch (err) {
  err instanceof DivisionByZeroError // true
}
```

### Testing

```bash
npx vitest run src/lib/decimalMath.test.ts
```

Tests cover:
- Table-driven cases for every rounding mode and sign combination
- Mismatched-scale operands for add/subtract/divide
- Repeating decimals (e.g. `1/3` at scale 6) and divide-by-zero
- fast-check property tests: `(a + b) - b === a`, commutativity of
  addition, divide-then-multiply round-trip bounds, and
  `compareDecimals`/`subtractDecimals` sign consistency
