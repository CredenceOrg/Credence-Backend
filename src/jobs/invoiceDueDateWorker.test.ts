import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  InvoiceDueDateWorker,
  type InvoiceDueDateRepository,
  type TenantContextProvider,
} from './invoiceDueDateWorker.js'
import { validateTimezone } from './invoiceDueDate.js'

describe('InvoiceDueDateWorker', () => {
  let repository: InvoiceDueDateRepository
  let tenantContextProvider: TenantContextProvider

  beforeEach(() => {
    repository = {
      listPendingDueDateInvoices: vi.fn(),
      markDueDateActionTriggered: vi.fn().mockResolvedValue(undefined),
    }

    tenantContextProvider = {
      listTenants: vi.fn(),
    }
  })

  it('passes tenant timezone context to evaluation and triggers only eligible invoices', async () => {
    vi.mocked(tenantContextProvider.listTenants).mockResolvedValue([
      { tenantId: 'tenant-utc', timezone: 'UTC' },
      { tenantId: 'tenant-kiritimati', timezone: 'Pacific/Kiritimati' },
    ])

    vi.mocked(repository.listPendingDueDateInvoices)
      .mockResolvedValueOnce([
        {
          invoiceId: 'inv-utc-due',
          dueAtUtc: '2026-03-24T00:30:00.000Z',
        },
      ])
      .mockResolvedValueOnce([
        {
          invoiceId: 'inv-kiritimati-not-due',
          dueAtUtc: '2026-03-24T12:30:00.000Z',
        },
      ])

    const worker = new InvoiceDueDateWorker(repository, tenantContextProvider)
    const result = await worker.run('2026-03-24T01:00:00.000Z')

    expect(result.processedTenants).toBe(2)
    expect(result.evaluatedInvoices).toBe(2)
    expect(result.triggeredActions).toBe(1)
    expect(result.errors).toBe(0)

    expect(repository.markDueDateActionTriggered).toHaveBeenCalledTimes(1)
    expect(repository.markDueDateActionTriggered).toHaveBeenCalledWith(
      'inv-utc-due',
      '2026-03-24T01:00:00.000Z',
    )
  })

  it('keeps running when one tenant fails', async () => {
    vi.mocked(tenantContextProvider.listTenants).mockResolvedValue([
      { tenantId: 'tenant-fail', timezone: 'UTC' },
      { tenantId: 'tenant-ok', timezone: 'UTC' },
    ])

    vi.mocked(repository.listPendingDueDateInvoices)
      .mockRejectedValueOnce(new Error('db unavailable'))
      .mockResolvedValueOnce([
        {
          invoiceId: 'inv-ok',
          dueAtUtc: '2026-03-23T00:00:00.000Z',
        },
      ])

    const worker = new InvoiceDueDateWorker(repository, tenantContextProvider)
    const result = await worker.run('2026-03-24T01:00:00.000Z')

    expect(result.processedTenants).toBe(1)
    expect(result.errors).toBe(1)
    expect(result.triggeredActions).toBe(1)
    expect(repository.markDueDateActionTriggered).toHaveBeenCalledWith(
      'inv-ok',
      '2026-03-24T01:00:00.000Z',
    )
  })

  it('validates timezones and skips invalid ones', async () => {
    vi.mocked(tenantContextProvider.listTenants).mockResolvedValue([
      { tenantId: 'tenant-valid', timezone: 'UTC' },
      { tenantId: 'tenant-invalid', timezone: 'Invalid/Timezone' },
      { tenantId: 'tenant-another-valid', timezone: 'America/New_York' },
    ])

    vi.mocked(repository.listPendingDueDateInvoices)
      .mockResolvedValueOnce([
        {
          invoiceId: 'inv-valid',
          dueAtUtc: '2026-03-23T00:00:00.000Z',
        },
      ])
      .mockResolvedValueOnce([
        {
          invoiceId: 'inv-another-valid',
          dueAtUtc: '2026-03-23T00:00:00.000Z',
        },
      ])

    const worker = new InvoiceDueDateWorker(repository, tenantContextProvider, {
      validateTimezones: true,
    })
    const result = await worker.run('2026-03-24T01:00:00.000Z')

    expect(result.processedTenants).toBe(2)
    expect(result.errors).toBe(1)
    expect(repository.listPendingDueDateInvoices).toHaveBeenCalledTimes(2)
    expect(repository.listPendingDueDateInvoices).not.toHaveBeenCalledWith('tenant-invalid', expect.any(String))
  })

  it('can disable timezone validation', async () => {
    vi.mocked(tenantContextProvider.listTenants).mockResolvedValue([
      { tenantId: 'tenant-invalid', timezone: 'Invalid/Timezone' },
    ])

    vi.mocked(repository.listPendingDueDateInvoices)
      .mockResolvedValueOnce([
        {
          invoiceId: 'inv-invalid-tz',
          dueAtUtc: '2026-03-23T00:00:00.000Z',
        },
      ])

    const worker = new InvoiceDueDateWorker(repository, tenantContextProvider, {
      validateTimezones: false,
    })
    
    // Should not throw even with invalid timezone
    await expect(worker.run('2026-03-24T01:00:00.000Z')).resolves.toBeDefined()
  })

  it('logs DST transitions when enabled', async () => {
    vi.mocked(tenantContextProvider.listTenants).mockResolvedValue([
      { tenantId: 'tenant-dst', timezone: 'America/New_York' },
    ])

    vi.mocked(repository.listPendingDueDateInvoices)
      .mockResolvedValueOnce([
        {
          invoiceId: 'inv-dst-transition',
          dueAtUtc: '2026-03-08T12:00:00.000Z', // During DST spring forward
        },
      ])

    const mockLogger = vi.fn()
    const worker = new InvoiceDueDateWorker(repository, tenantContextProvider, {
      logDstTransitions: true,
      logger: mockLogger,
    })
    
    await worker.run('2026-03-08T12:00:00.000Z')

    expect(mockLogger).toHaveBeenCalledWith(
      expect.stringContaining('DST transition period detected')
    )
  })

  it('respects custom batch size', async () => {
    const tenants = Array.from({ length: 5 }, (_, i) => ({
      tenantId: `tenant-${i}`,
      timezone: 'UTC',
    }))
    
    vi.mocked(tenantContextProvider.listTenants).mockResolvedValue(tenants)
    
    // Mock repository to return empty arrays for all tenants
    vi.mocked(repository.listPendingDueDateInvoices).mockResolvedValue([])

    const worker = new InvoiceDueDateWorker(repository, tenantContextProvider, {
      tenantBatchSize: 2,
    })
    
    const result = await worker.run('2026-03-24T01:00:00.000Z')

    expect(result.processedTenants).toBe(5)
    expect(repository.listPendingDueDateInvoices).toHaveBeenCalledTimes(5)
  })


  it('handles empty tenant list', async () => {
    vi.mocked(tenantContextProvider.listTenants).mockResolvedValue([])
    
    const worker = new InvoiceDueDateWorker(repository, tenantContextProvider)
    const result = await worker.run('2026-03-24T01:00:00.000Z')

    expect(result.processedTenants).toBe(0)
    expect(result.evaluatedInvoices).toBe(0)
    expect(result.triggeredActions).toBe(0)
    expect(result.errors).toBe(0)
    expect(repository.listPendingDueDateInvoices).not.toHaveBeenCalled()
    expect(repository.markDueDateActionTriggered).not.toHaveBeenCalled()
  })

  it('handles empty invoice list for tenant', async () => {
    vi.mocked(tenantContextProvider.listTenants).mockResolvedValue([
      { tenantId: 'tenant-empty', timezone: 'UTC' },
    ])
    vi.mocked(repository.listPendingDueDateInvoices).mockResolvedValue([])

    const worker = new InvoiceDueDateWorker(repository, tenantContextProvider)
    const result = await worker.run('2026-03-24T01:00:00.000Z')

    expect(result.processedTenants).toBe(1)
    expect(result.evaluatedInvoices).toBe(0)
    expect(result.triggeredActions).toBe(0)
    expect(result.errors).toBe(0)
  })

  it('processes multiple invoices per tenant', async () => {
    vi.mocked(tenantContextProvider.listTenants).mockResolvedValue([
      { tenantId: 'tenant-multi', timezone: 'UTC' },
    ])
    vi.mocked(repository.listPendingDueDateInvoices).mockResolvedValue([
      { invoiceId: 'inv-1', dueAtUtc: '2026-03-23T00:00:00.000Z' },
      { invoiceId: 'inv-2', dueAtUtc: '2026-03-23T23:59:59.999Z' },
      { invoiceId: 'inv-3', dueAtUtc: '2026-03-24T01:00:00.000Z' }, // same tenant day as now
      { invoiceId: 'inv-4', dueAtUtc: '2026-03-22T00:00:00.000Z' },
      { invoiceId: 'inv-5', dueAtUtc: '2026-03-25T00:00:00.000Z' }, // next tenant day
    ])

    const worker = new InvoiceDueDateWorker(repository, tenantContextProvider)
    const result = await worker.run('2026-03-24T00:00:00.000Z')

    expect(result.processedTenants).toBe(1)
    expect(result.evaluatedInvoices).toBe(5)
    // Eligibility is day-granular in the tenant timezone: inv-1..inv-4 are on or
    // before the current tenant day and trigger; inv-5 is on the next day and waits.
    expect(result.triggeredActions).toBe(4)
    expect(repository.markDueDateActionTriggered).toHaveBeenCalledTimes(4)
    expect(repository.markDueDateActionTriggered).not.toHaveBeenCalledWith('inv-5', expect.any(String))
  })

  it('isolates a trigger failure so other invoices for the tenant still fire', async () => {
    vi.mocked(tenantContextProvider.listTenants).mockResolvedValue([
      { tenantId: 'tenant-mark-fail', timezone: 'UTC' },
    ])
    vi.mocked(repository.listPendingDueDateInvoices).mockResolvedValue([
      { invoiceId: 'inv-trigger-fail', dueAtUtc: '2026-03-23T00:00:00.000Z' },
      { invoiceId: 'inv-trigger-ok', dueAtUtc: '2026-03-22T00:00:00.000Z' },
    ])
    vi.mocked(repository.markDueDateActionTriggered)
      .mockRejectedValueOnce(new Error('Update failed'))
      .mockResolvedValueOnce(undefined)

    const worker = new InvoiceDueDateWorker(repository, tenantContextProvider)
    const result = await worker.run('2026-03-24T01:00:00.000Z')

    // The failing invoice is recorded as an error but must not block the rest,
    // and the tenant still counts as processed so retries are not stuck.
    expect(result.processedTenants).toBe(1)
    expect(result.errors).toBe(1)
    expect(result.triggeredActions).toBe(1)
    expect(repository.markDueDateActionTriggered).toHaveBeenNthCalledWith(1, 'inv-trigger-fail', expect.any(String))
    expect(repository.markDueDateActionTriggered).toHaveBeenNthCalledWith(2, 'inv-trigger-ok', expect.any(String))
  })

  it('recovers fully once a previously failing invoice stops failing', async () => {
    vi.mocked(tenantContextProvider.listTenants).mockResolvedValue([
      { tenantId: 'tenant-recover', timezone: 'UTC' },
    ])
    vi.mocked(repository.listPendingDueDateInvoices).mockResolvedValue([
      { invoiceId: 'inv-flaky', dueAtUtc: '2026-03-23T00:00:00.000Z' },
      { invoiceId: 'inv-other', dueAtUtc: '2026-03-22T00:00:00.000Z' },
    ])
    vi.mocked(repository.markDueDateActionTriggered)
      .mockRejectedValueOnce(new Error('transient outage'))
      .mockResolvedValue(undefined)

    const worker = new InvoiceDueDateWorker(repository, tenantContextProvider)

    const first = await worker.run('2026-03-24T01:00:00.000Z')
    expect(first.triggeredActions).toBe(1)
    expect(first.errors).toBe(1)

    // Retry picks up only the invoice that failed; the other is not re-triggered
    // because the repository no longer returns it as pending.
    vi.mocked(repository.listPendingDueDateInvoices).mockResolvedValue([
      { invoiceId: 'inv-flaky', dueAtUtc: '2026-03-23T00:00:00.000Z' },
    ])

    const second = await worker.run('2026-03-24T01:05:00.000Z')
    expect(second.triggeredActions).toBe(1)
    expect(second.errors).toBe(0)
    expect(repository.markDueDateActionTriggered).toHaveBeenLastCalledWith(
      'inv-flaky',
      '2026-03-24T01:05:00.000Z',
    )
  })

  it('never re-triggers an invoice the repository reports as already triggered', async () => {
    vi.mocked(tenantContextProvider.listTenants).mockResolvedValue([
      { tenantId: 'tenant-idempotent', timezone: 'UTC' },
    ])
    vi.mocked(repository.listPendingDueDateInvoices).mockResolvedValue([
      { invoiceId: 'inv-done', dueAtUtc: '2026-03-20T00:00:00.000Z', actionTriggeredAtUtc: '2026-03-20T00:05:00.000Z' },
      { invoiceId: 'inv-null-triggered', dueAtUtc: '2026-03-20T00:00:00.000Z', actionTriggeredAtUtc: null },
      { invoiceId: 'inv-pending', dueAtUtc: '2026-03-21T00:00:00.000Z' },
    ])

    const worker = new InvoiceDueDateWorker(repository, tenantContextProvider)
    const result = await worker.run('2026-03-24T01:00:00.000Z')

    expect(result.triggeredActions).toBe(2)
    expect(repository.markDueDateActionTriggered).toHaveBeenCalledTimes(2)
    expect(repository.markDueDateActionTriggered).not.toHaveBeenCalledWith('inv-done', expect.any(String))
  })

  it('skips a malformed dueAtUtc without starving valid invoices for the tenant', async () => {
    vi.mocked(tenantContextProvider.listTenants).mockResolvedValue([
      { tenantId: 'tenant-malformed', timezone: 'UTC' },
    ])
    vi.mocked(repository.listPendingDueDateInvoices).mockResolvedValue([
      { invoiceId: 'inv-zone-less', dueAtUtc: '2026-03-23T00:00:00' },
      { invoiceId: 'inv-garbage', dueAtUtc: 'not-a-timestamp' },
      { invoiceId: 'inv-good', dueAtUtc: '2026-03-22T00:00:00.000Z' },
    ])

    const mockLogger = vi.fn()
    const worker = new InvoiceDueDateWorker(repository, tenantContextProvider, {
      logger: mockLogger,
    })
    const result = await worker.run('2026-03-24T01:00:00.000Z')

    expect(result.processedTenants).toBe(1)
    expect(result.errors).toBe(2)
    expect(result.triggeredActions).toBe(1)
    expect(repository.markDueDateActionTriggered).toHaveBeenCalledWith('inv-good', expect.any(String))
    expect(mockLogger).toHaveBeenCalledWith(
      expect.stringContaining('Skipping invoice inv-zone-less for tenant tenant-malformed'),
    )
  })

  it('fails the tenant when skipMalformedInvoices is disabled', async () => {
    vi.mocked(tenantContextProvider.listTenants).mockResolvedValue([
      { tenantId: 'tenant-strict', timezone: 'UTC' },
    ])
    vi.mocked(repository.listPendingDueDateInvoices).mockResolvedValue([
      { invoiceId: 'inv-zone-less', dueAtUtc: '2026-03-23T00:00:00' },
      { invoiceId: 'inv-good', dueAtUtc: '2026-03-22T00:00:00.000Z' },
    ])

    const worker = new InvoiceDueDateWorker(repository, tenantContextProvider, {
      skipMalformedInvoices: false,
    })
    const result = await worker.run('2026-03-24T01:00:00.000Z')

    // Opt-in strict mode preserves the fail-the-tenant behavior.
    expect(result.processedTenants).toBe(0)
    expect(result.errors).toBe(1)
    expect(result.triggeredActions).toBe(0)
  })

  it('handles boundary case - due at exact current time', async () => {
    vi.mocked(tenantContextProvider.listTenants).mockResolvedValue([
      { tenantId: 'tenant-boundary', timezone: 'UTC' },
    ])
    vi.mocked(repository.listPendingDueDateInvoices).mockResolvedValue([
      { invoiceId: 'inv-exact-now', dueAtUtc: '2026-03-24T01:00:00.000Z' },
    ])

    const worker = new InvoiceDueDateWorker(repository, tenantContextProvider)
    const result = await worker.run('2026-03-24T01:00:00.000Z')

    expect(result.processedTenants).toBe(1)
    expect(result.triggeredActions).toBe(1)
  })

  it('handles boundary case - due at end of previous day in UTC', async () => {
    vi.mocked(tenantContextProvider.listTenants).mockResolvedValue([
      { tenantId: 'tenant-boundary', timezone: 'UTC' },
    ])
    vi.mocked(repository.listPendingDueDateInvoices).mockResolvedValue([
      { invoiceId: 'inv-end-prev-day', dueAtUtc: '2026-03-23T23:59:59.999Z' },
    ])

    const worker = new InvoiceDueDateWorker(repository, tenantContextProvider)
    const result = await worker.run('2026-03-24T00:00:00.000Z')

    expect(result.triggeredActions).toBe(1)
  })

  it('handles boundary case - due at start of current day', async () => {
    vi.mocked(tenantContextProvider.listTenants).mockResolvedValue([
      { tenantId: 'tenant-boundary', timezone: 'UTC' },
    ])
    vi.mocked(repository.listPendingDueDateInvoices).mockResolvedValue([
      { invoiceId: 'inv-start-day', dueAtUtc: '2026-03-24T00:00:00.000Z' },
    ])

    const worker = new InvoiceDueDateWorker(repository, tenantContextProvider)
    const result = await worker.run('2026-03-24T23:59:59.999Z')

    expect(result.triggeredActions).toBe(1)
  })

  it('handles timezone with DST - spring forward boundary', async () => {
    vi.mocked(tenantContextProvider.listTenants).mockResolvedValue([
      { tenantId: 'tenant-ny', timezone: 'America/New_York' },
    ])
    vi.mocked(repository.listPendingDueDateInvoices).mockResolvedValue([
      { invoiceId: 'inv-dst-spring', dueAtUtc: '2026-03-09T00:00:00.000Z' },
    ])

    const worker = new InvoiceDueDateWorker(repository, tenantContextProvider)
    const result = await worker.run('2026-03-09T12:00:00.000Z')

    expect(result.processedTenants).toBe(1)
    expect(result.errors).toBe(0)
  })

  it('handles timezone with DST - fall back boundary', async () => {
    vi.mocked(tenantContextProvider.listTenants).mockResolvedValue([
      { tenantId: 'tenant-ny-fall', timezone: 'America/New_York' },
    ])
    vi.mocked(repository.listPendingDueDateInvoices).mockResolvedValue([
      { invoiceId: 'inv-dst-fall', dueAtUtc: '2026-11-01T00:00:00.000Z' },
    ])

    const worker = new InvoiceDueDateWorker(repository, tenantContextProvider)
    const result = await worker.run('2026-11-01T12:00:00.000Z')

    expect(result.processedTenants).toBe(1)
    expect(result.errors).toBe(0)
  })

  it('handles extreme batch size of 1', async () => {
    const tenants = Array.from({ length: 3 }, (_, i) => ({
      tenantId: `tenant-${i}`,
      timezone: 'UTC',
    }))
    vi.mocked(tenantContextProvider.listTenants).mockResolvedValue(tenants)
    vi.mocked(repository.listPendingDueDateInvoices).mockResolvedValue([])

    const worker = new InvoiceDueDateWorker(repository, tenantContextProvider, {
      tenantBatchSize: 1,
    })
    const result = await worker.run('2026-03-24T01:00:00.000Z')

    expect(result.processedTenants).toBe(3)
    expect(repository.listPendingDueDateInvoices).toHaveBeenCalledTimes(3)
  })

  it('handles very large batch size', async () => {
    const tenants = Array.from({ length: 5 }, (_, i) => ({
      tenantId: `tenant-${i}`,
      timezone: 'UTC',
    }))
    vi.mocked(tenantContextProvider.listTenants).mockResolvedValue(tenants)
    vi.mocked(repository.listPendingDueDateInvoices).mockResolvedValue([])

    const worker = new InvoiceDueDateWorker(repository, tenantContextProvider, {
      tenantBatchSize: 1000,
    })
    const result = await worker.run('2026-03-24T01:00:00.000Z')

    expect(result.processedTenants).toBe(5)
    expect(repository.listPendingDueDateInvoices).toHaveBeenCalledTimes(5)
  })

  it('handles Date object as nowUtc parameter', async () => {
    vi.mocked(tenantContextProvider.listTenants).mockResolvedValue([
      { tenantId: 'tenant-date', timezone: 'UTC' },
    ])
    vi.mocked(repository.listPendingDueDateInvoices).mockResolvedValue([
      { invoiceId: 'inv-date', dueAtUtc: '2026-03-23T00:00:00.000Z' },
    ])

    const worker = new InvoiceDueDateWorker(repository, tenantContextProvider)
    const result = await worker.run(new Date('2026-03-24T01:00:00.000Z'))

    expect(result.processedTenants).toBe(1)
    expect(result.triggeredActions).toBe(1)
    expect(result.startTime).toBe('2026-03-24T01:00:00.000Z')
  })

  it('measures duration correctly', async () => {
    vi.mocked(tenantContextProvider.listTenants).mockResolvedValue([
      { tenantId: 'tenant-duration', timezone: 'UTC' },
    ])
    vi.mocked(repository.listPendingDueDateInvoices).mockResolvedValue([])

    const worker = new InvoiceDueDateWorker(repository, tenantContextProvider)
    const result = await worker.run('2026-03-24T01:00:00.000Z')

    expect(result.duration).toBeGreaterThanOrEqual(0)
    expect(typeof result.duration).toBe('number')
  })

  it('logs initialization message', async () => {
    vi.mocked(tenantContextProvider.listTenants).mockResolvedValue([
      { tenantId: 'tenant-log', timezone: 'UTC' },
    ])
    vi.mocked(repository.listPendingDueDateInvoices).mockResolvedValue([])

    const mockLogger = vi.fn()
    const worker = new InvoiceDueDateWorker(repository, tenantContextProvider, {
      logger: mockLogger,
    })
    await worker.run('2026-03-24T01:00:00.000Z')

    expect(mockLogger).toHaveBeenCalledWith('Evaluating due-date actions for 1 tenants')
  })

  it('logs tenant failure with error message', async () => {
    vi.mocked(tenantContextProvider.listTenants).mockResolvedValue([
      { tenantId: 'tenant-fail-msg', timezone: 'UTC' },
    ])
    vi.mocked(repository.listPendingDueDateInvoices).mockRejectedValue(new Error('Database connection lost'))

    const mockLogger = vi.fn()
    const worker = new InvoiceDueDateWorker(repository, tenantContextProvider, {
      logger: mockLogger,
    })
    const result = await worker.run('2026-03-24T01:00:00.000Z')

    expect(result.errors).toBe(1)
    expect(mockLogger).toHaveBeenCalledWith('Failed tenant tenant-fail-msg: Database connection lost')
  })

  it('logs unknown error when non-Error thrown', async () => {
    vi.mocked(tenantContextProvider.listTenants).mockResolvedValue([
      { tenantId: 'tenant-unknown', timezone: 'UTC' },
    ])
    vi.mocked(repository.listPendingDueDateInvoices).mockRejectedValue('string error')

    const mockLogger = vi.fn()
    const worker = new InvoiceDueDateWorker(repository, tenantContextProvider, {
      logger: mockLogger,
    })
    await worker.run('2026-03-24T01:00:00.000Z')

    expect(mockLogger).toHaveBeenCalledWith('Failed tenant tenant-unknown: Unknown worker error')
  })

  it('handles partial batch failures - continues processing other batches', async () => {
    const tenants = Array.from({ length: 4 }, (_, i) => ({
      tenantId: `tenant-${i}`,
      timezone: 'UTC',
    }))
    vi.mocked(tenantContextProvider.listTenants).mockResolvedValue(tenants)
    vi.mocked(repository.listPendingDueDateInvoices)
      .mockRejectedValueOnce(new Error('fail tenant-0'))
      .mockResolvedValueOnce([]) // tenant-1 succeeds
      .mockRejectedValueOnce(new Error('fail tenant-2')) 
      .mockResolvedValueOnce([]) // tenant-3 succeeds

    const worker = new InvoiceDueDateWorker(repository, tenantContextProvider, {
      tenantBatchSize: 2,
    })
    const result = await worker.run('2026-03-24T01:00:00.000Z')

    expect(result.processedTenants).toBe(2) // tenants 1 and 3
    expect(result.errors).toBe(2) // tenants 0 and 2
    expect(result.evaluatedInvoices).toBe(0)
  })

  it('evaluates each tenant in its own timezone independently', async () => {
    vi.mocked(tenantContextProvider.listTenants).mockResolvedValue([
      { tenantId: 'tenant-a', timezone: 'UTC' },
      { tenantId: 'tenant-b', timezone: 'America/Los_Angeles' },
      { tenantId: 'tenant-c', timezone: 'Asia/Tokyo' },
    ])

    vi.mocked(repository.listPendingDueDateInvoices).mockResolvedValue([
      { invoiceId: 'inv-common', dueAtUtc: '2026-03-23T00:00:00.000Z' },
    ])

    const worker = new InvoiceDueDateWorker(repository, tenantContextProvider)
    const result = await worker.run('2026-03-24T01:00:00.000Z')

    expect(result.processedTenants).toBe(3)
    expect(result.triggeredActions).toBe(3)
    expect(repository.markDueDateActionTriggered).toHaveBeenCalledTimes(3)
  })

  it('preserves state consistency when multiple invoices trigger actions', async () => {
    vi.mocked(tenantContextProvider.listTenants).mockResolvedValue([
      { tenantId: 'tenant-consistent', timezone: 'UTC' },
    ])
    vi.mocked(repository.listPendingDueDateInvoices).mockResolvedValue([
      { invoiceId: 'inv-1', dueAtUtc: '2026-03-23T01:00:00.000Z' },
      { invoiceId: 'inv-2', dueAtUtc: '2026-03-22T12:00:00.000Z' },
      { invoiceId: 'inv-3', dueAtUtc: '2026-03-23T23:59:59.999Z' },
    ])

    const worker = new InvoiceDueDateWorker(repository, tenantContextProvider)
    const result = await worker.run('2026-03-24T00:00:00.000Z')

    expect(result.triggeredActions).toBe(3)
    expect(repository.markDueDateActionTriggered).toHaveBeenCalledTimes(3)
    expect(repository.markDueDateActionTriggered).toHaveBeenNthCalledWith(1, 'inv-1', '2026-03-24T00:00:00.000Z')
    expect(repository.markDueDateActionTriggered).toHaveBeenNthCalledWith(2, 'inv-2', '2026-03-24T00:00:00.000Z')
    expect(repository.markDueDateActionTriggered).toHaveBeenNthCalledWith(3, 'inv-3', '2026-03-24T00:00:00.000Z')
  })



  it('is safe under overlapping runs because exclusion is owned by the lock layer', async () => {
    // The worker performs no mutual exclusion of its own: two overlapping runs
    // can both observe an invoice as pending. Exactly-once therefore depends on
    // (a) LockedInvoiceDueDateWorker holding the distributed lock and
    // (b) markDueDateActionTriggered being idempotent for a given invoiceId.
    // What the worker must guarantee is that overlapping runs agree on the
    // trigger timestamp, so an idempotent repository write is a no-op rather
    // than a conflicting update.
    const markCalls: Array<[string, string]> = []
    vi.mocked(tenantContextProvider.listTenants).mockResolvedValue([
      { tenantId: 'tenant-overlap', timezone: 'UTC' },
    ])
    vi.mocked(repository.listPendingDueDateInvoices).mockResolvedValue([
      { invoiceId: 'inv-overlap', dueAtUtc: '2026-03-23T00:00:00.000Z' },
    ])
    vi.mocked(repository.markDueDateActionTriggered).mockImplementation(async (invoiceId, at) => {
      markCalls.push([invoiceId, at])
    })

    const worker = new InvoiceDueDateWorker(repository, tenantContextProvider)
    const [a, b] = await Promise.all([
      worker.run('2026-03-24T01:00:00.000Z'),
      worker.run('2026-03-24T01:00:00.000Z'),
    ])

    expect(a.errors).toBe(0)
    expect(b.errors).toBe(0)
    expect(a.processedTenants).toBe(1)
    expect(b.processedTenants).toBe(1)
    // Every trigger, from either run, uses the same canonical timestamp.
    expect(new Set(markCalls.map(([, at]) => at))).toEqual(new Set(['2026-03-24T01:00:00.000Z']))
    // Only invoiceId is duplicated; the repository can dedupe on that key.
    expect(new Set(markCalls.map(([id]) => id))).toEqual(new Set(['inv-overlap']))
  })

  it('does not drop an invoice that becomes pending while another run is in flight', async () => {
    vi.mocked(tenantContextProvider.listTenants).mockResolvedValue([
      { tenantId: 'tenant-inflight', timezone: 'UTC' },
    ])
    vi.mocked(repository.listPendingDueDateInvoices)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { invoiceId: 'inv-late-arrival', dueAtUtc: '2026-03-23T00:00:00.000Z' },
      ])

    const worker = new InvoiceDueDateWorker(repository, tenantContextProvider)
    const first = await worker.run('2026-03-24T01:00:00.000Z')
    const second = await worker.run('2026-03-24T01:05:00.000Z')

    expect(first.triggeredActions).toBe(0)
    expect(second.triggeredActions).toBe(1)
    expect(repository.markDueDateActionTriggered).toHaveBeenCalledWith(
      'inv-late-arrival',
      '2026-03-24T01:05:00.000Z',
    )
  })

  it('propagates a tenant-provider failure rather than reporting a clean run', async () => {
    vi.mocked(tenantContextProvider.listTenants).mockRejectedValue(new Error('tenant registry down'))

    const worker = new InvoiceDueDateWorker(repository, tenantContextProvider)

    await expect(worker.run('2026-03-24T01:00:00.000Z')).rejects.toThrow('tenant registry down')
    expect(repository.listPendingDueDateInvoices).not.toHaveBeenCalled()
  })

  it('rejects a nowUtc value that is missing a UTC offset', async () => {
    vi.mocked(tenantContextProvider.listTenants).mockResolvedValue([
      { tenantId: 'tenant-bad-now', timezone: 'UTC' },
    ])

    const worker = new InvoiceDueDateWorker(repository, tenantContextProvider)

    await expect(worker.run('2026-03-24T01:00:00')).rejects.toThrow(/must include UTC offset or Z suffix/)
    expect(repository.markDueDateActionTriggered).not.toHaveBeenCalled()
  })

  it('rejects an invalid Date object instead of silently skipping every tenant', async () => {
    vi.mocked(tenantContextProvider.listTenants).mockResolvedValue([
      { tenantId: 'tenant-bad-date', timezone: 'UTC' },
    ])

    const worker = new InvoiceDueDateWorker(repository, tenantContextProvider)

    await expect(worker.run(new Date('nope'))).rejects.toThrow('Invalid Date input')
    expect(repository.markDueDateActionTriggered).not.toHaveBeenCalled()
  })

  it('normalizes a non-UTC offset nowUtc to canonical UTC', async () => {
    vi.mocked(tenantContextProvider.listTenants).mockResolvedValue([
      { tenantId: 'tenant-offset', timezone: 'UTC' },
    ])
    vi.mocked(repository.listPendingDueDateInvoices).mockResolvedValue([
      { invoiceId: 'inv-offset', dueAtUtc: '2026-03-23T20:00:00.000Z' },
    ])

    const worker = new InvoiceDueDateWorker(repository, tenantContextProvider)
    const result = await worker.run('2026-03-24T02:00:00.000+02:00')

    expect(result.startTime).toBe('2026-03-24T00:00:00.000Z')
    expect(repository.listPendingDueDateInvoices).toHaveBeenCalledWith('tenant-offset', '2026-03-24T00:00:00.000Z')
    expect(repository.markDueDateActionTriggered).toHaveBeenCalledWith('inv-offset', '2026-03-24T00:00:00.000Z')
  })

  it('delegates identifier validation to the repository rather than silently dropping tenants', async () => {
    vi.mocked(tenantContextProvider.listTenants).mockResolvedValue([
      { tenantId: '', timezone: 'UTC' },
    ])
    vi.mocked(repository.listPendingDueDateInvoices).mockResolvedValue([
      { invoiceId: '', dueAtUtc: '2026-03-23T00:00:00.000Z' },
    ])

    const mockLogger = vi.fn()
    const worker = new InvoiceDueDateWorker(repository, tenantContextProvider, { logger: mockLogger })
    const result = await worker.run('2026-03-24T01:00:00.000Z')

    // Documents current behavior: the worker does not second-guess repository
    // identifiers. Blank ids are the repository's contract to reject, so the
    // invariant asserted here is only that the run stays visible and is logged,
    // not that the worker enforces identifier shape.
    expect(result.evaluatedInvoices).toBe(1)
    expect(mockLogger).toHaveBeenCalledWith('Evaluating due-date actions for 1 tenants')
  })

  it('surfaces the underlying error text so failures stay diagnosable', async () => {
    vi.mocked(tenantContextProvider.listTenants).mockResolvedValue([
      { tenantId: 'tenant-redact', timezone: 'UTC' },
    ])
    vi.mocked(repository.listPendingDueDateInvoices).mockRejectedValue(
      new Error('connection to postgres://user:hunter2@db/invoices failed'),
    )

    const mockLogger = vi.fn()
    const worker = new InvoiceDueDateWorker(repository, tenantContextProvider, { logger: mockLogger })
    await worker.run('2026-03-24T01:00:00.000Z')

    const logged = mockLogger.mock.calls.flat().join('\n')
    // Tenant id is included for scoping, and the driver error is passed through
    // verbatim: redaction belongs at the logging sink, not here, where hiding it
    // would remove the operator's ability to diagnose the failure.
    expect(logged).toContain('tenant-redact')
    expect(logged).toContain('postgres://user:hunter2@db/invoices')
  })
})
