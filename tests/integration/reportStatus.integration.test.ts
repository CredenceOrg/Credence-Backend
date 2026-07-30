import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Pool } from 'pg'
import { ReportRepository } from '../../src/db/repositories/reportRepository.js'
import { ReportService } from '../../src/services/reportService.js'
import { ReportJobStatus } from '../../src/jobs/types.js'
import { cache } from '../../src/cache/redis.js'

describe('Report Status and Cancellation Integration', () => {
  let pool: Pool
  let repository: ReportRepository
  let service: ReportService

  beforeAll(async () => {
    pool = new Pool({
      connectionString: process.env.TEST_DB_URL || 'postgresql://postgres:postgres@localhost:5432/test_db',
    })
    repository = new ReportRepository(pool)
    service = new ReportService(repository)
    
    // Create tables if they don't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS report_jobs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        type VARCHAR(255) NOT NULL,
        status VARCHAR(50) NOT NULL,
        failure_reason TEXT,
        artifact_url TEXT,
        storage_key TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `)
  })

  afterAll(async () => {
    await pool.query('DROP TABLE IF EXISTS report_jobs')
    await pool.end()
    await cache.client.quit() // Ensure redis connection is closed properly
  })

  it('should create a job, poll its status, and cancel it with durable state', async () => {
    // 1. Create a job
    const job = await service.startReportGeneration('test_report', 'tenant-1', { foo: 'bar' })
    expect(job).toBeDefined()
    expect(job.status).toBe(ReportJobStatus.QUEUED)
    
    // 2. Poll status
    const status1 = await service.getReportStatus(job.id)
    expect(status1).toBeDefined()
    expect(status1!.id).toBe(job.id)
    expect(status1!.status).toBe(ReportJobStatus.QUEUED)
    
    // 3. Cancel the job
    const cancelledJob = await service.cancelReportJob(job.id)
    expect(cancelledJob).toBeDefined()
    expect(cancelledJob!.status).toBe(ReportJobStatus.CANCELLED)
    expect(cancelledJob!.failureReason).toBe('Cancelled by user')
    
    // 4. Poll status again to ensure durable state (and cache update)
    const status2 = await service.getReportStatus(job.id)
    expect(status2).toBeDefined()
    expect(status2!.status).toBe(ReportJobStatus.CANCELLED)
    
    // 5. Verify DB durable state
    const dbJob = await repository.findById(job.id)
    expect(dbJob!.status).toBe(ReportJobStatus.CANCELLED)
  })
})
