/**
 * Sanitizes publish-failure error messages before they are persisted to
 * `event_outbox.error_message`. Exception messages can incidentally include
 * secrets that leaked into an upstream error (e.g. a webhook client
 * embedding an Authorization header or signed URL in its error text), and
 * unbounded messages can bloat storage/logs. Both are stripped here so the
 * DB column stays a safe, bounded diagnostic string.
 */

/** Maximum length retained for a stored error message. */
export const MAX_ERROR_MESSAGE_LENGTH = 2000

const TRUNCATION_SUFFIX = '...[truncated]'

// Patterns with no capture group: the whole match is replaced outright.
const SECRET_PATTERNS: RegExp[] = [
  // Stellar secret seed (starts with 'S', 56-char base32 strkey)
  /\bS[A-Z2-7]{55}\b/g,
  // Authorization / Bearer tokens
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /\bAuthorization\s*:\s*\S+/gi,
  // JWTs
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  // Email addresses
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
]

// API-key style query params / assignments (key=value, token=value, ...).
// Captures the key name + separator ($1) so it can be preserved while the
// value itself is redacted.
const KEY_VALUE_SECRET_PATTERN =
  /\b((?:api[_-]?key|access[_-]?token|secret|password|client[_-]?secret)\s*[=:]\s*)[^\s&"']+/gi

/**
 * Redact known secret/PII shapes and cap the length of an error message
 * before it is stored. Redaction runs before truncation so a secret
 * straddling the length limit can't be cut in half and left partially
 * exposed.
 */
export function sanitizeErrorMessage(
  message: string | null | undefined,
  maxLength: number = MAX_ERROR_MESSAGE_LENGTH
): string {
  if (!message) {
    return ''
  }

  let sanitized = message
  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]')
  }
  sanitized = sanitized.replace(KEY_VALUE_SECRET_PATTERN, '$1[REDACTED]')

  if (sanitized.length > maxLength) {
    sanitized = sanitized.slice(0, maxLength) + TRUNCATION_SUFFIX
  }

  return sanitized
}
