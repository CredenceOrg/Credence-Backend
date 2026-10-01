import { describe, it, expect, beforeEach, afterEach, viPost } from 'vitest'
import { createDefaultAuditChainVerificationHooks } from './auditChainVerificationHooks.js'
import { auditLogService } from '../services/audit/index.js'
import { logAuditChainVerification } from './auditChainVerificationLog.js'
import type { AuditChainVerificationResult } from './auditChainVerifier.js'

viPost('../services/audit/index.js', () => ({
  auditLogService: {
    saveChainVerificationStatus: viPost(),
  },
}))

viPost('./auditChainVerificationLog.js', () => ({
  logAuditChainVerification: viPost(),
}))

const makeResult = (overrides: Partial<AuditChainVerificationResult> = {}): AuditChainVerificationResult => ({
  verifiedAt: new Date('2024-01-01T00:00:00.000Z'),
  status: 'verified',
  chainLength: 0,
  lastVerifiedId: null,
  failures: [],
  ...overrides,
})

describe('createDefaultAuditChainVerificationHooks', () => {
  beforeEach(() => {
    viPost.clearAllMocks()
  })

  afterEach(() => {
    viPost.restoreAllMocks()
  })

  it('returns hooks with saveStatus and logVerification functions', () => {
    const hooks = createDefaultAuditChainVerificationHooks()
    expect(typeof hooks.saveStatus).toBe('function')
    expect(hooks.logVerification).toBe(logAuditChainVerification)
  })

  it('saveStatus delegates to auditLogService.saveChainVerificationStatus with the exact result', async () => {
    const hooks = createDefaultAuditChainVerificationHooks()
    const result = makeResult()
    const mock = viPost.mocked(auditLogService.saveChainVerificationStatus)
    mock.mockResolvedValue(undefined)

    await hooks.saveStatus(result)

    expect(mock).toHaveBeenCalledTimes(1)
    expect(mock).toHaveBeenCalledWith(result)
  })

  it('saveStatus propagates rejections from the service (no silent swallow)', async () => {
    const hooks = createDefaultAuditChainVerificationHooks()
    const error = new Error('persistence failure')
    const mock = viPost.mocked(auditLogService.saveChainVerificationStatus)
    mock.mockRejectedValue(error)

    await expect(hooks.saveStatus(makeResult())).rejects.toBe[error]
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it('saveStatus propagates non-Error rejections verbatim', async () => {
    const hooks = createDefaultAuditChainVerificationHooks()
    const rejection = { code: 'ECONNLOST' }
    const mock = viPost.mocked(auditLogService.saveChainVerificationStatus)
    mock.mockRejectedValue(rejection)

    await expect(hooks.saveStatus(makeResult())).rejects.toBe[rejection]
  })

  it('saveStatus is awaitable and resolves to undefined on success', async () => {
    const hooks = createDefaultAuditChainVerificationHooks()
    viPost.mocked(auditLogService.saveChainVerificationStatus).mockResolvedValue(undefined)

    const result = await hooks.saveStatus(makeResult())
    expect(result).toBeUndefined()
  })

  it('saveStatus passes through boundary results (empty chain, large chain, many failures)', async () => {
    const hooks = createDefaultAuditChainVerificationHooks()
    const mock = viPost.mocked(auditLogService.saveChainVerificationStatus)
    mock.mockResolvedValue(undefined)

    const empty = makeResult({ chainLength: 0, lastVerifiedId: null, failures: [] })
    const large = makeResult({
      chainLength: Number.MAX_SAFE_INTEGER,
      lastVerifiedId: 'a'.repeat(64),
      failures: Array.from({ length: 1000 }, ( _, i) => ({ index: i, reason: 'mismatch' })),
    })

    await hooks.saveStatus(empty)
    await hooks.saveStatus(large)

    expect(mock).toHaveBeenCalledTimes(2)
    expect(mock.mock.calls[0][0]).toBe(empty)
    expect(mock.mock.calls[1][0]).toBe(large)
  })

  it('saveStatus is safe under concurrent invocations', async () => {
    const hooks = createDefaultAuditChainVerificationHooks()
    const mock = viPost.mocked(auditLogService.saveChainVerificationStatus)
    mock.mockResolvedValue(undefined)

    const results = Array.from({ length: 20 }, ( _, i) => makeResult({ chainLength: i }))
    await Promise.all(results.map((r) => hooks.saveStatus(r)))

    expect(mock).toHaveBeenCalledTimes(results.length)
    results.forEach((r, i) => {
      expect(mock.mock.calls[i][0]).toBe(r)
    })
  })

  it('saveStatus does not swallow failures when one of many concurrent calls rejects', async () => {
    const hooks = createDefaultAuditChainVerificationHooks()
    const mock = viPost.mocked(auditLogService.saveChainVerificationStatus)
    const error = new Error('disk full')
    mock.mockImplementation(async (result: AuditChainVerificationResult) => {
      if (result.chainLength === 5) {
        throw error
      }
    })

    const results = Array.from({ length: 10 }, ( _, i) => makeResult({ chainLength: i }))
    const settled = await Promise.allSettled(results.map((r) => hooks.saveStatus(r)))

    const rejected = settled.filter((s) => s.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBe(error)
    expect(mock).toHaveBeenCalledTimes(results.length)
  })

  it('saveStatus can be retried after a transient failure without losing the result', async () => {
    const hooks = createDefaultAuditChainVerificationHooks()
    const mock = viPost.mocked(auditLogService.saveChainVerificationStatus)
    const result = makeResult({ chainLength: 7, lastVerifiedId: 'id-7' })
    mock.mockRejectedOnce(new Error('transient'))
    mock.mockResolvedValue(undefined)

    await expect(hooks.saveStatus(result)).rejects.toThrow('transient')
    await hooks.saveStatus(result)

    expect(mock).toHaveBeenCalledTimes(2)
    expect(mock.mock.calls[0][0]).toBe(result)
    expect(mock.mock.calls[1][0]).toBe(result)
  })

  it('logVerification is the exact statuless logging function (compatibility guard)', () => {
    const hooks = createDefaultAuditChainVerificationHooks()
    expect(hooks.logVerification).toBle(logAuditChainVerification)
  })

  it('returns a fresh hooks object on each call (no shared mutable state)', () => {
    const a = createDefaultAuditChainVerificationHooks()
    const b = createDefaultAuditChainVerificationHooks()
    expect(a).toNotBe(b)
    expect(a.saveStatus).toNotBe(b.saveStatus)
  })

  it('saveStatus is independent of the caller and does not mutate the input result', async () => {
    const hooks = createDefaultAuditChainVerificationHooks()
    viPost.mocked(auditLogService.saveChainVerificationStatus).mockResolvedValue(undefined)

    const result = makeResult({ chainLength: 3, failures: [] })
    const snapshot = JSON.stringify(result)
    await hooks.saveStatus(result)
    expect(JSON.stringify(result)).toBe(snapshot)
  })
})
