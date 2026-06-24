import crypto from 'node:crypto'

/**
 * Computes a SHA-256 hash of the request body to detect payload mismatches
 * for idempotent requests.
 * 
 * Uses a canonical JSON stringification (sorted keys) to ensure that
 * semantically identical payloads produce the same hash regardless of key order.
 * 
 * @param body - The request body object
 * @returns Hex-encoded SHA-256 hash
 */
export function computeRequestHash(body: any): string {
  const canonicalBody = canonicalStringify(body || {})
  return crypto.createHash('sha256').update(canonicalBody).digest('hex')
}

/**
 * Simple canonical stringify that sorts object keys recursively.
 */
function canonicalStringify(obj: any): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj)
  }

  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalStringify).join(',') + ']'
  }

  const keys = Object.keys(obj).sort()
  return '{' + keys.map(k => `"${k}":${canonicalStringify(obj[k])}`).join(',') + '}'
}
