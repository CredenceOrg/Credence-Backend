import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import systemRouter from '../system.js'
import { pool } from '../../../db/pool.js'
import { BACKUP_STALE_THRESHOLD_MS } from '../../../config/constants.js'

// Mock the pool query
vi.mock('../../../db/pool.js', () => ({
  pool: {
    query: vi.fn(),
  },
}))

// Mock auth middleware to bypass auth
vi.mock('../../../middleware/auth.js', () => ({
  requireUserAuth: (req: any, res: any, next: any) => next(),
  requireAdminRole: (req: any, res: any, next: any) => next(),
}))

const app = express()
app.use(express.json())
app.use('/system', systemRouter)

describe('GET /system/backup-status', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should return isStale: false if backup is recent', async () => {
    const recentTime = new Date(Date.now() - 1000).toISOString()
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [{ last_archived_time: recentTime }],
      command: 'SELECT',
      rowCount: 1,
      oid: 0,
      fields: [],
    })

    const res = await request(app).get('/system/backup-status')

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.isStale).toBe(false)
    expect(res.body.data.lastSuccessfulBackup).toBe(recentTime)
  })

  it('should return isStale: true if backup is older than threshold', async () => {
    const staleTime = new Date(Date.now() - BACKUP_STALE_THRESHOLD_MS - 1000).toISOString()
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [{ last_archived_time: staleTime }],
      command: 'SELECT',
      rowCount: 1,
      oid: 0,
      fields: [],
    })

    const res = await request(app).get('/system/backup-status')

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.isStale).toBe(true)
    expect(res.body.data.lastSuccessfulBackup).toBe(staleTime)
  })

  it('should return isStale: true if last_archived_time is null', async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [{ last_archived_time: null }],
      command: 'SELECT',
      rowCount: 1,
      oid: 0,
      fields: [],
    })

    const res = await request(app).get('/system/backup-status')

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.isStale).toBe(true)
    expect(res.body.data.lastSuccessfulBackup).toBeNull()
  })

  it('should return isStale: true if no rows returned', async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [],
      command: 'SELECT',
      rowCount: 0,
      oid: 0,
      fields: [],
    })

    const res = await request(app).get('/system/backup-status')

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.isStale).toBe(true)
    expect(res.body.data.lastSuccessfulBackup).toBeNull()
  })
})
