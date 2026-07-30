import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { AuditLogService, AuditAction } from './audit/index.js'
import { InMemoryAuditLogsRepository } from '../db/repositories/auditLogsRepository.js'
import {
  ExportService,
  createDiscardExportWriter,
  createNdjsonExportWriter,
} from './exportService.js'
import { ExportTooLargeError } from '../lib/errors.js'

describe('ExportService', () => {
  it('exports audit logs in bounded batches via ExportWorker', async () => {
    const repo = new InMemoryAuditLogsRepository()
    const auditLog = new AuditLogService(repo)
    const tenantId = 'tenant-export'

    for (let i = 0; i < 12; i++) {
      await auditLog.logAction(
        tenantId,
        'admin-1',
        'admin@example.com',
        AuditAction.LIST_USERS,
        `resource-${i}`,
      )
    }

    const startDate = new Date(Date.now() - 60_000)
    const endDate = new Date(Date.now() + 60_000)

    const exportService = new ExportService(auditLog)
    const result = await exportService.runAuditLogExport(
      { startDate, endDate, tenantId },
      createDiscardExportWriter(),
      { batchSize: 5 },
    )

    expect(result.totalRows).toBe(12)
    expect(result.batchesProcessed).toBe(3)
    expect(result.errors).toBe(0)
  })

  it('rejects oversized exports before opening the writer', async () => {
    const repo = new InMemoryAuditLogsRepository()
    const auditLog = new AuditLogService(repo)
    const tenantId = 'tenant-overflow'

    for (let i = 0; i < 8; i++) {
      await auditLog.logAction(
        tenantId,
        'admin-1',
        'admin@example.com',
        AuditAction.LIST_USERS,
        `resource-${i}`,
      )
    }

    const startDate = new Date(Date.now() - 60_000)
    const endDate = new Date(Date.now() + 60_000)
    const exportService = new ExportService(auditLog, {
      maxRows: 5,
      defaultBatchSize: 2,
    })

    const open = vi.fn()
    const writeBatch = vi.fn()
    const close = vi.fn()
    const abort = vi.fn()
    const writer = { open, writeBatch, close, abort }

    await expect(
      exportService.runAuditLogExport({ startDate, endDate, tenantId }, writer),
    ).rejects.toBeInstanceOf(ExportTooLargeError)

    expect(open).not.toHaveBeenCalled()
    expect(writeBatch).not.toHaveBeenCalled()
  })

  it('countRowsUpTo stops early once the cap is exceeded', async () => {
    const repo = new InMemoryAuditLogsRepository()
    const auditLog = new AuditLogService(repo)
    const tenantId = 'tenant-early-exit'
    const querySpy = vi.spyOn(repo, 'query')

    for (let i = 0; i < 20; i++) {
      await auditLog.logAction(
        tenantId,
        'admin-1',
        'admin@example.com',
        AuditAction.LIST_USERS,
        `resource-${i}`,
      )
    }

    const startDate = new Date(Date.now() - 60_000)
    const endDate = new Date(Date.now() + 60_000)
    const exportService = new ExportService(auditLog, {
      maxRows: 5,
      defaultBatchSize: 3,
    })

    querySpy.mockClear()
    const count = await exportService.countRowsUpTo(
      { startDate, endDate, tenantId },
      5,
    )

    expect(count).toBeGreaterThan(5)
    // Early exit: with batch size 3, exceeding 5 needs at most 3 pages (3+3+3)
    expect(querySpy.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('paginates audit export stream instead of loading all rows at once', async () => {
    const repo = new InMemoryAuditLogsRepository()
    const auditLog = new AuditLogService(repo)
    const querySpy = vi.spyOn(repo, 'query')

    const tenantId = 'tenant-stream'
    for (let i = 0; i < 1200; i++) {
      await auditLog.logAction(
        tenantId,
        'admin-1',
        'admin@example.com',
        AuditAction.LIST_USERS,
        `resource-${i}`,
      )
    }

    const startDate = new Date(Date.now() - 60_000)
    const endDate = new Date(Date.now() + 60_000)

    let yielded = 0
    for await (const _entry of auditLog.exportLogsStream(startDate, endDate, tenantId)) {
      yielded++
    }

    expect(yielded).toBe(1200)
    expect(querySpy.mock.calls.some((call) => call[1] === Number.MAX_SAFE_INTEGER)).toBe(false)
    expect(querySpy.mock.calls.length).toBeGreaterThan(1)
  })

  it('writes NDJSON lines and respects stream lifecycle', async () => {
    const chunks: string[] = []
    const stream = new PassThrough()
    stream.on('data', (chunk) => chunks.push(chunk.toString()))

    const writer = createNdjsonExportWriter(stream)
    await writer.open()
    await writer.writeBatch([{ id: 1 }, { id: 2 }])
    await writer.close()

    const lines = chunks.join('').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])).toEqual({ id: 1 })
    expect(JSON.parse(lines[1])).toEqual({ id: 2 })
  })
})
