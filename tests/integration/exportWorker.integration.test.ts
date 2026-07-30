import { describe, expect, it } from 'vitest'
import { AuditLogService, AuditAction } from '../../src/services/audit/index.js'
import { InMemoryAuditLogsRepository } from '../../src/db/repositories/auditLogsRepository.js'
import {
  ExportService,
  createDiscardExportWriter,
} from '../../src/services/exportService.js'

describe('Export worker integration', () => {
  it('streams a large audit export without buffering the full dataset in memory', async () => {
    const repo = new InMemoryAuditLogsRepository()
    const auditLog = new AuditLogService(repo)
    const tenantId = 'tenant-large-export'
    const rowCount = 2_500

    for (let i = 0; i < rowCount; i++) {
      await auditLog.logAction(
        tenantId,
        'admin-1',
        'admin@example.com',
        AuditAction.EXPORT_AUDIT_LOGS,
        `row-${i}`,
      )
    }

    const startDate = new Date(Date.now() - 86_400_000)
    const endDate = new Date(Date.now() + 86_400_000)

    const exportService = new ExportService(auditLog, { defaultBatchSize: 500 })
    const result = await exportService.runAuditLogExport(
      { startDate, endDate, tenantId },
      createDiscardExportWriter(),
    )

    expect(result.totalRows).toBe(rowCount)
    expect(result.batchesProcessed).toBe(Math.ceil(rowCount / 500))
    expect(result.errors).toBe(0)
  }, 60_000)
})
