import { createHmac, timingSafeEqual } from 'node:crypto'

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing_secret' | 'missing_signature' | 'malformed_signature' | 'invalid_signature' }

export function parseSignatureHeader(raw: string | null | undefined): string | null {
  if (raw == null) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const candidate = trimmed.toLowerCase().startsWith('sha256=')
    ? trimmed.slice('sha256='.length).trim()
    : trimmed.toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(candidate)) return null
  return candidate
}

export function computeHmac(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

export function safeCompareHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}

export function verifySignature(
  rawSignature: string | null | undefined,
  body: string,
  currentSecret: string | null | undefined,
  previousSecret?: string | null | undefined
): VerifyResult {
  if (!currentSecret && !previousSecret) return { ok: false, reason: 'missing_secret' }
  if (rawSignature == null || rawSignature === '') {
    return { ok: false, reason: 'missing_signature' }
  }

  const received = parseSignatureHeader(rawSignature)
  if (!received) return { ok: false, reason: 'malformed_signature' }

  // Try current secret first
  if (currentSecret) {
    const expected = computeHmac(body, currentSecret)
    if (safeCompareHex(expected, received)) return { ok: true }
  }

  // Fallback to previous secret if within rotation window
  if (previousSecret) {
    const expectedPrev = computeHmac(body, previousSecret)
    if (safeCompareHex(expectedPrev, received)) return { ok: true }
  }

  return { ok: false, reason: 'invalid_signature' }
}
