import { AsyncLocalStorage } from "async_hooks";
import {
  redact,
  redactLegacy,
  RedactionContext,
} from "../observability/redaction.js";

// Storage to hold IDs and structured logging fields for the duration of a request
export const tracingContext = new AsyncLocalStorage<Map<string, string>>();

type LogLevel = "INFO" | "ERROR" | "WARN" | "DEBUG";

/**
 * Format a log message with metadata and redaction
 *
 * SECURITY CRITICAL: Redaction happens BEFORE JSON serialization to prevent
 * PII from appearing in logs or heap dumps.
 *
 * @param level Log level
 * @param message The message to log
 * @param redactionContext Optional context for schema-aware redaction
 */
function formatMessage(
  level: LogLevel,
  message: string | object,
  redactionContext?: RedactionContext,
  customContext?: Map<string, string>,
) {
  const context = customContext || tracingContext.getStore();

  const metadata = {
    level,
    timestamp: new Date().toISOString(),
    requestId: context?.get("requestId") || "N/A",
    correlationId: context?.get("correlationId") || "N/A",
    route: context?.get("route") || "N/A",
    tenant: context?.get("tenant") || "N/A",
    actor: context?.get("actor") || "N/A",
  };

  if (typeof message === "object") {
    // Apply schema-aware redaction if context provided, otherwise use legacy redaction
    const redacted = redactionContext
      ? redact(message, redactionContext)
      : redactLegacy(message);
    return JSON.stringify({ ...metadata, ...redacted });
  }

  return JSON.stringify({ ...metadata, message });
}

export const logger = {
  info: (message: string | object, redactionContext?: RedactionContext) => {
    console.log(formatMessage("INFO", message, redactionContext));
  },
  error: (message: string | object, error?: any, redactionContext?: RedactionContext) => {
    const msg = error
      ? { message, error: error.message || error, stack: error.stack }
      : message;
    console.error(formatMessage("ERROR", msg, redactionContext));
  },
  warn: (message: string | object, redactionContext?: RedactionContext) => {
    console.warn(formatMessage("WARN", message, redactionContext));
  },
  debug: (message: string | object, redactionContext?: RedactionContext) => {
    if (
      process.env.DEBUG === "true" ||
      process.env.NODE_ENV === "development"
    ) {
      console.debug(formatMessage("DEBUG", message, redactionContext));
    }
  },
};

export interface RequestLogger {
  info(message: string | object, redactionContext?: RedactionContext): void;
  warn(message: string | object, redactionContext?: RedactionContext): void;
  error(message: string | object, error?: any, redactionContext?: RedactionContext): void;
  debug(message: string | object, redactionContext?: RedactionContext): void;
}

/**
 * Correlation identifiers captured from the active tracing context so they
 * can be carried across an async boundary (e.g. into a background job or a
 * webhook delivery) and restored later via `runWithCorrelationIds`.
 */
export interface CorrelationIds {
  correlationId?: string
  requestId?: string
}

/**
 * Allowed characters for a correlation/request id once it leaves the
 * process boundary (used in outbound HTTP headers and persisted to the
 * database). Strips anything that isn't a safe token character to prevent
 * header/log injection (e.g. CRLF) from a value that originated from an
 * external caller. Truncated to a sane length as a defense-in-depth measure.
 */
const SAFE_ID_PATTERN = /[^A-Za-z0-9._:-]/g
const MAX_ID_LENGTH = 128

export function sanitizeCorrelationId(value: string | undefined | null): string | undefined {
  if (!value) return undefined
  const cleaned = value.replace(SAFE_ID_PATTERN, "").slice(0, MAX_ID_LENGTH)
  return cleaned.length > 0 ? cleaned : undefined
}

/**
 * Snapshot the correlation/request ids from the currently active tracing
 * context (if any). Intended to be called at the point where work is being
 * handed off to an async job or outbound webhook, so the ids can travel
 * with the job/event and be restored later — even in a different process —
 * via `runWithCorrelationIds`.
 */
export function getActiveCorrelationIds(): CorrelationIds {
  const store = tracingContext.getStore()
  const correlationId = store?.get("correlationId")
  const requestId = store?.get("requestId")
  return {
    correlationId: correlationId && correlationId !== "N/A" ? correlationId : undefined,
    requestId: requestId && requestId !== "N/A" ? requestId : undefined,
  }
}

/**
 * Run `fn` with the given correlation/request ids installed in the tracing
 * context, so any `logger`/`req.log` calls made during `fn` (directly or in
 * nested async calls) are tagged with them. Values are sanitized before
 * being installed since they may have originated outside this process
 * (e.g. round-tripped through a database row).
 */
export function runWithCorrelationIds<T>(ids: CorrelationIds, fn: () => T): T {
  const context = new Map<string, string>()
  const correlationId = sanitizeCorrelationId(ids.correlationId)
  const requestId = sanitizeCorrelationId(ids.requestId)
  if (correlationId) context.set("correlationId", correlationId)
  if (requestId) context.set("requestId", requestId)
  return tracingContext.run(context, fn)
}

export function createRequestLogger(customContext: Map<string, string>): RequestLogger {
  return {
    info: (message: string | object, redactionContext?: RedactionContext) => {
      console.log(formatMessage("INFO", message, redactionContext, customContext));
    },
    error: (message: string | object, error?: any, redactionContext?: RedactionContext) => {
      const msg = error
        ? { message, error: error.message || error, stack: error.stack }
        : message;
      console.error(formatMessage("ERROR", msg, redactionContext, customContext));
    },
    warn: (message: string | object, redactionContext?: RedactionContext) => {
      console.warn(formatMessage("WARN", message, redactionContext, customContext));
    },
    debug: (message: string | object, redactionContext?: RedactionContext) => {
      if (
        process.env.DEBUG === "true" ||
        process.env.NODE_ENV === "development"
      ) {
        console.debug(formatMessage("DEBUG", message, redactionContext, customContext));
      }
    },
  };
}
