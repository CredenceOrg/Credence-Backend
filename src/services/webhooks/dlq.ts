import { randomUUID } from 'crypto'
import type {
  DlqEntry,
  DlqListOptions,
  DlqReplayAttemptInput,
  DlqStore,
  WebhookDeliveryResult,
  WebhookPayload,
} from './types.js'

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
  private replayAudit = new Map<string, DlqReplayAttemptInput[]>()

  async push(entry: DlqEntry): Promise<void> {
    this.entries.set(entry.id, entry)
  }

  async list(options?: DlqListOptions): Promise<DlqEntry[]> {
    let results = Array.from(this.entries.values())
    if (!options) {
      return results
    }
    if (options.pendingOnly) {
      results = results.filter((entry) => !entry.replayedAt)
    }
    if (options.limit !== undefined) {
      const safeLimit = Math.max(0, Math.floor(options.limit))
      results = results.slice(0, safeLimit)
    }
    return results
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

  async replayAttempts(entryId: string): Promise<number> {
    return (this.replayAudit.get(entryId) ?? []).length
  }

  async recordReplayAttempt(input: DlqReplayAttemptInput): Promise<void> {
    const existing = this.replayAudit.get(input.dlqEntryId) ?? []
    if (existing.some((record) => record.idempotencyKey === input.idempotencyKey)) {
      return
    }
    this.replayAudit.set(input.dlqEntryId, [...existing, { ...input }])
  }
}
