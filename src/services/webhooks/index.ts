export * from './types.js'
export * from './delivery.js'
export * from './service.js'
export * from './dlq.js'

import { MemoryDlqStore } from './dlq.js'
import { MemoryWebhookStore } from './memoryStore.js'

/** Shared singleton DLQ store. */
export const dlqStore = new MemoryDlqStore()

/** Shared singleton webhook config store. */
export const memoryWebhookStore = new MemoryWebhookStore()

