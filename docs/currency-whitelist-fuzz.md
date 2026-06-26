# Currency Whitelist — Fuzz Harness

## Overview

`src/test_fuzz_currency_whitelist.ts` is a property-based fuzz harness for the
currency whitelist service (`src/services/currency/whitelist.ts`).  It runs
**≥ 30,000 random action sequences** and asserts that the real implementation
always matches a pure reference model.

---

## Motivation

The four mutating operations on the whitelist —

| Method | Description |
|---|---|
| `add_currency(currency, ctx)` | Adds one currency; idempotent |
| `remove_currency(currency, ctx)` | Removes one currency; idempotent |
| `set_currencies(currencies, ctx)` | Atomically replaces the entire whitelist |
| `clear_currencies(ctx)` | Empties the whitelist |

— all require admin authentication and can be called in any order.  Under
"churn" (random interleaving of all four), subtle bugs can arise:

- Silent deduplication that drops an `add` after a `set_currencies`
- Off-by-one in `set_currencies` when the new list contains duplicates
- Case-normalisation inconsistencies (`usd` vs `USD`)
- Auth checks accidentally bypassed when the whitelist is already empty

A model-based property test catches all of these by comparing every
post-mutation state against a ground-truth `Set<string>`.

---

## Architecture

### Reference model

```
applyToModel(model: Set<string>, action: WhitelistAction) → void
```

A pure function that applies the same semantics as `CurrencyWhitelist` using
only a plain JavaScript `Set`.  Because it has no auth layer, no class state,
and no side effects, it is trivially correct and serves as the oracle.

### Action enum

```typescript
type WhitelistAction =
  | { kind: 'add_currency';    currency: string }
  | { kind: 'remove_currency'; currency: string }
  | { kind: 'set_currencies';  currencies: string[] }
  | { kind: 'clear_currencies' }
```

Each variant carries exactly the data needed to drive both the real
implementation and the reference model.

### PRNG

A deterministic **xorshift32** PRNG is seeded from `Date.now()` at the start
of each test.  The seed is printed to stdout so any failure can be reproduced
by hard-coding the seed value.

```
[fuzz] seed=1717123456789  sequences=30000  maxActionsPerSeq=20
```

No external library is required — the PRNG is implemented inline in ~15 lines.

### Currency pool

The generator draws from a pool of 27 strings that includes:

- All 21 standard ISO 4217 codes used by the billing engine
- Lower-case variants (`usd`, `eur`, `gbp`, `jpy`) to exercise normalisation
- Padded variants (` USD `, ` EUR `) to exercise trimming
- Exotic codes (`XTS`, `XXX`, `ZZZ`) not in the standard pool

---

## Properties verified

### 1. Model equivalence (churn)

> For every random sequence of actions, the post-state of the real
> implementation equals the deterministic outcome of replaying the same
> sequence against the reference model.

Runs **30,000 sequences** of up to 20 actions each.

### 2. `is_allowed_currency` correctness

> After every single action, `is_allowed_currency(c)` returns `true` if and
> only if `c` (normalised) is in the reference model.

Verified for every currency in the pool after every action across **5,000
sequences**.

### 3. Admin auth enforcement

> Non-admin callers (`user`, `verifier`, `public`) always receive
> `ForbiddenError`.  Admin and super-admin callers never receive an auth error.
> A missing context (`undefined`) always throws `UnauthorizedError`.

Verified across **1,000 random actions** per role class.

### 4. Idempotency of remove-then-add cycles

> `remove(x); add(x)` leaves `x` present.  
> `add(x); remove(x)` leaves `x` absent.  
> Double-add does not grow the set.  
> Double-remove does not shrink the set.

Each cycle verified across **10,000 random (currency, initial-state) pairs**.

### 5. `set_currencies` idempotency

> Calling `set_currencies(list)` twice with the same list produces the same
> state as calling it once.

Verified across **5,000 random lists**.

### 6. `clear_currencies` idempotency

> Calling `clear_currencies` any number of times leaves the whitelist empty.

Verified across **5,000 random initial states** with 1–5 repeated clears.

### 7. Case-normalisation invariant

> Currency codes are normalised to upper-case regardless of input casing.
> `add_currency("usd")` makes `is_allowed_currency("USD")` return `true`.

Verified with explicit deterministic assertions.

### 8. Snapshot isolation

> `snapshot()` returns an independent copy.  Subsequent mutations do not
> affect a previously obtained snapshot.

### 9. Constructor seed

> The constructor accepts an initial iterable without requiring auth.

### 10. Super-admin equivalence

> `super-admin` context produces identical model equivalence to `admin`
> context across **2,000 sequences**.

---

## Running the harness

```bash
# Run all tests (includes the fuzz harness)
npm test

# Run only the fuzz harness
npx vitest run src/test_fuzz_currency_whitelist.ts

# Run with verbose output to see the seed
npx vitest run src/test_fuzz_currency_whitelist.ts --reporter=verbose
```

Expected output (abridged):

```
[fuzz] seed=1717123456789  sequences=30000  maxActionsPerSeq=20
[fuzz] total actions executed: 302,847

 ✓ runs 30,000 random sequences and post-state equals reference model
 ✓ is_allowed_currency answers correctly after every action in 5,000 sequences
 ✓ non-admin callers always receive ForbiddenError
 ✓ admin and super-admin callers never receive an auth error
 ✓ missing context (undefined cast) throws UnauthorizedError
 ✓ remove(x) then add(x) leaves x present (idempotency cycle)
 ✓ add(x) then remove(x) leaves x absent (idempotency cycle)
 ✓ double-add is idempotent (size does not grow on second add)
 ✓ double-remove is idempotent (size does not shrink on second remove)
 ✓ set_currencies called twice with the same list produces the same state
 ✓ clear_currencies is idempotent regardless of how many times it is called
 ✓ currency codes are normalised to upper-case regardless of input casing
 ✓ snapshot() returns an independent copy — mutations do not affect it
 ✓ constructor accepts an initial iterable without requiring auth
 ✓ super-admin context produces identical model equivalence over 2,000 sequences
```

---

## Reproducing a failure

If a test fails, the seed is printed at the top of the test output.  To
reproduce, hard-code the seed in the harness:

```typescript
// Replace Date.now() with the printed seed value
const seed = 1717123456789
```

Then re-run the harness.  The PRNG is deterministic, so the exact failing
sequence will be replayed.

---

## Security notes

- **No silent auth bypass**: `assertAdmin` is called at the top of every
  mutating method before any state is read or written.  A non-admin caller
  cannot observe whether a currency is present by triggering a conditional
  code path.
- **No silent deduplication**: `add_currency` uses `Set.add`, which is
  idempotent by definition.  The model equivalence property would catch any
  implementation that silently dropped an add.
- **Snapshot isolation**: `snapshot()` returns a new `Set` copy, so callers
  cannot mutate internal state by modifying the returned value.

---

## File index

| File | Purpose |
|---|---|
| `src/services/currency/whitelist.ts` | Production whitelist implementation |
| `src/test_fuzz_currency_whitelist.ts` | Property-based fuzz harness (this file's subject) |
| `docs/currency-whitelist-fuzz.md` | This document |
