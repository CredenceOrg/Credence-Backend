/**
 * @file src/test_fuzz_currency_whitelist.ts
 *
 * Property-based fuzz harness for the currency whitelist.
 *
 * ## What is tested
 *
 * The four mutating operations on {@link CurrencyWhitelist}:
 *   - `add_currency`      – adds one currency; idempotent
 *   - `remove_currency`   – removes one currency; idempotent
 *   - `set_currencies`    – atomically replaces the entire whitelist
 *   - `clear_currencies`  – empties the whitelist
 *
 * ## Core property (churn / model equivalence)
 *
 * For every randomly generated sequence of actions the **post-state of the
 * real implementation must equal the deterministic outcome of replaying the
 * same sequence against a pure reference model** (a plain `Set<string>`).
 *
 * ## Additional properties verified per action
 *
 * 1. `is_allowed_currency` answers correctly after every single action.
 * 2. Admin auth is enforced: non-admin callers always receive `ForbiddenError`
 *    and admin callers never receive an auth error.
 * 3. Idempotency of remove-then-add cycles: `remove(x); add(x)` leaves `x`
 *    present; `add(x); remove(x)` leaves `x` absent.
 * 4. `set_currencies` is idempotent when called twice with the same list.
 * 5. `clear_currencies` followed by any number of `clear_currencies` calls
 *    leaves the whitelist empty.
 *
 * ## Sequence count
 *
 * The harness runs ≥ 30,000 random sequences (configurable via
 * `FUZZ_SEQUENCES` and `FUZZ_ACTIONS_PER_SEQ`).
 *
 * ## PRNG
 *
 * A deterministic xorshift32 PRNG seeded from `Date.now()` (printed to
 * stdout so failures are reproducible) drives all random choices.  No
 * external property-testing library is required.
 */

import { describe, it, expect } from 'vitest'
import { CurrencyWhitelist } from './services/currency/whitelist.js'
import type { AdminContext } from './services/currency/whitelist.js'
import { ForbiddenError, UnauthorizedError } from './lib/errors.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Total number of random action sequences to run. */
const FUZZ_SEQUENCES = 30_000

/** Maximum number of actions per sequence. */
const FUZZ_ACTIONS_PER_SEQ = 20

// ---------------------------------------------------------------------------
// Deterministic PRNG (xorshift32)
// ---------------------------------------------------------------------------

/**
 * Minimal xorshift32 PRNG.
 * Returns integers in [0, 2^32).
 */
function makeRng(seed: number) {
  let s = seed >>> 0
  if (s === 0) s = 1 // xorshift must not start at 0
  return {
    next(): number {
      s ^= s << 13
      s ^= s >>> 17
      s ^= s << 5
      return (s >>> 0)
    },
    /** Integer in [0, n). */
    nextInt(n: number): number {
      return this.next() % n
    },
    /** Float in [0, 1). */
    nextFloat(): number {
      return this.next() / 0x1_0000_0000
    },
  }
}

// ---------------------------------------------------------------------------
// Currency pool
// ---------------------------------------------------------------------------

/**
 * Pool of currency codes used by the generator.
 * Deliberately includes duplicates (different cases) to exercise
 * case-normalisation, and a few exotic codes to stress the whitelist.
 */
const CURRENCY_POOL: readonly string[] = [
  'USD', 'EUR', 'GBP', 'JPY', 'KRW', 'CAD', 'AUD', 'CHF',
  'MXN', 'BRL', 'SGD', 'HKD', 'SEK', 'NOK', 'DKK', 'ZAR',
  'INR', 'KWD', 'BHD', 'OMR', 'JOD',
  // lower-case variants — must normalise to the same code
  'usd', 'eur', 'gbp', 'jpy',
  // padded variants
  ' USD ', ' EUR ',
  // exotic / unknown codes (valid strings, not in the standard pool)
  'XTS', 'XXX', 'ZZZ',
]

function pickCurrency(rng: ReturnType<typeof makeRng>): string {
  return CURRENCY_POOL[rng.nextInt(CURRENCY_POOL.length)]
}

function pickCurrencies(rng: ReturnType<typeof makeRng>, maxLen = 6): string[] {
  const len = rng.nextInt(maxLen + 1) // 0..maxLen inclusive
  return Array.from({ length: len }, () => pickCurrency(rng))
}

// ---------------------------------------------------------------------------
// Action enum and generator
// ---------------------------------------------------------------------------

/**
 * Discriminated union of all whitelist mutation actions.
 *
 * Each variant maps 1-to-1 to a method on {@link CurrencyWhitelist}.
 */
type WhitelistAction =
  /**
   * Add a single currency to the whitelist.
   * Idempotent: adding an already-present currency is a no-op.
   */
  | { kind: 'add_currency'; currency: string }
  /**
   * Remove a single currency from the whitelist.
   * Idempotent: removing an absent currency is a no-op.
   */
  | { kind: 'remove_currency'; currency: string }
  /**
   * Atomically replace the entire whitelist with the given set.
   * Passing an empty array is equivalent to `clear_currencies`.
   */
  | { kind: 'set_currencies'; currencies: string[] }
  /**
   * Remove all currencies from the whitelist.
   * Idempotent: calling on an empty whitelist is a no-op.
   */
  | { kind: 'clear_currencies' }

function generateAction(rng: ReturnType<typeof makeRng>): WhitelistAction {
  const roll = rng.nextInt(4)
  switch (roll) {
    case 0: return { kind: 'add_currency',    currency:   pickCurrency(rng) }
    case 1: return { kind: 'remove_currency', currency:   pickCurrency(rng) }
    case 2: return { kind: 'set_currencies',  currencies: pickCurrencies(rng) }
    default: return { kind: 'clear_currencies' }
  }
}

function generateSequence(
  rng: ReturnType<typeof makeRng>,
  maxLen: number,
): WhitelistAction[] {
  const len = 1 + rng.nextInt(maxLen) // at least 1 action
  return Array.from({ length: len }, () => generateAction(rng))
}

// ---------------------------------------------------------------------------
// Reference model
// ---------------------------------------------------------------------------

/**
 * Pure reference model for the whitelist.
 *
 * Mirrors the semantics of {@link CurrencyWhitelist} using only a `Set`.
 * Used to compute the expected post-state for every generated sequence.
 */
function applyToModel(
  model: Set<string>,
  action: WhitelistAction,
): void {
  const norm = (c: string) => c.trim().toUpperCase()
  switch (action.kind) {
    case 'add_currency':
      model.add(norm(action.currency))
      break
    case 'remove_currency':
      model.delete(norm(action.currency))
      break
    case 'set_currencies': {
      model.clear()
      for (const c of action.currencies) model.add(norm(c))
      break
    }
    case 'clear_currencies':
      model.clear()
      break
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ADMIN_CTX: AdminContext = { userId: 'fuzz-admin', role: 'admin' }
const SUPER_ADMIN_CTX: AdminContext = { userId: 'fuzz-super', role: 'super-admin' }
const NON_ADMIN_CTXS: AdminContext[] = [
  { userId: 'fuzz-user',     role: 'user' },
  { userId: 'fuzz-verifier', role: 'verifier' },
  { userId: 'fuzz-public',   role: 'public' },
]

function applyToWhitelist(
  wl: CurrencyWhitelist,
  action: WhitelistAction,
  ctx: AdminContext,
): void {
  switch (action.kind) {
    case 'add_currency':    wl.add_currency(action.currency, ctx);       break
    case 'remove_currency': wl.remove_currency(action.currency, ctx);    break
    case 'set_currencies':  wl.set_currencies(action.currencies, ctx);   break
    case 'clear_currencies': wl.clear_currencies(ctx);                   break
  }
}

/** Convert a `Set<string>` to a sorted array for deterministic comparison. */
function sortedArray(s: ReadonlySet<string>): string[] {
  return [...s].sort()
}

/** Assert that the whitelist snapshot equals the reference model. */
function assertEqualsModel(
  wl: CurrencyWhitelist,
  model: Set<string>,
  seqIdx: number,
  actionIdx: number,
  action: WhitelistAction,
): void {
  const actual   = sortedArray(wl.snapshot())
  const expected = sortedArray(model)
  if (actual.join(',') !== expected.join(',')) {
    throw new Error(
      `Model divergence at sequence ${seqIdx}, action ${actionIdx} (${action.kind}):\n` +
      `  expected: [${expected.join(', ')}]\n` +
      `  actual:   [${actual.join(', ')}]`,
    )
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CurrencyWhitelist — property-based fuzz harness', () => {

  // -------------------------------------------------------------------------
  // 1. Churn / model-equivalence property
  // -------------------------------------------------------------------------

  it(`runs ${FUZZ_SEQUENCES.toLocaleString()} random sequences and post-state equals reference model`, () => {
    const seed = Date.now()
    console.log(`[fuzz] seed=${seed}  sequences=${FUZZ_SEQUENCES}  maxActionsPerSeq=${FUZZ_ACTIONS_PER_SEQ}`)

    const rng = makeRng(seed)
    let totalActions = 0

    for (let seqIdx = 0; seqIdx < FUZZ_SEQUENCES; seqIdx++) {
      const actions = generateSequence(rng, FUZZ_ACTIONS_PER_SEQ)
      const wl    = new CurrencyWhitelist()
      const model = new Set<string>()

      for (let aIdx = 0; aIdx < actions.length; aIdx++) {
        const action = actions[aIdx]
        applyToWhitelist(wl, action, ADMIN_CTX)
        applyToModel(model, action)
        assertEqualsModel(wl, model, seqIdx, aIdx, action)
        totalActions++
      }
    }

    console.log(`[fuzz] total actions executed: ${totalActions.toLocaleString()}`)
    expect(totalActions).toBeGreaterThanOrEqual(FUZZ_SEQUENCES)
  })

  // -------------------------------------------------------------------------
  // 2. is_allowed_currency correctness after every action
  // -------------------------------------------------------------------------

  it('is_allowed_currency answers correctly after every action in 5,000 sequences', () => {
    const seed = Date.now() ^ 0xdeadbeef
    const rng  = makeRng(seed)

    for (let seqIdx = 0; seqIdx < 5_000; seqIdx++) {
      const actions = generateSequence(rng, FUZZ_ACTIONS_PER_SEQ)
      const wl    = new CurrencyWhitelist()
      const model = new Set<string>()

      for (const action of actions) {
        applyToWhitelist(wl, action, ADMIN_CTX)
        applyToModel(model, action)

        // Spot-check every currency in the pool after each action.
        for (const raw of CURRENCY_POOL) {
          const norm = raw.trim().toUpperCase()
          const expected = model.has(norm)
          const actual   = wl.is_allowed_currency(raw)
          if (actual !== expected) {
            throw new Error(
              `is_allowed_currency("${raw}") returned ${actual} but expected ${expected} ` +
              `after action ${action.kind} in sequence ${seqIdx}`,
            )
          }
        }
      }
    }
  })

  // -------------------------------------------------------------------------
  // 3. Admin auth enforcement
  // -------------------------------------------------------------------------

  it('non-admin callers always receive ForbiddenError', () => {
    const seed = Date.now() ^ 0xcafebabe
    const rng  = makeRng(seed)

    for (let i = 0; i < 1_000; i++) {
      const action = generateAction(rng)
      const ctx    = NON_ADMIN_CTXS[rng.nextInt(NON_ADMIN_CTXS.length)]
      const wl     = new CurrencyWhitelist()

      expect(() => applyToWhitelist(wl, action, ctx)).toThrow(ForbiddenError)
    }
  })

  it('admin and super-admin callers never receive an auth error', () => {
    const seed = Date.now() ^ 0x1337c0de
    const rng  = makeRng(seed)
    const adminCtxs = [ADMIN_CTX, SUPER_ADMIN_CTX]

    for (let i = 0; i < 1_000; i++) {
      const action = generateAction(rng)
      const ctx    = adminCtxs[rng.nextInt(adminCtxs.length)]
      const wl     = new CurrencyWhitelist()

      expect(() => applyToWhitelist(wl, action, ctx)).not.toThrow(UnauthorizedError)
      expect(() => applyToWhitelist(wl, action, ctx)).not.toThrow(ForbiddenError)
    }
  })

  it('missing context (undefined cast) throws UnauthorizedError', () => {
    const wl = new CurrencyWhitelist()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => wl.add_currency('USD', undefined as any)).toThrow(UnauthorizedError)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => wl.remove_currency('USD', undefined as any)).toThrow(UnauthorizedError)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => wl.set_currencies(['USD'], undefined as any)).toThrow(UnauthorizedError)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => wl.clear_currencies(undefined as any)).toThrow(UnauthorizedError)
  })

  // -------------------------------------------------------------------------
  // 4. Idempotency of remove-then-add cycles
  // -------------------------------------------------------------------------

  it('remove(x) then add(x) leaves x present (idempotency cycle)', () => {
    const seed = Date.now() ^ 0xfeedface
    const rng  = makeRng(seed)

    for (let i = 0; i < 10_000; i++) {
      const currency = pickCurrency(rng)
      const norm     = currency.trim().toUpperCase()

      // Start with a random initial state.
      const initial  = pickCurrencies(rng, 5)
      const wl       = new CurrencyWhitelist(initial)

      wl.remove_currency(currency, ADMIN_CTX)
      expect(wl.is_allowed_currency(currency)).toBe(false)

      wl.add_currency(currency, ADMIN_CTX)
      expect(wl.is_allowed_currency(currency)).toBe(true)
      expect(wl.is_allowed_currency(norm)).toBe(true)
    }
  })

  it('add(x) then remove(x) leaves x absent (idempotency cycle)', () => {
    const seed = Date.now() ^ 0xbaadf00d
    const rng  = makeRng(seed)

    for (let i = 0; i < 10_000; i++) {
      const currency = pickCurrency(rng)
      const norm     = currency.trim().toUpperCase()

      const initial  = pickCurrencies(rng, 5)
      const wl       = new CurrencyWhitelist(initial)

      wl.add_currency(currency, ADMIN_CTX)
      expect(wl.is_allowed_currency(currency)).toBe(true)

      wl.remove_currency(currency, ADMIN_CTX)
      expect(wl.is_allowed_currency(currency)).toBe(false)
      expect(wl.is_allowed_currency(norm)).toBe(false)
    }
  })

  it('double-add is idempotent (size does not grow on second add)', () => {
    const seed = Date.now() ^ 0x0ddba11
    const rng  = makeRng(seed)

    for (let i = 0; i < 5_000; i++) {
      const currency = pickCurrency(rng)
      const wl       = new CurrencyWhitelist()

      wl.add_currency(currency, ADMIN_CTX)
      const sizeAfterFirst = wl.size

      wl.add_currency(currency, ADMIN_CTX)
      expect(wl.size).toBe(sizeAfterFirst)
    }
  })

  it('double-remove is idempotent (size does not shrink on second remove)', () => {
    const seed = Date.now() ^ 0x5ca1ab1e
    const rng  = makeRng(seed)

    for (let i = 0; i < 5_000; i++) {
      const currency = pickCurrency(rng)
      const wl       = new CurrencyWhitelist([currency])

      wl.remove_currency(currency, ADMIN_CTX)
      const sizeAfterFirst = wl.size

      wl.remove_currency(currency, ADMIN_CTX)
      expect(wl.size).toBe(sizeAfterFirst)
    }
  })

  // -------------------------------------------------------------------------
  // 5. set_currencies idempotency
  // -------------------------------------------------------------------------

  it('set_currencies called twice with the same list produces the same state', () => {
    const seed = Date.now() ^ 0xc001d00d
    const rng  = makeRng(seed)

    for (let i = 0; i < 5_000; i++) {
      const currencies = pickCurrencies(rng, 8)
      const wl         = new CurrencyWhitelist()

      wl.set_currencies(currencies, ADMIN_CTX)
      const snap1 = sortedArray(wl.snapshot())

      wl.set_currencies(currencies, ADMIN_CTX)
      const snap2 = sortedArray(wl.snapshot())

      expect(snap2).toEqual(snap1)
    }
  })

  // -------------------------------------------------------------------------
  // 6. clear_currencies idempotency
  // -------------------------------------------------------------------------

  it('clear_currencies is idempotent regardless of how many times it is called', () => {
    const seed = Date.now() ^ 0xabad1dea
    const rng  = makeRng(seed)

    for (let i = 0; i < 5_000; i++) {
      const initial = pickCurrencies(rng, 8)
      const wl      = new CurrencyWhitelist(initial)

      const repeats = 1 + rng.nextInt(5)
      for (let r = 0; r < repeats; r++) {
        wl.clear_currencies(ADMIN_CTX)
        expect(wl.size).toBe(0)
        expect(sortedArray(wl.snapshot())).toEqual([])
      }
    }
  })

  // -------------------------------------------------------------------------
  // 7. Case-normalisation invariant
  // -------------------------------------------------------------------------

  it('currency codes are normalised to upper-case regardless of input casing', () => {
    const wl = new CurrencyWhitelist()

    wl.add_currency('usd', ADMIN_CTX)
    expect(wl.is_allowed_currency('USD')).toBe(true)
    expect(wl.is_allowed_currency('usd')).toBe(true)
    expect(wl.is_allowed_currency('Usd')).toBe(true)

    wl.remove_currency('USD', ADMIN_CTX)
    expect(wl.is_allowed_currency('usd')).toBe(false)

    wl.set_currencies(['eur', 'GBP', ' JPY '], ADMIN_CTX)
    expect(wl.is_allowed_currency('EUR')).toBe(true)
    expect(wl.is_allowed_currency('gbp')).toBe(true)
    expect(wl.is_allowed_currency('jpy')).toBe(true)
    expect(wl.is_allowed_currency('USD')).toBe(false)
  })

  // -------------------------------------------------------------------------
  // 8. Snapshot isolation
  // -------------------------------------------------------------------------

  it('snapshot() returns an independent copy — mutations do not affect it', () => {
    const wl   = new CurrencyWhitelist(['USD', 'EUR'])
    const snap = wl.snapshot() as Set<string>

    wl.add_currency('GBP', ADMIN_CTX)
    expect(snap.has('GBP')).toBe(false)   // snapshot is frozen

    wl.clear_currencies(ADMIN_CTX)
    expect(snap.size).toBe(2)             // snapshot still has original 2
  })

  // -------------------------------------------------------------------------
  // 9. Constructor seed (no auth required)
  // -------------------------------------------------------------------------

  it('constructor accepts an initial iterable without requiring auth', () => {
    const wl = new CurrencyWhitelist(['USD', 'EUR', 'GBP'])
    expect(wl.is_allowed_currency('USD')).toBe(true)
    expect(wl.is_allowed_currency('EUR')).toBe(true)
    expect(wl.is_allowed_currency('GBP')).toBe(true)
    expect(wl.is_allowed_currency('JPY')).toBe(false)
    expect(wl.size).toBe(3)
  })

  // -------------------------------------------------------------------------
  // 10. Churn with super-admin context (same model equivalence)
  // -------------------------------------------------------------------------

  it('super-admin context produces identical model equivalence over 2,000 sequences', () => {
    const seed = Date.now() ^ 0x7e57c0de
    const rng  = makeRng(seed)

    for (let seqIdx = 0; seqIdx < 2_000; seqIdx++) {
      const actions = generateSequence(rng, FUZZ_ACTIONS_PER_SEQ)
      const wl    = new CurrencyWhitelist()
      const model = new Set<string>()

      for (let aIdx = 0; aIdx < actions.length; aIdx++) {
        const action = actions[aIdx]
        applyToWhitelist(wl, action, SUPER_ADMIN_CTX)
        applyToModel(model, action)
        assertEqualsModel(wl, model, seqIdx, aIdx, action)
      }
    }
  })
})
