import { FailedInboundEventsRepository, FailedInboundEvent } from '../db/repositories/failedInboundEventsRepository.js'
import { auditLogService } from './audit/index.js'

export interface ReplayHandler {
  handle(eventData: any): Promise<void>
}

/**
 * Service for capturing and replaying failed inbound events.
 */
export class ReplayService {
  private handlers = new Map<string, ReplayHandler>()

  constructor(
    private readonly repository: FailedInboundEventsRepository
  ) {}

  /**
   * Register a handler for a specific event type.
   */
  registerHandler(eventType: string, handler: ReplayHandler): void {
    this.handlers.set(eventType, handler)
  }

  /**
   * Capture a failed event for later replay.
   */
  async captureFailure(
    eventType: string,
    eventData: any,
    reason?: string,
    replayToken?: string
  ): Promise<FailedInboundEvent> {
    return this.repository.create({
      eventType,
      eventData,
      failureReason: reason,
      replayToken
    })
  }

  /**
   * Replay a failed event by ID.
   * Ensures idempotency by checking status and using AuditLogService.
   */
  async replayEvent(
    id: string,
    adminId: string,
    adminEmail: string,
    ipAddress?: string
  ): Promise<{ success: boolean; message: string }> {
    const event = await this.repository.findById(id)
    if (!event) {
      throw new Error(`Event ${id} not found`)
    }

    if (event.status === 'replayed') {
      return { success: false, message: 'Event already replayed' }
    }

    const handler = this.handlers.get(event.eventType)
    if (!handler) {
      throw new Error(`No handler registered for event type: ${event.eventType}`)
    }

    try {
      await handler.handle(event.eventData)
      
      await this.repository.updateStatus(id, 'replayed')

      auditLogService.logAction(
        adminId,
        adminEmail,
        'REPLAY_EVENT' as any, // Should add to AuditAction enum
        id,
        'system',
        { eventType: event.eventType, status: 'success' },
        'success',
        undefined,
        ipAddress
      )

      return { success: true, message: 'Event successfully replayed' }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      
      auditLogService.logAction(
        adminId,
        adminEmail,
        'REPLAY_EVENT' as any,
        id,
        'system',
        { eventType: event.eventType, status: 'failure' },
        'failure',
        errorMessage,
        ipAddress
      )

      throw new Error(`Replay failed: ${errorMessage}`)
    }
  }

  /**
   * List failed events for admin review.
   */
  async listFailedEvents(filters: { status?: any; type?: string }, limit = 50, offset = 0) {
    return this.repository.list(filters, limit, offset)
  }
}
