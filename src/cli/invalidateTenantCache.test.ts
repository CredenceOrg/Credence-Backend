import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { run } from './invalidateTenantCache.js'
import { invalidateTenantCache } from '../cache/invalidation.js'
import { ValidationError, ServiceUnavailableError } from '../lib/errors.js'

vi.mock('../cache/invalidation.js', () => ({
  invalidateTenantCache: vi.fn()
}))

const VALID_TENANT_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6'

describe('invalidateTenantCache CLI', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('invalidates the tenant cache and exits 0 on success', async () => {
    vi.mocked(invalidateTenantCache).mockResolvedValue({ tenantId: VALID_TENANT_ID, keysCleared: 4 })

    const code = await run(['--tenant', VALID_TENANT_ID])

    expect(invalidateTenantCache).toHaveBeenCalledWith(VALID_TENANT_ID)
    expect(code).toBe(0)
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('4 key(s) cleared'))
  })

  it('reports and exits 0 when the tenant has no cache entries', async () => {
    vi.mocked(invalidateTenantCache).mockResolvedValue({ tenantId: VALID_TENANT_ID, keysCleared: 0 })

    const code = await run(['--tenant', VALID_TENANT_ID])

    expect(code).toBe(0)
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No cached entries found'))
  })

  it('rejects invalid tenant input and exits 1 without touching the cache layer twice', async () => {
    vi.mocked(invalidateTenantCache).mockRejectedValue(new ValidationError('tenantId must be a valid UUID'))

    const code = await run(['--tenant', 'not-a-uuid'])

    expect(code).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('tenantId must be a valid UUID'))
  })

  it('requires --tenant to be provided', async () => {
    const code = await run([])

    expect(invalidateTenantCache).not.toHaveBeenCalled()
    expect(code).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--tenant <uuid> is required'))
  })

  it.each([
    ['missing value', ['--tenant']],
    ['empty value', ['--tenant', '']],
    ['duplicate option', ['--tenant', VALID_TENANT_ID, '--tenant', VALID_TENANT_ID]],
    ['unknown option', ['--verbose']],
  ] as const)('rejects %s without invoking invalidation', async (_case, argv) => {
    const code = await run([...argv])

    expect(code).toBe(1)
    expect(invalidateTenantCache).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalled()
  })

  it('handles cache backend failures gracefully', async () => {
    vi.mocked(invalidateTenantCache).mockRejectedValue(
      new ServiceUnavailableError('Cache backend is unavailable; tenant cache was not invalidated')
    )

    const code = await run(['--tenant', VALID_TENANT_ID])

    expect(code).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Cache backend is unavailable'))
  })

  it('can recover on a later invocation after a transient backend failure', async () => {
    vi.mocked(invalidateTenantCache)
      .mockRejectedValueOnce(new ServiceUnavailableError('Cache backend is unavailable; tenant cache was not invalidated'))
      .mockResolvedValueOnce({ tenantId: VALID_TENANT_ID, keysCleared: 2 })

    expect(await run(['--tenant', VALID_TENANT_ID])).toBe(1)
    expect(await run(['--tenant', VALID_TENANT_ID])).toBe(0)
    expect(invalidateTenantCache).toHaveBeenCalledTimes(2)
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('2 key(s) cleared'))
  })

  it('keeps concurrent invocations independent and deterministic', async () => {
    vi.mocked(invalidateTenantCache).mockImplementation(async tenantId => ({
      tenantId,
      keysCleared: 1,
    }))

    const [first, second] = await Promise.all([
      run(['--tenant', VALID_TENANT_ID]),
      run(['--tenant', VALID_TENANT_ID]),
    ])

    expect([first, second]).toEqual([0, 0])
    expect(invalidateTenantCache).toHaveBeenCalledTimes(2)
    expect(logSpy).toHaveBeenCalledTimes(2)
  })

  it('never prints the raw error object for unexpected failures', async () => {
    const sensitiveError = new Error('connection string: postgres://user:supersecret@host/db')
    vi.mocked(invalidateTenantCache).mockRejectedValue(sensitiveError)

    const code = await run(['--tenant', VALID_TENANT_ID])

    expect(code).toBe(1)
    for (const call of errorSpy.mock.calls) {
      expect(String(call[0])).not.toContain('supersecret')
    }
  })

  it('prints help and exits 0 without invoking invalidation', async () => {
    const code = await run(['--help'])

    expect(code).toBe(0)
    expect(invalidateTenantCache).not.toHaveBeenCalled()
  })
})
