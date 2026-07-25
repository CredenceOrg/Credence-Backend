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
