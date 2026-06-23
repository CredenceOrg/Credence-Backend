import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ReportStorageService } from './reportStorage.js'

const TEST_SECRET = 'test-report-signing-secret-32chr'

describe('ReportStorageService', () => {
  let storage: ReportStorageService

  beforeEach(() => {
    ReportStorageService.reset()
    storage = new ReportStorageService({ signingSecret: TEST_SECRET })
  })

  describe('makeKey', () => {
    it('generates a scoped path for a tenant and job', () => {
      const key = storage.makeKey('tenant-1', 'job-abc')
      expect(key).toBe('reports/tenant-1/job-abc.pdf')
    })
  })

  describe('upload + exists + retrieve', () => {
    it('stores and retrieves an artifact', async () => {
      const key = storage.makeKey('t1', 'j1')
      async function* stream() {
        yield Buffer.from('Hello', 'utf-8')
        yield Buffer.from(' World', 'utf-8')
      }
      await storage.uploadStream(key, stream())

      expect(storage.exists(key)).toBe(true)
      const data = storage.retrieve(key)
      expect(data?.toString('utf-8')).toBe('Hello World')
    })

    it('throws on empty upload', async () => {
      const key = storage.makeKey('t1', 'j1')
      async function* empty() {}
      await expect(storage.uploadStream(key, empty())).rejects.toThrow('Cannot upload empty report artifact')
    })
  })

  describe('generateSignedUrl + verifyAndRetrieve', () => {
    it('returns data via a valid signed URL', async () => {
      const key = storage.makeKey('t1', 'j1')
      async function* stream() {
        yield Buffer.from('secret report', 'utf-8')
      }
      await storage.uploadStream(key, stream())

      const { url } = storage.generateSignedUrl(key)
      expect(url).toContain('/api/reports/download/reports%2F')
      expect(url).toContain('expires=')
      expect(url).toContain('signature=')

      const urlObj = new URL(url)
      const expires = parseInt(urlObj.searchParams.get('expires')!, 10)
      const signature = urlObj.searchParams.get('signature')!

      const data = storage.verifyAndRetrieve(key, expires, signature)
      expect(data?.toString('utf-8')).toBe('secret report')
    })

    it('rejects an expired signed URL', async () => {
      const key = storage.makeKey('t1', 'j1')
      async function* stream() {
        yield Buffer.from('expired', 'utf-8')
      }
      await storage.uploadStream(key, stream())

      const expires = Date.now() - 1000 // already expired
      const { url } = storage.generateSignedUrl(key)
      const urlObj = new URL(url)
      const signature = urlObj.searchParams.get('signature')!

      const data = storage.verifyAndRetrieve(key, expires, signature)
      expect(data).toBeNull()
    })

    it('rejects a tampered signature', async () => {
      const key = storage.makeKey('t1', 'j1')
      async function* stream() {
        yield Buffer.from('tampered', 'utf-8')
      }
      await storage.uploadStream(key, stream())

      const { url } = storage.generateSignedUrl(key)
      const urlObj = new URL(url)
      const expires = parseInt(urlObj.searchParams.get('expires')!, 10)

      const data = storage.verifyAndRetrieve(key, expires, 'deadbeef')
      expect(data).toBeNull()
    })

    it('returns null for a missing artifact', async () => {
      const key = storage.makeKey('t1', 'missing')
      const { url } = storage.generateSignedUrl(key)
      const urlObj = new URL(url)
      const expires = parseInt(urlObj.searchParams.get('expires')!, 10)
      const signature = urlObj.searchParams.get('signature')!

      const data = storage.verifyAndRetrieve(key, expires, signature)
      expect(data).toBeNull()
    })

    it('returns null for cross-tenant key access', async () => {
      const keyA = storage.makeKey('tenant-a', 'j1')
      const keyB = storage.makeKey('tenant-b', 'j1')

      async function* stream() {
        yield Buffer.from('tenant-a data', 'utf-8')
      }
      await storage.uploadStream(keyA, stream())

      const { url } = storage.generateSignedUrl(keyB)
      const urlObj = new URL(url)
      const expires = parseInt(urlObj.searchParams.get('expires')!, 10)
      const signature = urlObj.searchParams.get('signature')!

      const data = storage.verifyAndRetrieve(keyB, expires, signature)
      expect(data).toBeNull()
    })
  })

  describe('delete', () => {
    it('removes an artifact', async () => {
      const key = storage.makeKey('t1', 'j1')
      async function* stream() {
        yield Buffer.from('delete me', 'utf-8')
      }
      await storage.uploadStream(key, stream())
      expect(storage.exists(key)).toBe(true)

      const deleted = await storage.delete(key)
      expect(deleted).toBe(true)
      expect(storage.exists(key)).toBe(false)
    })

    it('returns false when deleting a non-existent key', async () => {
      const deleted = await storage.delete(storage.makeKey('t1', 'nonexistent'))
      expect(deleted).toBe(false)
    })
  })

  describe('constructor validation', () => {
    it('throws if signing secret is empty', () => {
      expect(() => new ReportStorageService({ signingSecret: '' })).toThrow('REPORT_STORAGE_SIGNING_SECRET must be set')
    })
  })
})
