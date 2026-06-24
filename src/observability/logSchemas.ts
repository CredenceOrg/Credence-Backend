/**
 * Log Schema Definitions - Allowlist Schema per Event Type
 *
 * Each log event type defines which fields are allowed. The redaction system
 * will drop any fields not explicitly listed in the schema for that event type.
 *
 * This allowlist approach ensures:
 * 1. Unknown fields are denied by default (fail-secure)
 * 2. PII is redacted before serialization (no heap dumps containing sensitive data)
 * 3. Renamed or nested sensitive fields cannot leak through
 *
 * ADDING A NEW EVENT TYPE:
 * 1. Add a new entry to the LogEventType enum
 * 2. Define the allowed fields in LOG_SCHEMAS
 * 3. Run `npm test -- redaction` to verify
 * 4. Update docs/observability.md with the new event type
 */

export enum LogEventType {
  // ── Outbox Publisher Events ──
  OUTBOX_PUBLISHER_STARTING = "outbox-publisher:starting",
  OUTBOX_PUBLISHER_PUBLISHED_EVENT = "outbox-publisher:published-event",
  OUTBOX_PUBLISHER_FAILED_PUBLISH = "outbox-publisher:failed-publish",
  OUTBOX_PUBLISHER_EVENT_QUARANTINED = "outbox-publisher:event-quarantined",
  OUTBOX_PUBLISHER_CLEANED_UP = "outbox-publisher:cleaned-up",
  OUTBOX_PUBLISHER_LEASE_RENEWED = "outbox-publisher:lease-renewed",

  // ── Webhook Delivery Events ──
  WEBHOOK_DELIVERY_RETRY = "webhook-delivery:retry",
  WEBHOOK_DELIVERY_EXHAUSTED = "webhook-delivery:exhausted",

  // ── Soroban Client Events ──
  SOROBAN_RETRY = "soroban:retry",

  // ── Horizon Listener Events ──
  HORIZON_LISTENER_STARTED = "horizon-listener:started",
  HORIZON_LISTENER_EVENT = "horizon-listener:event",
  HORIZON_LISTENER_ERROR = "horizon-listener:error",

  // ── Stellar Transaction Events ──
  STELLAR_TX_SUBMITTED = "stellar:tx-submitted",
  STELLAR_TX_FAILED = "stellar:tx-failed",

  // ── HTTP / Request Lifecycle Events ──
  HTTP_REQUEST = "http:request",
  HTTP_ERROR = "http:error",

  // ── Auth Events ──
  AUTH_LOGIN = "auth:login",
  AUTH_FAILURE = "auth:failure",

  // ── Generic Fallback Events ──
  GENERIC_INFO = "generic:info",
  GENERIC_ERROR = "generic:error",
  GENERIC_WARN = "generic:warn",
  GENERIC_DEBUG = "generic:debug",
}

/**
 * Field schema definition
 */
export interface FieldSchema {
  type: "string" | "number" | "boolean" | "object" | "array" | "any";
  allowed?: boolean; // Set to false to explicitly deny a field
  nested?: Record<string, FieldSchema>; // For nested objects
  items?: FieldSchema; // For arrays
}

/**
 * Complete schema mapping: event type -> allowed fields
 *
 * Any field NOT listed here is dropped during redaction (fail-secure).
 * Fields matching PII_PATTERNS are always redacted regardless of schema.
 */
export const LOG_SCHEMAS: Record<LogEventType, Record<string, FieldSchema>> = {
  // ── Outbox Publisher ──

  [LogEventType.OUTBOX_PUBLISHER_STARTING]: {
    message: { type: "string" },
    config: {
      type: "object",
      nested: {
        consumerId: { type: "string" },
        leaseSeconds: { type: "number" },
        pollIntervalMs: { type: "number" },
        cleanupIntervalMs: { type: "number" },
        batchSize: { type: "number" },
        tableName: { type: "string" },
        metricsIntervalMs: { type: "number" },
        maxPayloadBytes: { type: "number" },
        cleanup: {
          type: "object",
          nested: {
            retentionDays: { type: "number" },
            publishedRetentionDays: { type: "number" },
            failedRetentionDays: { type: "number" },
          },
        },
      },
    },
  },

  [LogEventType.OUTBOX_PUBLISHER_PUBLISHED_EVENT]: {
    message: { type: "string" },
  },

  [LogEventType.OUTBOX_PUBLISHER_FAILED_PUBLISH]: {
    message: { type: "string" },
    error: { type: "string" },
  },

  [LogEventType.OUTBOX_PUBLISHER_EVENT_QUARANTINED]: {
    message: { type: "string" },
    eventType: { type: "string" },
    reason: { type: "string" },
    error: { type: "string" },
  },

  [LogEventType.OUTBOX_PUBLISHER_CLEANED_UP]: {
    message: { type: "string" },
  },

  [LogEventType.OUTBOX_PUBLISHER_LEASE_RENEWED]: {
    message: { type: "string" },
    renewed: { type: "number" },
  },

  // ── Webhook Delivery ──

  [LogEventType.WEBHOOK_DELIVERY_RETRY]: {
    message: { type: "string" },
    provider: { type: "string" },
    attempt: { type: "number" },
    delayMs: { type: "number" },
    webhookId: { type: "string" },
    error: { type: "string" },
  },

  [LogEventType.WEBHOOK_DELIVERY_EXHAUSTED]: {
    message: { type: "string" },
    provider: { type: "string" },
    attempts: { type: "number" },
    errorCode: { type: "string" },
  },

  // ── Soroban Client ──

  [LogEventType.SOROBAN_RETRY]: {
    message: { type: "string" },
    provider: { type: "string" },
    attempt: { type: "number" },
    maxAttempts: { type: "number" },
    delayMs: { type: "number" },
    code: { type: "string" },
  },

  // ── Horizon Listener ──

  [LogEventType.HORIZON_LISTENER_STARTED]: {
    message: { type: "string" },
    cursor: { type: "string" },
    network: { type: "string" },
  },

  [LogEventType.HORIZON_LISTENER_EVENT]: {
    message: { type: "string" },
    ledger: { type: "number" },
    operationType: { type: "string" },
    transactionHash: { type: "string" },
  },

  [LogEventType.HORIZON_LISTENER_ERROR]: {
    message: { type: "string" },
    error: { type: "string" },
    cursor: { type: "string" },
  },

  // ── Stellar Transaction ──

  [LogEventType.STELLAR_TX_SUBMITTED]: {
    message: { type: "string" },
    transactionHash: { type: "string" },
    ledger: { type: "number" },
    network: { type: "string" },
  },

  [LogEventType.STELLAR_TX_FAILED]: {
    message: { type: "string" },
    transactionHash: { type: "string" },
    error: { type: "string" },
    resultCode: { type: "string" },
  },

  // ── HTTP / Request Lifecycle ──

  [LogEventType.HTTP_REQUEST]: {
    message: { type: "string" },
    method: { type: "string" },
    path: { type: "string" },
    statusCode: { type: "number" },
    durationMs: { type: "number" },
    requestId: { type: "string" },
  },

  [LogEventType.HTTP_ERROR]: {
    message: { type: "string" },
    method: { type: "string" },
    path: { type: "string" },
    statusCode: { type: "number" },
    error: { type: "string" },
    stack: { type: "string" },
    requestId: { type: "string" },
  },

  // ── Auth Events ──

  [LogEventType.AUTH_LOGIN]: {
    message: { type: "string" },
    method: { type: "string" },
    success: { type: "boolean" },
  },

  [LogEventType.AUTH_FAILURE]: {
    message: { type: "string" },
    method: { type: "string" },
    reason: { type: "string" },
  },

  // ── Generic Fallback ──

  [LogEventType.GENERIC_INFO]: {
    message: { type: "any" },
  },

  [LogEventType.GENERIC_ERROR]: {
    message: { type: "any" },
    error: { type: "string" },
    stack: { type: "string" },
  },

  [LogEventType.GENERIC_WARN]: {
    message: { type: "any" },
  },

  [LogEventType.GENERIC_DEBUG]: {
    message: { type: "any" },
  },
};

/**
 * Stellar-specific memo field handling
 * Stellar memo fields can contain sensitive data; they need special treatment
 */
export const STELLAR_SENSITIVE_FIELDS = new Set([
  "memo",
  "memovalue",
  "memodata",
  "memo_hash",
  "memo_return",
  "memo_id",
  "memotext",
  "memotype",
  "memo_type",
]);

/**
 * PII Patterns - fields that contain Personally Identifiable Information
 * These are matched case-insensitively for additional safety.
 */
export const PII_PATTERNS = new Set([
  "password",
  "secret",
  "token",
  "authorization",
  "authtoken",
  "auth_token",
  "cookie",
  "cookies",
  "email",
  "emailaddress",
  "email_address",
  "ssn",
  "social_security_number",
  "socialsecuritynumber",
  "api_key",
  "apikey",
  "client_secret",
  "clientsecret",
  "private_key",
  "privatekey",
  "publickey",
  "public_key",
  "jti",
  "sub",
  "user_id",
  "userid",
  "account_id",
  "accountid",
  "phone",
  "phonenumber",
  "phone_number",
  "creditcard",
  "credit_card",
  "ccv",
  "cvv",
  "bankaccount",
  "bank_account",
  "routingnumber",
  "routing_number",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "idtoken",
  "id_token",
  "secretkey",
  "secret_key",
  "signingkey",
  "signing_key",
  "encryptionkey",
  "encryption_key",
  "bearer",
  "credential",
  "credentials",
  "pin",
  "passcode",
  "dateofbirth",
  "date_of_birth",
  "dob",
  "nationalid",
  "national_id",
  "taxid",
  "tax_id",
  "driverslicense",
  "drivers_license",
  "passportnumber",
  "passport_number",
]);

/**
 * Get the schema for a given event type, or fallback to generic schema.
 * Unknown event types receive a restricted generic schema.
 */
export function getSchemaForEventType(
  eventType: LogEventType | string,
): Record<string, FieldSchema> {
  const schema = LOG_SCHEMAS[eventType as LogEventType];
  if (schema) {
    return schema;
  }

  // Fallback to generic schema based on context
  if (eventType.includes("error")) {
    return LOG_SCHEMAS[LogEventType.GENERIC_ERROR];
  }

  return LOG_SCHEMAS[LogEventType.GENERIC_INFO];
}

/**
 * Get all registered event type names for validation and linting.
 */
export function getRegisteredEventTypes(): string[] {
  return Object.values(LogEventType);
}
