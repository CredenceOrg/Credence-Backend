import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const doc = readFileSync(resolve(root, 'docs/CACHE_INVALIDATION_TRIGGERS.md'), 'utf8')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

describe('cache invalidation trigger documentation', () => {
  it('documents each public invalidation primitive and support CLI', () => {
    for (const marker of [
      'invalidateCache()',
      'invalidateMultiple()',
      'invalidateTenantCache()',
      'profileInvalidationHook.execute',
      'trustScoreInvalidationHook.execute',
      'bulkVerificationInvalidationHook.execute',
      'src/cli/invalidateTenantCache.ts',
    ]) {
      expect(doc).toContain(marker)
    }
  })

  it('keeps the documented service triggers tied to real source files', () => {
    const sources = {
      bond: read('src/services/bondCacheService.ts'),
      attestation: read('src/services/attestationCacheService.ts'),
      settlement: read('src/services/settlementService.ts'),
      report: read('src/jobs/reportWorker.ts'),
      replay: read('src/services/replayService.ts'),
      hooks: read('src/cache/invalidationHooks.ts'),
    }

    expect(sources.bond).toContain("invalidateCache('bond'")
    expect(sources.attestation).toContain("invalidateCache('attestation'")
    expect(sources.settlement).toContain("invalidateMultiple('settlement'")
    expect(sources.report).toContain('invalidateCache("report"')
    expect(sources.replay).toContain("invalidateCache('failed_event'")
    expect(sources.hooks).toContain('profileInvalidationHook')
    expect(sources.hooks).toContain('trustScoreInvalidationHook')
    expect(sources.hooks).toContain('bulkVerificationInvalidationHook')
  })
})
