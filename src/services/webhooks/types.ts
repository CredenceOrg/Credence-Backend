/**
 * Webhook event types for bond lifecycle.
 */
export type WebhookEventType = 'bond.created' | 'bond.slashed' | 'bond.withdrawn' | 'attestation.added' | 'attestation.revoked' | 'score.updated' | 'attestation.added' | 'attestation.revoked' | 'score.updated'

/**
 * Webhook configuration for a registered endpoint.
 */
export interface WebhookConfig {
  /** Unique identifier for this webhook. */
  id: string
  /** Target URL to POST events to. */
  url: string
  /** Events this webhook is subscribed to. */
  events: WebhookEventType[]
  /** Current HMAC signing secret. */
  secret: string
  /** Previously active secret (during grace period). */
  previousSecret?: string
  /** Timestamp when the secret was last rotated. */
  secretUpdatedAt: Date
  /** Whether this webhook is active. */
  active: boolean
  /** ISO timestamp when the secret was last rotated. */
  secretRotatedAt?: string
  /** ISO timestamp after which previousSecret is no longer valid. */
  previousSecretExpiresAt?: string
  /** Optional per-webhook delivery retry attempt cap. */
  maxAttempts?: number
  /** Optional per-webhook delivery timeout in milliseconds. */
  timeoutMs?: number
  /** Optional mTLS client certificate (PEM) presented to the endpoint. */
  clientCertPem?: string
  /** Optional KMS reference for the mTLS client private key. */
  clientKeyKmsRef?: string
  /** Optional SHA-256 pin of the expected server certificate. */
  pinnedServerCertSha256?: string
}

/**
 * Result returned to the caller after a successful secret rotation.
 * newSecret is shown exactly once — it is never persisted in plain text.
 */
export interface WebhookSecretRotationResult {
  webhookId: string
  newSecret: string
  rotatedAt: string
  previousSecretExpiresAt: string
}

/**
 * Webhook payload sent to registered endpoints.
 */
export interface WebhookPayload {
  /** Event type. */
  event: WebhookEventType
  /** ISO timestamp when event occurred. */
  timestamp: string
  /** Event data (identity state). */
  data: {
    address: string
    bondedAmount: string
    bondStart: number | null
    bondDuration: number | null
    active: boolean
    attestationId?: string
    verifier?: string
    weight?: number
    claim?: string
    score?: number
  }
}

/**
 * Webhook delivery attempt result.
 */
export interface WebhookDeliveryResult {
  /** Webhook ID. */
  webhookId: string
  /** Whether delivery succeeded. */
  success: boolean
  /** HTTP status code if request was made. */
  statusCode?: number
  /** Error message if failed. */
  error?: string
  /** Number of attempts made. */
  attempts: number
  /** First 500 chars of response body on failure. */
  responseBodySnippet?: string
  /** Error code for mTLS-specific failures. */
  errorCode?: string
}

/**
 * Dead-letter queue entry for a permanently failed webhook delivery.
 */
export interface DlqEntry {
  id: string
  webhookId: string
  /** Payload with secrets redacted. */
  payload: WebhookPayload
  failedAt: string
  attempts: number
  lastStatusCode?: number
  lastError?: string
  responseBodySnippet?: string
  /** ISO timestamp of last replay attempt, if any. */
  replayedAt?: string
}

/**
 * Store for dead-letter queue entries.
 */
export interface DlqStore {
  push(entry: DlqEntry): Promise<void>
  list(): Promise<DlqEntry[]>
  get(id: string): Promise<DlqEntry | null>
  markReplayed(id: string, replayedAt: string): Promise<void>
}

/**
 * Store for webhook configurations.
 */
export interface WebhookStore {
  /** Get all active webhooks subscribed to an event type. */
  getByEvent(event: WebhookEventType): Promise<WebhookConfig[]>
  /** Get webhook by ID. */
  get(id: string): Promise<WebhookConfig | null>
  /** Save or update webhook config. */
  set(config: WebhookConfig): Promise<void>
  /**
   * Atomically swap in a new signing secret while preserving the old one
   * for the given grace period. Implementations must treat this as a single
   * operation so concurrent rotations cannot race.
   */
  rotateSecret(
    id: string,
    newSecret: string,
    previousSecret: string,
    previousSecretExpiresAt: string,
  ): Promise<WebhookConfig>
}