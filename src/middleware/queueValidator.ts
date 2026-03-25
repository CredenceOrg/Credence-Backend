import { QueueSchemaRegistry, QueueMessageType } from '../schemas/queue.schema.js';

export interface ValidationResult {
  success: boolean;
  data?: any;
  error?: string;
}

/**
 * Validates a queue payload against the registry.
 * Includes version negotiation to ensure backward compatibility.
 */
export function validatePayload(type: string, payload: any): ValidationResult {
  const schema = QueueSchemaRegistry[type as QueueMessageType];

  // 1. Check if the message type is supported
  if (!schema) {
    return { 
      success: false, 
      error: `Unknown message type: ${type}` 
    };
  }

  // 2. Version Negotiation Requirement
  // Current worker only supports v1. Reject anything else to DLQ.
  const incomingVersion = payload?.version;
  const SUPPORTED_VERSION = 1;

  if (incomingVersion !== SUPPORTED_VERSION) {
    return {
      success: false,
      error: `Version Mismatch: Received v${incomingVersion || 'unknown'}, but only v${SUPPORTED_VERSION} is supported.`
    };
  }

  // 3. Structural Validation using Zod
  const result = schema.safeParse(payload);

  if (!result.success) {
    return {
      success: false,
      error: JSON.stringify(result.error.flatten().fieldErrors)
    };
  }

  return { success: true, data: result.data };
}