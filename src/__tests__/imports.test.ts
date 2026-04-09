import { describe, it, expect } from 'vitest'
import request from 'supertest'
import app from '../app.js'
import { IMPORT_PREVIEW_MAX_FILE_BYTES } from '../services/importPreviewService.js'

describe('POST /api/imports/preview', () => {
  const ENTERPRISE_KEY = 'test-enterprise-key-12345'
  const PUBLIC_KEY = 'test-public-key-67890'
  const INVALID_KEY = 'invalid-key'

  const VALID_ADDRESS_1 = 'GABC7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ'
  const VALID_ADDRESS_2 = 'GDEF7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ'
  const INVALID_ADDRESS = 'INVALID'

  describe('Authentication', () => {
    it('should return 401 when API key is missing', async () => {
      const csv = `address\n${VALID_ADDRESS_1}\n`
      const response = await request(app)
        .post('/api/imports/preview')
        .attach('file', Buffer.from(csv, 'utf8'), 'import.csv')

      expect(response.status).toBe(401)
      expect(response.body).toEqual({
        error: 'Unauthorized',
        message: 'API key is required',
      })
    })

    it('should return 401 when API key is invalid', async () => {
      const csv = `address\n${VALID_ADDRESS_1}\n`
      const response = await request(app)
        .post('/api/imports/preview')
        .set('X-API-Key', INVALID_KEY)
        .attach('file', Buffer.from(csv, 'utf8'), 'import.csv')

      expect(response.status).toBe(401)
      expect(response.body).toEqual({
        error: 'Unauthorized',
        message: 'Invalid API key',
      })
    })

    it('should return 403 when using public API key', async () => {
      const csv = `address\n${VALID_ADDRESS_1}\n`
      const response = await request(app)
        .post('/api/imports/preview')
        .set('X-API-Key', PUBLIC_KEY)
        .attach('file', Buffer.from(csv, 'utf8'), 'import.csv')

      expect(response.status).toBe(403)
      expect(response.body).toEqual({
        error: 'Forbidden',
        message: 'Enterprise API key required',
      })
    })

    it('should accept valid enterprise API key', async () => {
      const csv = `address\n${VALID_ADDRESS_1}\n`
      const response = await request(app)
        .post('/api/imports/preview')
        .set('X-API-Key', ENTERPRISE_KEY)
        .attach('file', Buffer.from(csv, 'utf8'), 'import.csv')

      expect(response.status).toBe(200)
    })
  })

  describe('Request validation', () => {
    it('should return 400 when file field is missing', async () => {
      const response = await request(app)
        .post('/api/imports/preview')
        .set('X-API-Key', ENTERPRISE_KEY)

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({
        error: 'InvalidRequest',
        code: 'MissingFile',
      })
    })
  })

  describe('CSV parsing and schema', () => {
    it('should return 400 for invalid UTF-8', async () => {
      const badUtf8 = Buffer.from([0xff, 0xfe, 0xfd])
      const response = await request(app)
        .post('/api/imports/preview')
        .set('X-API-Key', ENTERPRISE_KEY)
        .attach('file', badUtf8, 'bad-encoding.csv')

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({
        code: 'InvalidEncoding',
        message: 'File must be valid UTF-8 text.',
      })
    })

    it('should return 400 for malformed CSV', async () => {
      const csv = 'address\n"unclosed quote'
      const response = await request(app)
        .post('/api/imports/preview')
        .set('X-API-Key', ENTERPRISE_KEY)
        .attach('file', Buffer.from(csv, 'utf8'), 'bad.csv')

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({
        error: 'InvalidRequest',
        code: 'MalformedCsv',
        message: 'The file could not be parsed as CSV.',
      })
    })

    it('should return 400 when header has no address column', async () => {
      const csv = `wrong_col\n${VALID_ADDRESS_1}\n`
      const response = await request(app)
        .post('/api/imports/preview')
        .set('X-API-Key', ENTERPRISE_KEY)
        .attach('file', Buffer.from(csv, 'utf8'), 'bad-header.csv')

      expect(response.status).toBe(400)
      expect(response.body).toEqual({
        error: 'InvalidRequest',
        code: 'SchemaError',
        message: 'CSV header must include an "address" column.',
        line: 1,
      })
    })

    it('should accept case-insensitive Address header', async () => {
      const csv = `Address\n${VALID_ADDRESS_1}\n`
      const response = await request(app)
        .post('/api/imports/preview')
        .set('X-API-Key', ENTERPRISE_KEY)
        .attach('file', Buffer.from(csv, 'utf8'), 'ok.csv')

      expect(response.status).toBe(200)
      expect(response.body.summary.validRows).toBe(1)
      expect(response.body.summary.invalidRows).toBe(0)
    })
  })

  describe('Row validation', () => {
    it('should return partial errors with line references', async () => {
      const csv = `address\n${VALID_ADDRESS_1}\n${INVALID_ADDRESS}\n${VALID_ADDRESS_2}\n`
      const response = await request(app)
        .post('/api/imports/preview')
        .set('X-API-Key', ENTERPRISE_KEY)
        .attach('file', Buffer.from(csv, 'utf8'), 'mixed.csv')

      expect(response.status).toBe(200)
      expect(response.body.summary).toMatchObject({
        totalRowsScanned: 3,
        validRows: 2,
        invalidRows: 1,
        truncated: false,
      })
      expect(response.body.rowErrors).toContainEqual({
        line: 3,
        column: 'address',
        code: 'INVALID_ADDRESS',
        message: 'Invalid Stellar address',
      })
      expect(response.body.preview.invalidSample.length).toBeGreaterThan(0)
      expect(response.body.preview.validSample.length).toBeGreaterThan(0)
    })

    it('should report missing address on empty cell', async () => {
      const csv = `address,name\n${VALID_ADDRESS_1},alice\n,bob\n`
      const response = await request(app)
        .post('/api/imports/preview')
        .set('X-API-Key', ENTERPRISE_KEY)
        .attach('file', Buffer.from(csv, 'utf8'), 'empty-addr.csv')

      expect(response.status).toBe(200)
      expect(response.body.summary.invalidRows).toBe(1)
      expect(response.body.rowErrors).toContainEqual({
        line: 3,
        column: 'address',
        code: 'MISSING_ADDRESS',
        message: 'Missing address',
      })
    })

    it('should return all valid rows in summary', async () => {
      const csv = `address\n${VALID_ADDRESS_1}\n${VALID_ADDRESS_2}\n`
      const response = await request(app)
        .post('/api/imports/preview')
        .set('X-API-Key', ENTERPRISE_KEY)
        .attach('file', Buffer.from(csv, 'utf8'), 'all-good.csv')

      expect(response.status).toBe(200)
      expect(response.body.summary).toMatchObject({
        validRows: 2,
        invalidRows: 0,
      })
      expect(response.body.rowErrors).toEqual([])
    })

    it('should return 200 with zeros for header-only file', async () => {
      const csv = 'address\n'
      const response = await request(app)
        .post('/api/imports/preview')
        .set('X-API-Key', ENTERPRISE_KEY)
        .attach('file', Buffer.from(csv, 'utf8'), 'header-only.csv')

      expect(response.status).toBe(200)
      expect(response.body.summary).toMatchObject({
        totalRowsScanned: 0,
        validRows: 0,
        invalidRows: 0,
      })
    })
  })

  describe('Payload limits', () => {
    it('should return 413 when file exceeds max size', async () => {
      const big = Buffer.alloc(IMPORT_PREVIEW_MAX_FILE_BYTES + 1, 0x0a)
      const response = await request(app)
        .post('/api/imports/preview')
        .set('X-API-Key', ENTERPRISE_KEY)
        .attach('file', big, 'huge.csv')

      expect(response.status).toBe(413)
      expect(response.body).toMatchObject({
        error: 'PayloadTooLarge',
        code: 'FileTooLarge',
      })
    })
  })
})
