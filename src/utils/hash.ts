import crypto from 'node:crypto'

/**
 * Computes a SHA-256 hash of the request body to detect payload mismatches
 * for idempotent requests.
 *
 * Uses a canonical serialization strategy that sorts object keys recursively and
 * preserves type distinctions for values like BigInt, Date, and undefined.
 *
 * @param body - The request body object
 * @returns Hex-encoded SHA-256 hash
 */
export function computeRequestHash(body: any): string {
  return computeStableHash(body || {})
}

/**
 * Computes a stable SHA-256 hash for the provided value using canonical serialization.
 */
export function computeStableHash(value: any): string {
  const canonicalBody = canonicalStringify(value)
  return crypto.createHash('sha256').update(canonicalBody).digest('hex')
}

/**
 * Canonical stringifier that sorts object keys recursively and preserves type distinctions.
 */
export function canonicalStringify(value: any): string {
  return serializeValue(value)
}

function serializeValue(value: any): string {
  if (value === undefined) {
    return '{"$type":"undefined"}'
  }

  if (value === null) {
    return 'null'
  }

  if (typeof value === 'string') {
    return JSON.stringify(value)
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }

  if (typeof value === 'number') {
    if (Number.isNaN(value)) {
      return '{"$type":"number","value":"NaN"}'
    }

    if (!Number.isFinite(value)) {
      return `{"$type":"number","value":"${value > 0 ? 'Infinity' : '-Infinity'}"}`
    }

    return JSON.stringify(value)
  }

  if (typeof value === 'bigint') {
    return `{"$type":"bigint","value":"${value.toString()}"}`
  }

  if (value instanceof Date) {
    return `{"$type":"date","value":"${value.toISOString()}"}`
  }

  if (Array.isArray(value)) {
    return '[' + value.map(serializeValue).join(',') + ']'
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value).sort()
    const serializedEntries = keys.map(key => `${JSON.stringify(key)}:${serializeValue(value[key])}`)
    return '{' + serializedEntries.join(',') + '}'
  }

  return JSON.stringify(value)
}
