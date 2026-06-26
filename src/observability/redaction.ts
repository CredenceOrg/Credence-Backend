import {
  LOG_SCHEMAS,
  LogEventType,
  PII_PATTERNS,
  STELLAR_SENSITIVE_FIELDS,
  FieldSchema,
  getSchemaForEventType,
} from "./logSchemas.js";

/**
 * SECURITY CRITICAL: This function MUST be called before JSON serialization
 * to prevent PII from appearing in heap dumps or log output.
 *
 * Redaction strategy:
 * 1. Uses allowlist schema - unknown fields are dropped entirely
 * 2. Redacts any field name matching PII_PATTERNS (case-insensitive)
 * 3. Handles deeply nested objects and arrays with max depth protection
 * 4. Validates Stellar memo fields
 * 5. Returns ONLY fields explicitly allowed by the schema
 * 6. Handles circular references safely
 * 7. Converts non-plain objects (Map, Set, Date, etc.) to safe representations
 */

/** Maximum recursion depth to prevent stack overflow on deeply nested objects */
const MAX_REDACTION_DEPTH = 20;

/** Sentinel value for circular reference detection */
const CIRCULAR_REF_MARKER = "[Circular Reference]";

/** Sentinel value for depth-exceeded detection */
const DEPTH_EXCEEDED_MARKER = "[Max Depth Exceeded]";

export interface RedactionContext {
  eventType?: LogEventType | string;
  schema?: Record<string, FieldSchema>;
}

/**
 * Main redaction function - validates against schema and redacts PII.
 *
 * SECURITY: Always call BEFORE JSON.stringify() to prevent PII from
 * appearing in serialized output or Node.js heap dumps.
 *
 * @param obj Object to redact
 * @param context Optional context with event type and schema
 * @returns Redacted object with only allowed fields
 */
export function redact(obj: any, context?: RedactionContext): any {
  const seen = new WeakSet();
  return redactInternal(obj, context, seen, 0);
}

/**
 * Internal recursive redaction with circular reference and depth tracking.
 */
function redactInternal(
  obj: any,
  context: RedactionContext | undefined,
  seen: WeakSet<object>,
  depth: number,
): any {
  // Pass-through primitives
  if (obj === null || obj === undefined || typeof obj !== "object") {
    return obj;
  }

  // Depth guard
  if (depth >= MAX_REDACTION_DEPTH) {
    return DEPTH_EXCEEDED_MARKER;
  }

  // Circular reference guard
  if (seen.has(obj)) {
    return CIRCULAR_REF_MARKER;
  }
  seen.add(obj);

  // Handle Date objects - safe to pass through
  if (obj instanceof Date) {
    return obj.toISOString();
  }

  // Handle Map - convert to object, then redact
  if (obj instanceof Map) {
    const plain: Record<string, any> = {};
    for (const [key, value] of obj.entries()) {
      if (typeof key === "string") {
        plain[key] = value;
      }
    }
    return redactInternal(plain, context, seen, depth);
  }

  // Handle Set - convert to array, then redact
  if (obj instanceof Set) {
    return redactInternal([...obj], context, seen, depth);
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map((item) => redactInternal(item, context, seen, depth + 1));
  }

  // Handle Buffer - never log raw buffer contents
  if (Buffer.isBuffer(obj)) {
    return "[Buffer]";
  }

  // Handle Error objects - extract safe fields
  if (obj instanceof Error) {
    return {
      message: obj.message,
      name: obj.name,
      ...(obj.stack ? { stack: obj.stack } : {}),
    };
  }

  // Get the schema for this context
  const schema =
    context?.schema ||
    (context?.eventType ? getSchemaForEventType(context.eventType) : {});

  // Apply redaction with schema validation
  return redactObjectWithSchema(obj, schema, seen, depth);
}

/**
 * Redacts an object against a field schema (allowlist).
 *
 * Logic:
 * 1. If field matches PII pattern (case-insensitive): redact it
 * 2. If field matches Stellar memo pattern: redact it
 * 3. If field is in schema and allowed: keep it (recursing into nested objects)
 * 4. If field is in schema and denied: drop it
 * 5. Otherwise: drop it (fail-secure)
 */
function redactObjectWithSchema(
  obj: any,
  schema: Record<string, FieldSchema>,
  seen: WeakSet<object>,
  depth: number,
): any {
  const redactedObj: any = {};

  for (const key in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      continue;
    }

    const value = obj[key];
    const isPIIField = shouldRedactField(key);

    // Case 1: PII field or Stellar memo - always redact (safety net)
    if (isPIIField) {
      redactedObj[key] = "[REDACTED]";
      continue;
    }

    const isInSchema =
      schema && Object.prototype.hasOwnProperty.call(schema, key);

    // Case 2: Field in schema - process it
    if (isInSchema) {
      const fieldSchema = schema[key];

      // Check if schema explicitly denies this field
      if (fieldSchema.allowed === false) {
        continue;
      }

      redactedObj[key] = redactFieldValue(value, fieldSchema, seen, depth + 1);
      continue;
    }

    // Case 3: Unknown field - drop it (fail-secure)
    // Don't include field - this is the core allowlist behavior
  }

  return redactedObj;
}

/**
 * Determine if a field name should be completely redacted.
 * Uses case-insensitive matching against PII patterns and Stellar fields.
 */
function shouldRedactField(fieldName: string): boolean {
  const lowerName = fieldName.toLowerCase();

  // Check PII patterns (all stored lowercase)
  if (PII_PATTERNS.has(lowerName)) {
    return true;
  }

  // Check Stellar memo fields (all stored lowercase)
  if (STELLAR_SENSITIVE_FIELDS.has(lowerName)) {
    return true;
  }

  return false;
}

/**
 * Redact a field value based on its schema definition.
 */
function redactFieldValue(
  value: any,
  fieldSchema: FieldSchema,
  seen: WeakSet<object>,
  depth: number,
): any {
  // Explicit deny
  if (fieldSchema.allowed === false) {
    return "[REDACTED]";
  }

  // Handle null/undefined
  if (value === null || value === undefined) {
    return value;
  }

  // Handle primitives
  if (typeof value !== "object") {
    return value;
  }

  // Depth guard
  if (depth >= MAX_REDACTION_DEPTH) {
    return DEPTH_EXCEEDED_MARKER;
  }

  // Circular reference guard
  if (seen.has(value)) {
    return CIRCULAR_REF_MARKER;
  }
  seen.add(value);

  // Handle Date objects
  if (value instanceof Date) {
    return value.toISOString();
  }

  // Handle Buffer
  if (Buffer.isBuffer(value)) {
    return "[Buffer]";
  }

  // Handle arrays
  if (Array.isArray(value)) {
    if (fieldSchema.items) {
      return value.map((item) =>
        redactFieldValue(item, fieldSchema.items!, seen, depth + 1),
      );
    }
    // Without item schema, process each element recursively
    return value.map((item) => {
      if (item === null || typeof item !== "object") {
        return item;
      }
      if (Array.isArray(item)) {
        return redactFieldValue(item, fieldSchema, seen, depth + 1);
      }
      return redactObjectWithSchema(item, {}, seen, depth + 1);
    });
  }

  // Handle Map
  if (value instanceof Map) {
    const plain: Record<string, any> = {};
    for (const [k, v] of value.entries()) {
      if (typeof k === "string") {
        plain[k] = v;
      }
    }
    if (fieldSchema.nested) {
      return redactObjectWithSchema(plain, fieldSchema.nested, seen, depth + 1);
    }
    return redactObjectWithSchema(plain, {}, seen, depth + 1);
  }

  // Handle Set
  if (value instanceof Set) {
    const arr = [...value];
    if (fieldSchema.items) {
      return arr.map((item) =>
        redactFieldValue(item, fieldSchema.items!, seen, depth + 1),
      );
    }
    return arr.map((item) => {
      if (item === null || typeof item !== "object") {
        return item;
      }
      return redactObjectWithSchema(item, {}, seen, depth + 1);
    });
  }

  // For 'any' type without nested schema, pass through with PII check
  // This must come BEFORE the nested object check
  if (fieldSchema.type === "any") {
    if (typeof value === "object" && value !== null) {
      // Even for 'any' type, we still check for PII fields in nested objects
      return redactAnyObject(value, seen, depth + 1);
    }
    return value;
  }

  // Handle nested objects
  if (fieldSchema.nested) {
    return redactObjectWithSchema(value, fieldSchema.nested, seen, depth + 1);
  }

  // For nested objects without schema, return empty (fail-secure)
  // But only if the value is actually an object
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return {};
  }

  // For primitives without schema, return as-is
  return value;
}

/**
 * Redact an object of type 'any' - still checks PII patterns but allows
 * all non-PII fields through. Used for generic/fallback schemas.
 */
function redactAnyObject(obj: any, seen: WeakSet<object>, depth: number): any {
  if (obj === null || obj === undefined || typeof obj !== "object") {
    return obj;
  }

  if (depth >= MAX_REDACTION_DEPTH) {
    return DEPTH_EXCEEDED_MARKER;
  }

  if (seen.has(obj)) {
    return CIRCULAR_REF_MARKER;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => redactAnyObject(item, seen, depth + 1));
  }

  if (obj instanceof Date) {
    return obj.toISOString();
  }

  if (Buffer.isBuffer(obj)) {
    return "[Buffer]";
  }

  // Only add to seen after handling special types
  seen.add(obj);

  const result: any = {};
  for (const key in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      continue;
    }

    if (shouldRedactField(key)) {
      result[key] = "[REDACTED]";
    } else if (typeof obj[key] === "object" && obj[key] !== null) {
      result[key] = redactAnyObject(obj[key], seen, depth + 1);
    } else {
      result[key] = obj[key];
    }
  }
  return result;
}

/**
 * Legacy interface for backwards compatibility.
 * Maintains support for existing code that calls redact without context.
 * Uses PII pattern matching only (no allowlist enforcement).
 */
export function redactLegacy(obj: any): any {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(redactLegacy);
  }

  const redactedObj: any = {};
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      if (shouldRedactField(key)) {
        redactedObj[key] = "[REDACTED]";
      } else {
        redactedObj[key] = redactLegacy(obj[key]);
      }
    }
  }
  return redactedObj;
}

/**
 * Utility: Check if a field name is considered PII.
 * Exposed for use in ESLint plugin and testing.
 */
export function isPIIField(fieldName: string): boolean {
  return shouldRedactField(fieldName);
}
