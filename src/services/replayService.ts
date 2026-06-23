import { FailedInboundEventsRepository, FailedInboundEvent } from '../db/repositories/failedInboundEventsRepository.js'
import { auditLogService } from './audit/index.js'
import { cache } from '../cache/redis.js'
import { invalidateCache } from '../cache/invalidation.js'

const FAILED_EVENT_CACHE_TTL = 300 // 5 minutes

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
   * Get failed event by ID with caching.
   */
  async getFailedEvent(id: string): Promise<FailedInboundEvent | null> {
    const cached = await cache.get<FailedInboundEvent>('failed_event', id)
    
    if (cached) {
      return cached
    }
    
    const event = await this.repository.findById(id)
    if (event) {
      await cache.set('failed_event', id, event, FAILED_EVENT_CACHE_TTL)
    }
    
    return event
  }

  /**
   * Replay a failed event by ID.
   * Ensures idempotency by checking status and using AuditLogService.
   */
  async replayEvent(
    id: string,
    adminId: string,
    adminEmail: string,
    tenantId: string,
    ipAddress?: string
  ): Promise<{ success: boolean; message: string }> {
    const event = await this.getFailedEvent(id)
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
      
      // Invalidate cache after status update
      const updatedEvent = await this.repository.findById(id)
      if (updatedEvent) {
        await invalidateCache('failed_event', id, updatedEvent, {
          verify: true,
          verifyFn: (cached, fresh) => cached.status !== fresh.status
        })
      }

      auditLogService.logAction(
        tenantId,
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
        tenantId,
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
