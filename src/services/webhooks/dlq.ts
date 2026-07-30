import { randomUUID } from 'crypto'
import type { DlqEntry, DlqStore, WebhookDeliveryResult, WebhookPayload } from './types.js'

/** Redact the webhook secret from a payload copy (no-op for payload, but strips any secret field). */
function redactPayload(payload: WebhookPayload): WebhookPayload {
  // Payload itself carries no secret; guard against accidental future additions.
  return JSON.parse(JSON.stringify(payload))
}

export function buildDlqEntry(
  result: WebhookDeliveryResult,
  payload: WebhookPayload
): DlqEntry {
  return {
    id: randomUUID(),
    webhookId: result.webhookId,
    payload: redactPayload(payload),
    failedAt: new Date().toISOString(),
    attempts: result.attempts,
    lastStatusCode: result.statusCode,
    lastError: result.error,
    responseBodySnippet: result.responseBodySnippet,
  }
}

export class MemoryDlqStore implements DlqStore {
  private entries = new Map<string, DlqEntry>()

  async push(entry: DlqEntry): Promise<void> {
    this.entries.set(entry.id, entry)
  }

  async list(): Promise<DlqEntry[]> {
    return Array.from(this.entries.values())
  }

  async get(id: string): Promise<DlqEntry | null> {
    return this.entries.get(id) ?? null
  }

  async markReplayed(id: string, replayedAt: string): Promise<void> {
    const entry = this.entries.get(id)
    if (entry) {
      this.entries.set(id, { ...entry, replayedAt })
    }
  }
}
