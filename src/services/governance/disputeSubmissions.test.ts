import { describe, expect, it, vi } from 'vitest'
import {
  ConsoleArbitrationEventPublisher,
  DisputeSubmissionError,
  DisputeSubmissionService,
  type ArbitrationEventPublisher,
  type DisputeSubmissionRepository,
  type DisputeSubmissionRepositoryTx,
} from './disputeSubmissions.js'

const ALICE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2'
const SLASH_REQUEST_ID = 'slash-001'

function makeRepository(overrides: Partial<DisputeSubmissionRepositoryTx> = {}): DisputeSubmissionRepository {
  const tx: DisputeSubmissionRepositoryTx = {
    getSlashRequestForUpdate: async () => ({
      id: SLASH_REQUEST_ID,
      identity: ALICE,
      status: 'open',
      disputableUntil: new Date(Date.now() + 60_000),
    }),
    insertDispute: async (input) => ({
      id: input.id,
      slashRequestId: input.slashRequestId,
      identity: input.identity,
      evidence: input.evidence,
      stake: input.stake,
      status: 'submitted',
      submittedAt: input.submittedAt,
    }),
    markSlashRequestDisputed: async () => {},
    ...overrides,
  }

  return {
    withTransaction: async (fn) => fn(tx),
  }
}

describe('DisputeSubmissionService', () => {
  it('submits dispute and emits event', async () => {
    const repository = makeRepository()
    const publisher: ArbitrationEventPublisher = {
      publishDisputeSubmitted: vi.fn().mockResolvedValue(undefined),
    }
    const service = new DisputeSubmissionService(repository, publisher)

    const dispute = await service.submit({
      slashRequestId: SLASH_REQUEST_ID,
      identity: ALICE,
      evidence: ['tx:abc123'],
      stake: '100.25',
    })

    expect(dispute.slashRequestId).toBe(SLASH_REQUEST_ID)
    expect(dispute.identity).toBe(ALICE)
    expect(dispute.evidence).toEqual(['tx:abc123'])
    expect(publisher.publishDisputeSubmitted).toHaveBeenCalledOnce()
  })

  it('throws validation error for invalid payload', async () => {
    const service = new DisputeSubmissionService(
      makeRepository(),
      new ConsoleArbitrationEventPublisher()
    )

    await expect(
      service.submit({
        slashRequestId: '',
        identity: 'invalid',
        evidence: [],
      })
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    })
  })

  it('throws when slash request does not exist', async () => {
    const service = new DisputeSubmissionService(
      makeRepository({
        getSlashRequestForUpdate: async () => null,
      }),
      new ConsoleArbitrationEventPublisher()
    )

    await expect(
      service.submit({
        slashRequestId: SLASH_REQUEST_ID,
        identity: ALICE,
        evidence: ['tx:abc123'],
      })
    ).rejects.toMatchObject({
      code: 'SLASH_REQUEST_NOT_FOUND',
    })
  })

  it('throws when slash request is not disputable', async () => {
    const service = new DisputeSubmissionService(
      makeRepository({
        getSlashRequestForUpdate: async () => ({
          id: SLASH_REQUEST_ID,
          identity: ALICE,
          status: 'resolved',
          disputableUntil: new Date(Date.now() + 60_000),
        }),
      }),
      new ConsoleArbitrationEventPublisher()
    )

    await expect(
      service.submit({
        slashRequestId: SLASH_REQUEST_ID,
        identity: ALICE,
        evidence: ['tx:abc123'],
      })
    ).rejects.toMatchObject({
      code: 'NOT_DISPUTABLE',
    })
  })

  it('throws when deadline has passed', async () => {
    const service = new DisputeSubmissionService(
      makeRepository({
        getSlashRequestForUpdate: async () => ({
          id: SLASH_REQUEST_ID,
          identity: ALICE,
          status: 'open',
          disputableUntil: new Date(Date.now() - 60_000),
        }),
      }),
      new ConsoleArbitrationEventPublisher()
    )

    await expect(
      service.submit({
        slashRequestId: SLASH_REQUEST_ID,
        identity: ALICE,
        evidence: ['tx:abc123'],
      })
    ).rejects.toMatchObject({
      code: 'DEADLINE_PASSED',
    })
  })

  it('throws when duplicate dispute already exists', async () => {
    const service = new DisputeSubmissionService(
      makeRepository({
        insertDispute: async () => null,
      }),
      new ConsoleArbitrationEventPublisher()
    )

    await expect(
      service.submit({
        slashRequestId: SLASH_REQUEST_ID,
        identity: ALICE,
        evidence: ['tx:abc123'],
      })
    ).rejects.toMatchObject({
      code: 'ALREADY_DISPUTED',
    })
  })

  it('throws when identity does not match slash request', async () => {
    const service = new DisputeSubmissionService(
      makeRepository({
        getSlashRequestForUpdate: async () => ({
          id: SLASH_REQUEST_ID,
          identity: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB3',
          status: 'open',
          disputableUntil: new Date(Date.now() + 60_000),
        }),
      }),
      new ConsoleArbitrationEventPublisher()
    )

    await expect(
      service.submit({
        slashRequestId: SLASH_REQUEST_ID,
        identity: ALICE,
        evidence: ['tx:abc123'],
      })
    ).rejects.toMatchObject({
      code: 'IDENTITY_MISMATCH',
    })
  })

  it('throws EVENT_PUBLISH_FAILED when publisher fails', async () => {
    const service = new DisputeSubmissionService(makeRepository(), {
      publishDisputeSubmitted: async () => {
        throw new Error('publisher down')
      },
    })

    await expect(
      service.submit({
        slashRequestId: SLASH_REQUEST_ID,
        identity: ALICE,
        evidence: ['tx:abc123'],
      })
    ).rejects.toSatisfy((error) => {
      return error instanceof DisputeSubmissionError && error.code === 'EVENT_PUBLISH_FAILED'
    })
  })
})
