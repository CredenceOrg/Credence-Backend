import type { BondRecord } from './types.js'

/**
 * Canonical payment status values for the bond lifecycle.
 *
 * | Value      | Meaning                                                  |
 * |------------|----------------------------------------------------------|
 * | unbonded   | No bond has ever been posted (zero amount, no start)     |
 * | active     | Bond is currently active and fully unpenalized           |
 * | slashed    | Bond is currently active but has incurred a penalty      |
 * | inactive   | Bond was previously active and has since been withdrawn  |
 */
export type PaymentStatus = 'active' | 'slashed' | 'inactive' | 'unbonded'

/**
 * Deprecated status aliases that older client integrations may still emit.
 * Maps legacy values to their canonical `PaymentStatus` equivalents.
 *
 * These entries exist for backward compatibility only.
 * Do not add new aliases; update callers to use canonical values instead.
 */
export const PAYMENT_STATUS_ALIASES: Readonly<Record<string, PaymentStatus>> = {
  bonded: 'active',          // used before 'active' was introduced
  active_slashed: 'slashed', // compound form before 'slashed' was extracted as its own state
  withdrawn: 'inactive',     // used before 'inactive' was standardized
}

/**
 * Returns `true` if `s` is a canonical `PaymentStatus` value.
 */
export function isPaymentStatus(s: string): s is PaymentStatus {
  return s === 'active' || s === 'slashed' || s === 'inactive' || s === 'unbonded'
}

/**
 * Resolve any known status string — canonical or legacy alias — to its
 * canonical `PaymentStatus`. Returns `null` for unrecognized values.
 *
 * @example
 * resolvePaymentStatus('bonded')        // → 'active'
 * resolvePaymentStatus('active_slashed')// → 'slashed'
 * resolvePaymentStatus('active')        // → 'active'
 * resolvePaymentStatus('unknown')       // → null
 */
export function resolvePaymentStatus(status: string): PaymentStatus | null {
  if (isPaymentStatus(status)) return status
  return PAYMENT_STATUS_ALIASES[status] ?? null
}

/**
 * Derive the canonical `PaymentStatus` from the runtime state of a
 * `BondRecord`. This is the single authoritative mapping function; all
 * serializers and route handlers must use this instead of duplicating the
 * logic inline.
 *
 * Decision matrix:
 * ```
 * active=false, bondStart=null, bondedAmount='0'  → 'unbonded'
 * active=false, (any other combination)           → 'inactive'
 * active=true,  slashedAmount > '0'               → 'slashed'
 * active=true,  slashedAmount = '0'               → 'active'
 * ```
 *
 * Note: a bond that was slashed AND then withdrawn is classified as
 * `'inactive'` because it is no longer active. `'slashed'` specifically
 * represents a currently-active bond that has incurred a penalty.
 */
export function deriveBondPaymentStatus(
  bond: Pick<BondRecord, 'active' | 'bondStart' | 'bondedAmount' | 'slashedAmount'>,
): PaymentStatus {
  if (!bond.active && !bond.bondStart && bond.bondedAmount === '0') {
    return 'unbonded'
  }

  if (!bond.active) {
    return 'inactive'
  }

  // bond.active === true beyond this point
  try {
    if (BigInt(bond.slashedAmount) > 0n) {
      return 'slashed'
    }
  } catch {
    // malformed slashedAmount — treat as unslashed
  }

  return 'active'
}
