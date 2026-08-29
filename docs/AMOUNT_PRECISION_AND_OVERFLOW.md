# Amount Precision and Overflow — Wallet Balances

Closes QE-2026-08.

## Scope

This document covers `WalletsRepository.credit()` and `WalletsRepository.debit()`
(`src/db/repositories/walletsRepository.ts`), the only write paths that mutate
`wallets.balance` (`NUMERIC(36, 18)`), plus the shared bounds-checking primitive
in `src/lib/decimalMath.ts`. No other repository, route, or schema was changed.

## What was found

1. **No application-layer scale/overflow validation.** `credit()` and
   `debit()` validated that an amount was a well-formed, positive decimal
   (`isValidPositiveDecimal`) and, for debits, compared it exactly against
   the current balance (`compareDecimals`). Neither checked the amount (or,
   for credits, the resulting balance) against the actual bounds of the
   `NUMERIC(36, 18)` column before writing.
   - Postgres does not reject a value with more fractional digits than a
     column's scale — it **silently rounds** on write. An amount with 19
     fractional digits would be recorded verbatim in the immutable
     `wallet_transactions` ledger while the balance itself was rounded to 18
     digits, silently desynchronizing the two.
   - An amount (or a sum) exceeding 18 integer digits would surface as a raw,
     untyped `22003 numeric_field_overflow` driver error partway through the
     transaction, instead of being rejected before any lock was taken.
2. **A pre-existing, severe defect in the actual write path.** Both
   `UPDATE` statements cast the arithmetic result to `::TEXT` before
   assigning it to the `NUMERIC` `balance` column:
   `SET balance = (balance::NUMERIC + $2::NUMERIC)::TEXT`. Postgres has no
   implicit/assignment cast from `text` to `numeric`, so **every real
   `credit()`/`debit()` call failed against actual Postgres** with
   `column "balance" is of type numeric but expression is of type text`.
   This was invisible to the existing unit tests because they run against a
   hand-rolled mock `Pool` that never sends SQL through Postgres's type
   checker; it only surfaced once the integration suite was run against a
   real Postgres 16 instance. This is fixed by removing the redundant casts
   (`SET balance = balance + $2::NUMERIC`), which is what should have shipped
   originally — no behavioral change to the intended semantics.

## Design and invariants

- **Single source of truth for column shape.** `BALANCE_PRECISION = 36` and
  `BALANCE_SCALE = 18` are declared once in `walletsRepository.ts`, matching
  the `NUMERIC(36, 18)` column in `src/db/schema.ts`, so the application
  check can never silently drift from the schema.
- **`assertWithinNumericBounds(value, precision, scale)`**
  (`src/lib/decimalMath.ts`) is a pure, side-effect-free function that
  validates a decimal string against the same rules Postgres uses for
  `NUMERIC(precision, scale)`:
  - **Scale**: rejects a value with more fractional digits than `scale`
    (`DecimalScaleError`).
  - **Magnitude**: rejects a value whose integer part has more significant
    digits than `precision - scale` (`DecimalOverflowError`). A lone `"0"`
    integer part counts as zero significant digits, matching Postgres's
    `NUMERIC(p, s)` semantics for values like `0.9` under `NUMERIC(1, 1)`.
  - All arithmetic is string/BigInt based — no floating point, no rounding.
- **Two independent rejection points**, both before any state change:
  1. **Pre-lock**: the raw input `amount` is checked against the column
     bounds before the row lock is acquired. An amount that cannot fit the
     column on its own can never succeed, so there is no reason to touch the
     database at all.
  2. **Post-lock, pre-write** (`credit()` only): once the current balance is
     known, the *projected* sum (`addDecimals(previousBalance, amount)`) is
     checked before the `UPDATE` runs. This is the only point at which a
     sum-overflow (neither operand overflows alone, but their sum does) can
     be detected, and it still happens inside the same transaction, before
     any write, so a rejection here still leaves no partial state.
- **Typed errors, not driver exceptions.** `AmountScaleError`
  (`ErrorCode.INVALID_FORMAT`, 400) and `AmountOverflowError`
  (`ErrorCode.VALUE_TOO_LARGE`, 400) are `AppError` subclasses following the
  repository's existing error conventions (see `InsufficientBalanceError`,
  `WalletAlreadyExistsError`), so callers get a documented, catalog-backed
  error instead of a raw Postgres exception leaking out of the repository.

## Failure behavior and no-partial-state guarantee

- Pre-lock rejections (`AmountScaleError`, `AmountOverflowError`,
  malformed/zero/negative amount) throw synchronously before
  `TransactionManager.withTransaction` is even entered — no connection is
  acquired, no lock is taken, no row is touched.
- The post-lock overflow check in `credit()` throws from inside the
  transaction callback, before the `UPDATE` is issued. `TransactionManager`
  rolls back the transaction on any thrown error (unchanged, pre-existing
  behavior), so the row lock is released and the balance is left exactly as
  it was.
- In both cases, no row is written to `wallet_transactions`, since the
  ledger insert happens only after a successful `UPDATE`.
- Verified directly against a real Postgres instance (not just the mocked
  unit tests) — see `tests/integration/walletsRepository.integration.test.ts`,
  which asserts both that the typed error is thrown and that the wallet's
  balance and ledger are unchanged afterward.
- Rejected operations are also stateless/pure with respect to the amount
  string itself: `assertWithinNumericBounds` and `assertValidWalletAmount`
  perform no mutation and can be called repeatedly with the same result
  (deterministic), so retried or duplicated rejected requests behave
  identically and leave no side effects — consistent with the repository's
  existing idempotent-rejection behavior for insufficient-balance and
  not-found cases.

## Compatibility impact

- **No public API shape change.** `credit(id, amount)` and
  `debit(id, amount)` keep the same signatures and success-path return
  types (`Wallet`, `DebitResult`).
- **New, additive error cases.** Previously, an amount with excess scale
  would have been silently rounded by Postgres (once the `::TEXT` cast bug
  above is also fixed) rather than rejected, and an amount/sum overflowing
  the column would have surfaced as an unhandled, untyped driver error
  (`error.code === '22003'`) instead of a typed `AppError`. Callers that
  were not already handling a generic thrown error from `credit()`/`debit()`
  should now handle `AmountScaleError` / `AmountOverflowError` explicitly if
  they want to distinguish these cases from `InsufficientBalanceError`; both
  are `AppError` instances with HTTP 400 semantics, so any generic
  `AppError`-based error-handling middleware requires no changes.
- **Bug fix, not a behavior change, for the `::TEXT` cast removal.** The
  intended behavior (persist the arithmetic result as the column's native
  `NUMERIC` type) is unchanged; what changes is that `credit()`/`debit()`
  now actually work against real Postgres instead of failing on every call.

## Migration / rollback considerations

- No schema migration is required; `wallets.balance` is unchanged
  (`NUMERIC(36, 18)`, as already defined in `src/db/schema.ts`).
- No data migration is required; existing rows already satisfy the column's
  own precision and scale by construction (Postgres would not have accepted
  them otherwise).
- Rollback is a straightforward revert of `src/lib/decimalMath.ts` and
  `src/db/repositories/walletsRepository.ts` to the prior revision. Because
  the `::TEXT`-cast bug meant `credit()`/`debit()` could not succeed against
  real Postgres at all, rolling back restores that broken state — the
  pre-existing code was not a safe fallback in production.

## Operational limitations

- The bounds check is specific to `wallets.balance`
  (`NUMERIC(36, 18)`). Other tables with `NUMERIC` amount columns
  (e.g. `bonds.amount NUMERIC(20, 7)`, `slash_events.slash_amount`) are out
  of scope for this change and do not yet have the equivalent guard; the
  same `assertWithinNumericBounds` primitive can be reused for them in a
  follow-up.
- The integration test suite (`tests/integration/walletsRepository.integration.test.ts`)
  requires either Docker (via `testcontainers`) or a reachable
  `TEST_DATABASE_URL`; it skips itself automatically when neither is
  available. It cannot run against `pg-mem`, since the schema uses
  Postgres-specific functions (`trim`, `gen_random_uuid`) inside `CHECK`
  constraints that `pg-mem` does not support.

## Security assumptions

- Amount strings are treated as untrusted input at the repository boundary;
  validation (format, sign, scale, magnitude) happens before any query is
  issued, and all values are passed as parameterized query arguments (no
  string interpolation into SQL), unchanged from the existing pattern.
- No new secrets, credentials, or external calls are introduced.

## Validation performed

- `npx eslint src/lib/decimalMath.ts src/db/repositories/walletsRepository.ts` — clean.
- `npx vitest run src/lib/decimalMath.test.ts tests/repositories/walletsRepository.test.ts`
  — 229/229 passing (200 in `decimalMath.test.ts`, 29 in `walletsRepository.test.ts`,
  including property-based tests checked against an independent oracle and a
  boundary table across five `NUMERIC(precision, scale)` shapes: zero, min,
  max, near-overflow, and the exact scale/conversion boundary).
- `npx vitest run tests/integration/walletsRepository.integration.test.ts`
  against a real, locally provisioned PostgreSQL 16 instance (not `pg-mem`,
  not mocked) — 25/25 passing, including the new precision/overflow tests
  and confirmation that rejected operations leave the wallet balance and
  ledger untouched. This run is what surfaced the `::TEXT`-cast defect
  above, since the mocked unit-test suite cannot detect a real Postgres
  type-checking failure.
- `npx tsc --noEmit` on the changed files introduces no new type errors.
  (The full-repository `tsc` run has pre-existing, unrelated failures in
  other modules — e.g. `src/services/members/service.ts`,
  `src/services/settlementService.ts`, `src/routes/*.ts` — untouched by this
  change and out of scope for this issue.)
- A separate pre-existing bug (`src/tracing/tracer.ts` declares
  `export const DbSpans` twice) currently breaks `tsc` and blocks Vitest's
  transform step for any test importing `src/db/transaction.ts`, which
  includes both wallet test files. It was **not fixed here**, per this
  issue's scope; it should be filed and fixed separately. Test results
  above were produced by temporarily patching that one duplicate locally to
  execute the suite, then reverting the patch before finalizing this change
  — the shipped diff for this issue does not touch `tracer.ts`.
