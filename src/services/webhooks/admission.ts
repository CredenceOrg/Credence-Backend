import { createHmac, timingSafeEqual } from 'node:crypto'

export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300
export const DEFAULT_WEBHOOK_TTL_MS = 24 * 60 * 60 * 1000

export type AdmissionOutcome = 'accepted' | 'replay' | 'conflict'

export interface AdmissionInput {
  tenantId: string
  eventId: string
  timestamp: number
  rawBody: string | Buffer
  signature: string
  secret: string
}

export interface AdmissionRecord {
  tenantId: string
  eventId: string
  fingerprint: string
  statusCode: number
  responseBody: unknown
  createdAt: number
  expiresAt: number
}

export interface AdmissionResult {
  outcome: AdmissionOutcome
  record?: AdmissionRecord
}

export class WebhookAdmissionError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) {
    super(message)
    this.name = 'WebhookAdmissionError'
  }
}

function bodyBytes(rawBody: string | Buffer): Buffer {
  return Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8')
}

export function bodyFingerprint(rawBody: string | Buffer): string {
  return createHmac('sha256', 'credence-webhook-fingerprint').update(bodyBytes(rawBody)).digest('hex')
}

export function signingMaterial(input: Pick<AdmissionInput, 'tenantId' | 'eventId' | 'timestamp' | 'rawBody'>): Buffer {
  return Buffer.concat([
    Buffer.from(`v1:${input.tenantId}:${input.eventId}:${input.timestamp}:`, 'utf8'),
    bodyBytes(input.rawBody),
  ])
}

export function signIncomingWebhook(input: Pick<AdmissionInput, 'tenantId' | 'eventId' | 'timestamp' | 'rawBody'>, secret: string): string {
  if (!secret) throw new WebhookAdmissionError('SECRET_REQUIRED', 'Webhook secret is required.')
  return createHmac('sha256', secret).update(signingMaterial(input)).digest('hex')
}

export function verifyIncomingSignature(input: AdmissionInput): void {
  if (!input.tenantId || !input.eventId) throw new WebhookAdmissionError('IDENTITY_REQUIRED', 'Tenant and event identity are required.')
  if (!Number.isSafeInteger(input.timestamp) || input.timestamp <= 0) throw new WebhookAdmissionError('TIMESTAMP_INVALID', 'Webhook timestamp must be a positive integer.')
  if (!input.secret) throw new WebhookAdmissionError('SECRET_REQUIRED', 'Webhook secret is required.')
  const expected = Buffer.from(signIncomingWebhook(input, input.secret), 'hex')
  const suppliedText = input.signature.startsWith('v1=') ? input.signature.slice(3) : input.signature
  let supplied: Buffer
  try { supplied = Buffer.from(suppliedText, 'hex') } catch { throw new WebhookAdmissionError('SIGNATURE_INVALID', 'Webhook signature is invalid.') }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new WebhookAdmissionError('SIGNATURE_INVALID', 'Webhook signature is invalid.')
}

export function validateFreshness(timestamp: number, nowSeconds: number, toleranceSeconds = DEFAULT_WEBHOOK_TOLERANCE_SECONDS): void {
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) throw new WebhookAdmissionError('CLOCK_INVALID', 'Verifier clock is invalid.', 500)
  if (!Number.isSafeInteger(toleranceSeconds) || toleranceSeconds < 0) throw new WebhookAdmissionError('TOLERANCE_INVALID', 'Timestamp tolerance is invalid.', 500)
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) throw new WebhookAdmissionError('TIMESTAMP_OUT_OF_RANGE', 'Webhook timestamp is outside the acceptance window.')
}

export class InMemoryWebhookAdmissionStore {
  private readonly records = new Map<string, AdmissionRecord>()
  constructor(private readonly now: () => number = () => Date.now(), private readonly ttlMs = DEFAULT_WEBHOOK_TTL_MS) {}
  private key(tenantId: string, eventId: string): string { return `${tenantId}\u0000${eventId}` }
  private purge(now: number): void { for (const [key, record] of this.records) if (record.expiresAt <= now) this.records.delete(key) }

  claim(input: Pick<AdmissionInput, 'tenantId' | 'eventId' | 'rawBody'>, statusCode = 202, responseBody: unknown = null): AdmissionResult {
    const now = this.now(); this.purge(now)
    const key = this.key(input.tenantId, input.eventId)
    const fingerprint = bodyFingerprint(input.rawBody)
    const existing = this.records.get(key)
    if (existing) return existing.fingerprint === fingerprint ? { outcome: 'replay', record: { ...existing } } : { outcome: 'conflict', record: { ...existing } }
    const record: AdmissionRecord = { tenantId: input.tenantId, eventId: input.eventId, fingerprint, statusCode, responseBody, createdAt: now, expiresAt: now + this.ttlMs }
    this.records.set(key, record)
    return { outcome: 'accepted', record: { ...record } }
  }

  complete(tenantId: string, eventId: string, rawBody: string | Buffer, statusCode: number, responseBody: unknown): AdmissionRecord {
    const key = this.key(tenantId, eventId); const current = this.records.get(key)
    if (!current || current.fingerprint !== bodyFingerprint(rawBody)) throw new WebhookAdmissionError('RECORD_CONFLICT', 'Admission record does not match the original event.', 409)
    const record = { ...current, statusCode, responseBody }
    this.records.set(key, record); return { ...record }
  }
  get(tenantId: string, eventId: string): AdmissionRecord | undefined { const record = this.records.get(this.key(tenantId, eventId)); return record ? { ...record } : undefined }
  delete(tenantId: string, eventId: string): boolean { return this.records.delete(this.key(tenantId, eventId)) }
  size(): number { this.purge(this.now()); return this.records.size }
  clear(): void { this.records.clear() }
}

export function admitIncomingWebhook(input: AdmissionInput, store: InMemoryWebhookAdmissionStore, nowSeconds = Math.floor(Date.now() / 1000), toleranceSeconds = DEFAULT_WEBHOOK_TOLERANCE_SECONDS): AdmissionResult {
  verifyIncomingSignature(input)
  validateFreshness(input.timestamp, nowSeconds, toleranceSeconds)
  return store.claim(input)
}
