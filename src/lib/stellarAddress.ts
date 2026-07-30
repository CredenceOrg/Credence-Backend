/**
 * Stellar strkey public key / account address validation.
 * 56 characters: G + 55 chars from base32 alphabet A–Z and 2–7.
 */
export function isValidStellarAddress(address: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(address)
}
