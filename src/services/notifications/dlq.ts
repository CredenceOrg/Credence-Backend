import { randomUUID } from 'crypto'
import type {
  EmailNotification,
  NotificationDlqAttempt,
  NotificationDlqEntry,
  NotificationDlqStore,
} from './types.js'

function cloneNotification(notification: EmailNotification): EmailNotification {
  return JSON.parse(JSON.stringify(notification)) as EmailNotification
}

/**
 * Builds a DLQ entry for an exhausted or ambiguous notification delivery.
 */
export function buildNotificationDlqEntry(input: {
  notification: EmailNotification
  providers: string[]
  attempts: NotificationDlqAttempt[]
  failureReason: string
}): NotificationDlqEntry {
  return {
    id: randomUUID(),
    notification: cloneNotification(input.notification),
    providers: [...input.providers],
    attempts: [...input.attempts],
    failureReason: input.failureReason,
    failedAt: new Date().toISOString(),
  }
}

/**
 * In-memory DLQ store for notification delivery failures.
 */
export class MemoryNotificationDlqStore implements NotificationDlqStore {
  private readonly entries = new Map<string, NotificationDlqEntry>()

  async push(entry: NotificationDlqEntry): Promise<void> {
    this.entries.set(entry.id, entry)
  }

  async list(): Promise<NotificationDlqEntry[]> {
    return Array.from(this.entries.values())
  }
}
