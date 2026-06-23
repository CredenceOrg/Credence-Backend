import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ReplayService } from './replayService.js'
import { FailedInboundEventsRepository } from '../db/repositories/failedInboundEventsRepository.js'
import { auditLogService } from './audit/index.js'
import { cache } from '../cache/redis.js'
import * as invalidation from '../cache/invalidation.js'

vi.mock('../cache/redis.js', () => ({
  cache: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn()
  }
}))

vi.mock('../cache/invalidation.js', async () => {
  const actual = await vi.importActual('../cache/invalidation.js')
  return {
    ...actual,
    invalidateCache: vi.fn()
  }
})

describe('ReplayService', () => {
  let replayService: ReplayService
  let mockRepo: any
  let mockHandler: any

  beforeEach(() => {
    vi.clearAllMocks()
    mockRepo = {
      create: vi.fn(),
      findById: vi.fn(),
      updateStatus: vi.fn(),
      list: vi.fn(),
    }
    vi.mock('./audit/index.js', () => ({
      auditLogService: {
        logAction: vi.fn(),
      },
    }))

    replayService = new ReplayService(mockRepo as any)
    mockHandler = { handle: vi.fn().mockResolvedValue(undefined) }
    replayService.registerHandler('test_event', mockHandler)
  })

  it('should capture failure', async () => {
    const eventData = { foo: 'bar' }
    await replayService.captureFailure('test_event', eventData, 'some reason')
    expect(mockRepo.create).toHaveBeenCalledWith({
      eventType: 'test_event',
      eventData,
      failureReason: 'some reason',
      replayToken: undefined,
    })
  })

  it('should get failed event from cache if available', async () => {
    const event = {
      id: '123',
      eventType: 'test_event',
      eventData: { foo: 'bar' },
      status: 'failed',
    }
    vi.mocked(cache.get).mockResolvedValue(event)

    const result = await replayService.getFailedEvent('123')

    expect(cache.get).toHaveBeenCalledWith('failed_event', '123')
    expect(mockRepo.findById).not.toHaveBeenCalled()
    expect(result).toEqual(event)
  })

  it('should replay event successfully and invalidate cache', async () => {
    const event = {
      id: '123',
      eventType: 'test_event',
      eventData: { foo: 'bar' },
      status: 'failed',
    }
    const updatedEvent = { ...event, status: 'replayed' }
    
    vi.mocked(cache.get).mockResolvedValue(event)
    mockRepo.findById.mockResolvedValue(updatedEvent)

    const result = await replayService.replayEvent('123', 'admin-1', 'admin@example.com', '127.0.0.1')

    expect(result.success).toBe(true)
    expect(mockHandler.handle).toHaveBeenCalledWith(event.eventData)
    expect(mockRepo.updateStatus).toHaveBeenCalledWith('123', 'replayed')
    expect(invalidation.invalidateCache).toHaveBeenCalled()
    expect(auditLogService.logAction).toHaveBeenCalled()
  })

  it('should not replay if already replayed', async () => {
    const event = {
      id: '123',
      eventType: 'test_event',
      eventData: { foo: 'bar' },
      status: 'replayed',
    }
    vi.mocked(cache.get).mockResolvedValue(event)

    const result = await replayService.replayEvent('123', 'admin-1', 'admin@example.com')

    expect(result.success).toBe(false)
    expect(result.message).toBe('Event already replayed')
    expect(mockHandler.handle).not.toHaveBeenCalled()
  })

  it('should throw error if no handler registered', async () => {
    const event = {
      id: '123',
      eventType: 'unknown_event',
      eventData: {},
      status: 'failed',
    }
    vi.mocked(cache.get).mockResolvedValue(event)

    await expect(replayService.replayEvent('123', 'admin-1', 'admin@example.com'))
      .rejects.toThrow('No handler registered for event type: unknown_event')
  })
})
