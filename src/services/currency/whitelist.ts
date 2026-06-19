/**
 * Currency whitelist service.
 *
 * Maintains the set of ISO 4217 currency codes that the platform accepts.
 * All mutating operations require admin authentication — callers must pass
 * a validated {@link AdminContext} obtained from the auth middleware.
 *
 * The whitelist is stored as a plain `Set<string>` so that membership tests
 * are O(1) and the full set can be snapshotted cheaply for audit purposes.
 *
 * @module currency/whitelist
 */

import { ForbiddenError, UnauthorizedError } from '../../lib/errors.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal caller context required for admin-gated operations.
 * Populated by `requireUserAuth` + `requireAdminRole` middleware and passed
 * explicitly so the service remains testable without an HTTP layer.
 */
export interface AdminContext {
  /** Surrogate user ID (UUID). */
  userId: string
  /**
   * Role string.  Must be `"admin"` or `"super-admin"` to pass the guard.
   */
  role: string
}

/**
 * Result returned by every mutating whitelist operation.
 * Carries the post-mutation snapshot so callers can log or assert state.
 */
export interface WhitelistMutationResult {
  /** Snapshot of the whitelist **after** the mutation was applied. */
  currencies: ReadonlySet<string>
  /** Human-readable description of what changed. */
  description: string
}

// ---------------------------------------------------------------------------
// Auth guard
// ---------------------------------------------------------------------------

/** Roles that are permitted to mutate the whitelist. */
const ADMIN_ROLES = new Set(['admin', 'super-admin'])
const ISO_4217_CODE = /^[A-Z]{3}$/

/**
 * Normalises a caller-supplied ISO 4217 currency code.
 *
 * Canonical form is exactly three ASCII uppercase letters. Rejecting anything
 * else keeps look-alike Unicode, blank strings, and concatenated symbols out
 * of the allow-list security boundary.
 */
export function normalize_currency_code(currency: string): string {
  const normalised = currency.trim().toUpperCase()
  if (!ISO_4217_CODE.test(normalised)) {
    throw new TypeError(`Invalid ISO 4217 currency code: ${currency}`)
  }
  return normalised
}

/**
 * Throws {@link UnauthorizedError} when `ctx` is absent and
 * {@link ForbiddenError} when the role is insufficient.
 *
 * @internal
 */
function assertAdmin(ctx: AdminContext | undefined): void {
  if (!ctx) {
    throw new UnauthorizedError('Admin context is required to mutate the currency whitelist')
  }
  if (!ADMIN_ROLES.has(ctx.role)) {
    throw new ForbiddenError(
      `Role "${ctx.role}" is not permitted to mutate the currency whitelist; ` +
        `required: ${[...ADMIN_ROLES].join(' | ')}`,
    )
  }
}

// ---------------------------------------------------------------------------
// CurrencyWhitelist class
// ---------------------------------------------------------------------------

/**
 * Stateful currency whitelist.
 *
 * Create one instance per application (singleton) or per test (isolated).
 * All mutating methods enforce admin authorisation via {@link AdminContext}.
 *
 * @example
 * ```typescript
 * const wl = new CurrencyWhitelist(['USD', 'EUR'])
 * wl.add_currency('GBP', adminCtx)
 * wl.is_allowed_currency('GBP') // true
 * wl.remove_currency('EUR', adminCtx)
 * wl.is_allowed_currency('EUR') // false
 * ```
 */
export class CurrencyWhitelist {
  /** Internal backing store — never exposed by reference. */
  private readonly _set: Set<string>

  /**
   * @param initial - Optional seed currencies (no auth required at
   *   construction time; use for bootstrapping from persisted config).
   */
  constructor(initial: Iterable<string> = []) {
    this._set = new Set(
      [...initial].map((c) => normalize_currency_code(c)),
    )
  }

  // -------------------------------------------------------------------------
  // Read operations (no auth required)
  // -------------------------------------------------------------------------

  /**
   * Returns `true` when `currency` is in the whitelist.
   *
   * Comparison is case-insensitive (normalised to upper-case).
   *
   * @param currency - ISO 4217 code to test (e.g. `"usd"` or `"USD"`).
   */
  is_allowed_currency(currency: string): boolean {
    return this._set.has(normalize_currency_code(currency))
  }

  /**
   * Returns a **frozen snapshot** of the current whitelist.
   * Mutations to the returned set do not affect the whitelist.
   */
  snapshot(): ReadonlySet<string> {
    return new Set(this._set)
  }

  /** Number of currencies currently in the whitelist. */
  get size(): number {
    return this._set.size
  }

  // -------------------------------------------------------------------------
  // Mutating operations (admin auth required)
  // -------------------------------------------------------------------------

  /**
   * Adds a single currency to the whitelist.
   *
   * Idempotent: adding a currency that is already present is a no-op
   * (the whitelist is unchanged and no error is thrown).
   *
   * @param currency - ISO 4217 code to add.
   * @param ctx      - Admin caller context (role must be `admin` or `super-admin`).
   * @returns Mutation result with the post-add snapshot.
   * @throws {@link UnauthorizedError} when `ctx` is absent.
   * @throws {@link ForbiddenError} when the caller lacks admin privileges.
   */
  add_currency(currency: string, ctx: AdminContext): WhitelistMutationResult {
    assertAdmin(ctx)
    const normalised = normalize_currency_code(currency)
    const wasPresent = this._set.has(normalised)
    this._set.add(normalised)
    return {
      currencies: this.snapshot(),
      description: wasPresent
        ? `add_currency(${normalised}): already present — no-op`
        : `add_currency(${normalised}): added`,
    }
  }

  /**
   * Removes a single currency from the whitelist.
   *
   * Idempotent: removing a currency that is not present is a no-op
   * (the whitelist is unchanged and no error is thrown).
   *
   * @param currency - ISO 4217 code to remove.
   * @param ctx      - Admin caller context.
   * @returns Mutation result with the post-remove snapshot.
   * @throws {@link UnauthorizedError} when `ctx` is absent.
   * @throws {@link ForbiddenError} when the caller lacks admin privileges.
   */
  remove_currency(currency: string, ctx: AdminContext): WhitelistMutationResult {
    assertAdmin(ctx)
    const normalised = normalize_currency_code(currency)
    const wasPresent = this._set.has(normalised)
    this._set.delete(normalised)
    return {
      currencies: this.snapshot(),
      description: wasPresent
        ? `remove_currency(${normalised}): removed`
        : `remove_currency(${normalised}): not present — no-op`,
    }
  }

  /**
   * Replaces the entire whitelist with the provided set of currencies.
   *
   * This is an atomic swap: the old contents are discarded and the new
   * set is installed in a single operation.  Passing an empty array
   * clears the whitelist (equivalent to {@link clear_currencies}).
   *
   * @param currencies - New complete set of ISO 4217 codes.
   * @param ctx        - Admin caller context.
   * @returns Mutation result with the post-set snapshot.
   * @throws {@link UnauthorizedError} when `ctx` is absent.
   * @throws {@link ForbiddenError} when the caller lacks admin privileges.
   */
  set_currencies(currencies: string[], ctx: AdminContext): WhitelistMutationResult {
    assertAdmin(ctx)
    const normalisedCurrencies = currencies.map((c) => normalize_currency_code(c))
    this._set.clear()
    for (const c of normalisedCurrencies) {
      this._set.add(c)
    }
    return {
      currencies: this.snapshot(),
      description: `set_currencies([${[...this._set].join(', ')}]): whitelist replaced`,
    }
  }

  /**
   * Removes all currencies from the whitelist.
   *
   * Idempotent: calling on an already-empty whitelist is a no-op.
   *
   * @param ctx - Admin caller context.
   * @returns Mutation result with an empty snapshot.
   * @throws {@link UnauthorizedError} when `ctx` is absent.
   * @throws {@link ForbiddenError} when the caller lacks admin privileges.
   */
  clear_currencies(ctx: AdminContext): WhitelistMutationResult {
    assertAdmin(ctx)
    this._set.clear()
    return {
      currencies: this.snapshot(),
      description: 'clear_currencies(): whitelist cleared',
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton export (application-level instance)
// ---------------------------------------------------------------------------

/**
 * Application-level singleton whitelist.
 *
 * Seeded with the most common ISO 4217 codes.  Tests should create their
 * own `new CurrencyWhitelist()` instances rather than mutating this one.
 */
export const currencyWhitelist = new CurrencyWhitelist([
  'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF',
  'JPY', 'KRW', 'MXN', 'BRL', 'SGD', 'HKD',
  'SEK', 'NOK', 'DKK', 'ZAR', 'INR',
  'KWD', 'BHD', 'OMR', 'JOD',
])
