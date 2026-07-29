import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const doc = readFileSync(resolve(root, 'docs/BACKGROUND_JOB_RECOVERY.md'), 'utf8')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

describe('background job recovery documentation', () => {
  it('documents each crash-recovery surface', () => {
    for (const marker of [
      'lease_expires_at',
      'publish_idempotency_key',
      'markFailed()',
      'outbox_quarantine',
      'recoverStuckJobs()',
      'OutboxPublisher.stop()',
      'releaseClaims()',
    ]) {
      expect(doc).toContain(marker)
    }
  })

  it('matches the documented recovery mechanisms to source files', () => {
    const repository = read('src/db/outbox/repository.ts')
    const publisher = read('src/db/outbox/publisher.ts')
    const reportWorker = read('src/jobs/reportWorker.ts')
    const gracefulShutdown = read('src/gracefulShutdown.ts')

    expect(repository).toContain('lease_expires_at')
    expect(repository).toContain('publish_idempotency_key')
    expect(repository).toContain('releaseClaims')
    expect(repository).toContain('markFailed')
    expect(publisher).toContain('renewLease')
    expect(publisher).toContain('quarantineEvent')
    expect(reportWorker).toContain('recoverStuckJobs')
    expect(gracefulShutdown).toContain('outbox_stop')
  })
})
