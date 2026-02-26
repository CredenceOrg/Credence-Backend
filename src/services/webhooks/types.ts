/**
 * Webhook event types for bond lifecycle.
 */
export type WebhookEventType = 'bond.created' | 'bond.slashed' | 'bond.withdrawn'

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
  /** Secret key for HMAC signature verification. */
  secret: string
  /** Whether this webhook is active. */
  active: boolean
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
}
