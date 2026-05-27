/**
 * Normalize Ethereum-style addresses to lowercase for consistent storage and lookup.
 * Stellar (G...) addresses are returned unchanged.
 */
export function normalizeAddress(address: string): string {
  const trimmed = address.trim()
  if (trimmed.startsWith('0x') || trimmed.startsWith('0X')) {
    return `0x${trimmed.slice(2).toLowerCase()}`
  }
  return trimmed
}
