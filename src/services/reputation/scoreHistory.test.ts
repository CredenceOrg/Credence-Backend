import { describe, expect, it, vi } from 'vitest'
import {
  createScoreHistorySyncHooks,
  PgScoreHistoryRepository,
  ScoreHistoryService,
  type ScoreProvider,
  type ScoreHistoryRepository,
  type ScoreSnapshot,
} from './scoreHistory.js'
import type { IdentityStateUpdatedEvent } from '../../listeners/types.js'

const VALID_ADDRESS = 'GABC7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ'

describe('ScoreHistoryService', () => {
  it('creates a snapshot from event input', async () => {
    const upsertSnapshot = vi.fn().mockResolvedValue({ created: true })
    const repository: ScoreHistoryRepository = { upsertSnapshot }
    const service = new ScoreHistoryService(repository, { windowMs: 60_000 })

    const result = await service.recordFromEvent({
      identityAddress: VALID_ADDRESS,
      sourceEvent: 'bond',
      occurredAt: new Date('2026-02-25T12:34:56.000Z'),
      score: {
        totalScore: 80,
        bondScore: 50,
        attestationScore: 20,
        timeWeight: 0.8,
      },
    })

    expect(result.created).toBe(true)
    expect(result.snapshot.identityAddress).toBe(VALID_ADDRESS)
    expect(result.snapshot.sourceEvent).toBe('bond')
    expect(result.snapshot.windowStart.toISOString()).toBe('2026-02-25T12:34:00.000Z')
    expect(result.snapshot.windowEnd.toISOString()).toBe('2026-02-25T12:35:00.000Z')
  })

  it('returns created=false for idempotent conflict case', async () => {
    const upsertSnapshot = vi.fn().mockResolvedValue({ created: false })
    const repository: ScoreHistoryRepository = { upsertSnapshot }
    const service = new ScoreHistoryService(repository, { windowMs: 60_000 })

    const result = await service.recordFromEvent({
      identityAddress: VALID_ADDRESS,
      sourceEvent: 'attestation',
      occurredAt: new Date('2026-02-25T12:34:10.000Z'),
      score: {
        totalScore: 55,
        bondScore: 30,
        attestationScore: 25,
        timeWeight: 1,
      },
    })

    expect(result.created).toBe(false)
  })

  it('creates different snapshots for different windows', async () => {
    const snapshots: ScoreSnapshot[] = []
    const repository: ScoreHistoryRepository = {
      upsertSnapshot: async (snapshot) => {
        snapshots.push(snapshot)
        return { created: true }
      },
    }
    const service = new ScoreHistoryService(repository, { windowMs: 60_000 })

    await service.recordFromEvent({
      identityAddress: VALID_ADDRESS,
      sourceEvent: 'slash',
      occurredAt: new Date('2026-02-25T12:34:59.000Z'),
      score: {
        totalScore: 20,
        bondScore: 0,
        attestationScore: 20,
        timeWeight: 1,
      },
    })
    await service.recordFromEvent({
      identityAddress: VALID_ADDRESS,
      sourceEvent: 'slash',
      occurredAt: new Date('2026-02-25T12:35:01.000Z'),
      score: {
        totalScore: 19,
        bondScore: 0,
        attestationScore: 19,
        timeWeight: 1,
      },
    })

    expect(snapshots).toHaveLength(2)
    expect(snapshots[0].windowStart.toISOString()).toBe('2026-02-25T12:34:00.000Z')
    expect(snapshots[1].windowStart.toISOString()).toBe('2026-02-25T12:35:00.000Z')
  })

  it('throws on invalid address', async () => {
    const repository: ScoreHistoryRepository = {
      upsertSnapshot: vi.fn(),
    }
    const service = new ScoreHistoryService(repository, { windowMs: 60_000 })

    await expect(
      service.recordFromEvent({
        identityAddress: 'INVALID',
        sourceEvent: 'bond',
        score: {
          totalScore: 1,
          bondScore: 1,
          attestationScore: 0,
          timeWeight: 1,
        },
      })
    ).rejects.toThrow('invalid Stellar identity address')
  })

  it('propagates repository errors', async () => {
    const repository: ScoreHistoryRepository = {
      upsertSnapshot: vi.fn().mockRejectedValue(new Error('db unavailable')),
    }
    const service = new ScoreHistoryService(repository, { windowMs: 60_000 })

    await expect(
      service.recordFromEvent({
        identityAddress: VALID_ADDRESS,
        sourceEvent: 'bond',
        score: {
          totalScore: 1,
          bondScore: 1,
          attestationScore: 0,
          timeWeight: 1,
        },
      })
    ).rejects.toThrow('db unavailable')
  })
})

describe('PgScoreHistoryRepository', () => {
  it('returns created=true when row is inserted', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 })
    const repository = new PgScoreHistoryRepository({
      client: { query },
    })
    const result = await repository.upsertSnapshot({
      identityAddress: VALID_ADDRESS,
      windowStart: new Date('2026-02-25T12:34:00.000Z'),
      windowEnd: new Date('2026-02-25T12:35:00.000Z'),
      score: 80,
      bondScore: 50,
      attestationScore: 20,
      timeWeight: 0.8,
      sourceEvent: 'bond',
      capturedAt: new Date('2026-02-25T12:34:56.000Z'),
    })

    expect(result).toEqual({ created: true })
    expect(query).toHaveBeenCalledOnce()
  })

  it('returns created=false when insert is skipped by conflict', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0 })
    const repository = new PgScoreHistoryRepository({
      client: { query },
    })
    const result = await repository.upsertSnapshot({
      identityAddress: VALID_ADDRESS,
      windowStart: new Date('2026-02-25T12:34:00.000Z'),
      windowEnd: new Date('2026-02-25T12:35:00.000Z'),
      score: 80,
      bondScore: 50,
      attestationScore: 20,
      timeWeight: 0.8,
      sourceEvent: 'bond',
      capturedAt: new Date('2026-02-25T12:34:56.000Z'),
    })

    expect(result).toEqual({ created: false })
  })
})

describe('createScoreHistorySyncHooks', () => {
  it('records snapshot from onStateUpdated event', async () => {
    const repository: ScoreHistoryRepository = {
      upsertSnapshot: vi.fn().mockResolvedValue({ created: true }),
    }
    const historyService = new ScoreHistoryService(repository, { windowMs: 60_000 })
    const scoreProvider: ScoreProvider = {
      getScoreForIdentity: vi.fn().mockResolvedValue({
        totalScore: 70,
        bondScore: 40,
        attestationScore: 20,
        timeWeight: 0.7,
      }),
    }
    const hooks = createScoreHistorySyncHooks(historyService, scoreProvider)

    const event: IdentityStateUpdatedEvent = {
      address: VALID_ADDRESS,
      previousState: null,
      chainState: {
        address: VALID_ADDRESS,
        bondedAmount: '1000',
        bondStart: 1,
        bondDuration: 2,
        active: true,
      },
      eventType: 'attestation',
      updatedAt: new Date('2026-02-25T12:34:00.000Z'),
    }
    await hooks.onStateUpdated?.(event)

    expect(scoreProvider.getScoreForIdentity).toHaveBeenCalledWith(
      VALID_ADDRESS,
      event.chainState
    )
    expect(repository.upsertSnapshot).toHaveBeenCalledOnce()
  })
})
