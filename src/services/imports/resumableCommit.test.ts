import { describe, expect, it, beforeEach } from 'vitest'
import {
  commitImportFile,
  InMemoryImportCheckpointStore,
  type ImportCommitter,
} from './commit.js'

const VALID_ADDRESS = 'G' + 'A'.repeat(55)
const VALID_ADDRESS_2 = 'G' + 'B'.repeat(55)
const VALID_ADDRESS_3 = 'G' + 'C'.repeat(55)

function csvBuffer(...rows: string[]): Buffer {
  return Buffer.from(['address', ...rows].join('\n'), 'utf8')
}

class RecordingCommitter implements ImportCommitter {
  readonly calls: string[] = []
  private failures = new Set<string>()
  private blockers = new Map<string, Promise<void>>()
  private releases = new Map<string, () => void>()
  private callListeners = new Map<string, () => void>()

  failOnce(address: string): void {
    this.failures.add(address)
  }

  block(address: string): () => void {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    this.blockers.set(address, blocked)
    this.releases.set(address, release)
    return () => this.releases.get(address)?.()
  }

  waitForCall(address: string): Promise<void> {
    return new Promise((resolve) => { this.callListeners.set(address, resolve) })
  }

  async upsertRow(address: string): Promise<void> {
    this.calls.push(address)
    this.callListeners.get(address)?.()
    this.callListeners.delete(address)
    await this.blockers.get(address)
    this.blockers.delete(address)
    this.releases.delete(address)
    if (this.failures.delete(address)) throw new Error('database temporarily unavailable')
  }
}

describe('resumable import commits', () => {
  let checkpoints: InMemoryImportCheckpointStore

  beforeEach(() => {
    checkpoints = new InMemoryImportCheckpointStore()
  })

  it('validates the complete file before writing and returns row audit outcomes', async () => {
    const committer = new RecordingCommitter()
    const result = await commitImportFile(
      csvBuffer(VALID_ADDRESS, 'not-a-stellar-address', VALID_ADDRESS_2),
      committer,
      undefined,
      { idempotencyKey: 'validate-before-write', tenantId: 'tenant-a', checkpointStore: checkpoints },
    )

    expect(result.success).toBe(true)
    if (result.success && 'valid' in result) {
      expect(result.valid).toBe(false)
      expect(result.rowOutcomes?.[0]?.status).toBe('rejected')
      expect(result.rowOutcomes?.[0]?.code).toBe('INVALID_ADDRESS')
    }
    expect(committer.calls).toEqual([])
  })

  it('returns stable accepted row keys and an operation correlation id', async () => {
    const committer = new RecordingCommitter()
    const result = await commitImportFile(
      csvBuffer(VALID_ADDRESS, VALID_ADDRESS_2),
      committer,
      undefined,
      { idempotencyKey: 'stable-outcomes', tenantId: 'tenant-a', checkpointStore: checkpoints },
    )

    expect(result.success).toBe(true)
    if (result.success && 'committed' in result) {
      expect(result.committed).toBe(true)
      expect(result.operationId).toMatch(/^import_[0-9a-f-]+$/)
      expect(result.partial).toBe(false)
      expect(result.accepted).toBe(2)
      expect(result.rejected).toBe(0)
      expect(result.retried).toBe(0)
      expect(result.rowOutcomes.map((outcome) => outcome.row)).toEqual([2, 3])
      expect(new Set(result.rowOutcomes.map((outcome) => outcome.rowKey)).size).toBe(2)
      expect(result.rowOutcomes.every((outcome) => outcome.status === 'accepted')).toBe(true)
      expect(result.rowOutcomes.every((outcome) => !outcome.message.includes(VALID_ADDRESS))).toBe(true)
    }
    expect(committer.calls).toEqual([VALID_ADDRESS, VALID_ADDRESS_2])
  })

  it('resumes failed rows without repeating an earlier accepted row', async () => {
    const committer = new RecordingCommitter()
    committer.failOnce(VALID_ADDRESS_2)
    const options = { idempotencyKey: 'resume-after-failure', tenantId: 'tenant-a', checkpointStore: checkpoints }

    const first = await commitImportFile(csvBuffer(VALID_ADDRESS, VALID_ADDRESS_2), committer, undefined, options)
    expect(first.success).toBe(true)
    if (first.success && 'committed' in first) {
      expect(first.committed).toBe(false)
      expect(first.partial).toBe(true)
      expect(first.accepted).toBe(1)
      expect(first.rowOutcomes[1]?.status).toBe('retryable')
    }

    const retry = await commitImportFile(csvBuffer(VALID_ADDRESS, VALID_ADDRESS_2), committer, undefined, options)
    expect(retry.success).toBe(true)
    if (retry.success && 'committed' in retry) {
      expect(retry.committed).toBe(true)
      expect(retry.partial).toBe(false)
      expect(retry.accepted).toBe(2)
      expect(retry.retried).toBe(1)
      expect(retry.rowOutcomes.map((outcome) => outcome.rowKey)).toEqual(
        first.rowOutcomes.map((outcome) => outcome.rowKey),
      )
    }
    expect(committer.calls).toEqual([VALID_ADDRESS, VALID_ADDRESS_2, VALID_ADDRESS_2])
  })

  it('rejects a key reused for different content before any second write', async () => {
    const committer = new RecordingCommitter()
    const options = { idempotencyKey: 'fingerprint-conflict', tenantId: 'tenant-a', checkpointStore: checkpoints }

    const first = await commitImportFile(csvBuffer(VALID_ADDRESS), committer, undefined, options)
    const second = await commitImportFile(csvBuffer(VALID_ADDRESS_3), committer, undefined, options)

    expect(first.success).toBe(true)
    expect(second).toMatchObject({ success: false, status: 409, code: 'IdempotencyConflict' })
    expect(committer.calls).toEqual([VALID_ADDRESS])
  })

  it('scopes the same client key by trusted tenant identity', async () => {
    const committer = new RecordingCommitter()
    const key = { idempotencyKey: 'same-client-key', checkpointStore: checkpoints }

    const tenantA = await commitImportFile(csvBuffer(VALID_ADDRESS), committer, undefined, { ...key, tenantId: 'tenant-a' })
    const tenantB = await commitImportFile(csvBuffer(VALID_ADDRESS_2), committer, undefined, { ...key, tenantId: 'tenant-b' })

    expect(tenantA.success).toBe(true)
    expect(tenantB.success).toBe(true)
    if (tenantA.success && 'operationId' in tenantA && tenantB.success && 'operationId' in tenantB) {
      expect(tenantA.operationId).not.toBe(tenantB.operationId)
    }
    expect(committer.calls).toEqual([VALID_ADDRESS, VALID_ADDRESS_2])
  })

  it('serializes concurrent retries using one operation checkpoint', async () => {
    const committer = new RecordingCommitter()
    const started = committer.waitForCall(VALID_ADDRESS)
    const release = committer.block(VALID_ADDRESS)
    const options = { idempotencyKey: 'concurrent-import', tenantId: 'tenant-a', checkpointStore: checkpoints }
    const firstPromise = commitImportFile(csvBuffer(VALID_ADDRESS), committer, undefined, options)
    await started
    const secondPromise = commitImportFile(csvBuffer(VALID_ADDRESS), committer, undefined, options)

    await new Promise((resolve) => setImmediate(resolve))
    expect(committer.calls).toEqual([VALID_ADDRESS])
    release()

    const [first, second] = await Promise.all([firstPromise, secondPromise])
    expect(first.success).toBe(true)
    expect(second.success).toBe(true)
    if (first.success && 'operationId' in first && second.success && 'operationId' in second) {
      expect(first.operationId).toBe(second.operationId)
    }
    expect(committer.calls).toEqual([VALID_ADDRESS])
  })

  it('preserves prior rows when one persistence attempt fails', async () => {
    const committer = new RecordingCommitter()
    committer.failOnce(VALID_ADDRESS_3)
    const result = await commitImportFile(
      csvBuffer(VALID_ADDRESS, VALID_ADDRESS_3),
      committer,
      undefined,
      { idempotencyKey: 'partial-commit', tenantId: 'tenant-a', checkpointStore: checkpoints },
    )

    expect(result.success).toBe(true)
    if (result.success && 'committed' in result) {
      expect(result.partial).toBe(true)
      expect(result.rowOutcomes.map((outcome) => outcome.status)).toEqual(['accepted', 'retryable'])
    }
    expect(committer.calls).toEqual([VALID_ADDRESS, VALID_ADDRESS_3])
  })

  it('does not expose row payloads in rejected outcomes', async () => {
    const committer = new RecordingCommitter()
    const sensitiveInvalidValue = 'secret-not-an-address'
    const result = await commitImportFile(
      Buffer.from(`address\n${sensitiveInvalidValue}\n`, 'utf8'),
      committer,
      undefined,
      { idempotencyKey: 'redacted-rejection', tenantId: 'tenant-a', checkpointStore: checkpoints },
    )

    expect(result.success).toBe(true)
    if (result.success && 'valid' in result) {
      expect(JSON.stringify(result.rowOutcomes)).not.toContain('secret-not-an-address')
    }
  })
})
