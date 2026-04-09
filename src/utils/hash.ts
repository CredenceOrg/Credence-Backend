import crypto from 'node:crypto'

/**
 * Computes a SHA-256 hash of the request body to detect payload mismatches
 * for idempotent requests.
 * 
 * @param body - The request body object
 * @returns Hex-encoded SHA-256 hash
 */
export function computeRequestHash(body: any): string {
  // Canonicalize the body by stringifying it.
  // Note: This assumes keys are in a consistent order if the client is consistent.
  // For better robustness, one could sort keys, but JSON.stringify is usually enough
  // for identical payloads from the same client.
  const content = JSON.stringify(body || {})
  return crypto.createHash('sha256').update(content).digest('hex')
}
