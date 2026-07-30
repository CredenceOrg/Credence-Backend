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
})
