import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import express, { type Express } from 'express'
import { z } from 'zod'
import { validate, formatZodErrors } from '../middleware/validate.js'
import { errorHandler } from '../middleware/errorHandler.js'
import { ErrorCode } from '../lib/errors.js'

describe('Validation Error Codes Contract', () => {
  let app: Express

  beforeEach(() => {
    app = express()
    app.use(express.json())
  })

  const setupRoute = (schema: any) => {
    app.post('/test', validate({ body: schema }), (req, res) => {
      res.status(200).json({ success: true })
    })
    app.use(errorHandler)
  }

  // ── Envelope shape ─────────────────────────────────────────────────────

  it('top-level error envelope always carries validation_failed code on validation errors', async () => {
    const schema = z.object({ name: z.string() })
    setupRoute(schema)

    const res = await request(app)
      .post('/test')
      .send({})

    expect(res.status).toBe(400)
    expect(res.body.code).toBe(ErrorCode.VALIDATION_FAILED)
    expect(res.body.error_code).toBe(ErrorCode.VALIDATION_FAILED)
    expect(typeof res.body.error).toBe('string')
  })

  it('details array is always present with stable shape', async () => {
    const schema = z.object({ name: z.string() })
    setupRoute(schema)

    const res = await request(app)
      .post('/test')
      .send({})

    expect(Array.isArray(res.body.details)).toBe(true)
    expect(res.body.details.length).toBeGreaterThan(0)
    for (const d of res.body.details) {
      expect(typeof d.path).toBe('string')
      expect(typeof d.message).toBe('string')
      expect(typeof d.code).toBe('string')
    }
  })

  it('details path uses dot-notation for nested fields', async () => {
    const schema = z.object({
      user: z.object({
        address: z.object({
          zip: z.string().regex(/^\d{5}$/),
        }),
      }),
    })
    setupRoute(schema)

    const res = await request(app)
      .post('/test')
      .send({ user: { address: { zip: 'abc' } } })

    expect(res.body.details[0].path).toBe('user.address.zip')
  })

  it('details path is (root) for top-level parse failures', async () => {
    const schema = z.string().min(5)
    setupRoute(schema)

    const res = await request(app)
      .post('/test')
      .send('abc')

    expect(res.body.details[0].path).toBe('(root)')
  })

  // ── FIELD_REQUIRED (invalid_type, received undefined) ──────────────────

  it('returns FIELD_REQUIRED when a required field is missing', async () => {
    const schema = z.object({
      name: z.string()
    })
    setupRoute(schema)

    const res = await request(app)
      .post('/test')
      .send({})

    expect(res.status).toBe(400)
    expect(res.body.details[0].code).toBe(ErrorCode.FIELD_REQUIRED)
    expect(res.body.details[0].path).toBe('name')
  })

  it('returns FIELD_REQUIRED when nested required field is missing', async () => {
    const schema = z.object({
      meta: z.object({ key: z.string() })
    })
    setupRoute(schema)

    const res = await request(app)
      .post('/test')
      .send({ meta: {} })

    expect(res.status).toBe(400)
    expect(res.body.details[0].code).toBe(ErrorCode.FIELD_REQUIRED)
    expect(res.body.details[0].path).toBe('meta.key')
  })

  // ── INVALID_TYPE (invalid_type, wrong type) ────────────────────────────

  it('returns INVALID_TYPE when a field has wrong type', async () => {
    const schema = z.object({
      age: z.number()
    })
    setupRoute(schema)

    const res = await request(app)
      .post('/test')
      .send({ age: 'not-a-number' })

    expect(res.status).toBe(400)
    expect(res.body.details[0].code).toBe(ErrorCode.INVALID_TYPE)
  })

  it('returns INVALID_TYPE for invalid literal values', async () => {
    const schema = z.object({
      kind: z.literal('active')
    })
    setupRoute(schema)

    const res = await request(app)
      .post('/test')
      .send({ kind: 'inactive' })

    expect(res.status).toBe(400)
    expect(res.body.details[0].code).toBe(ErrorCode.INVALID_TYPE)
  })

  it('returns INVALID_TYPE for enum violations', async () => {
    const schema = z.object({
      status: z.enum(['pending', 'confirmed'])
    })
    setupRoute(schema)

    const res = await request(app)
      .post('/test')
      .send({ status: 'unknown' })

    expect(res.status).toBe(400)
    expect(res.body.details[0].code).toBe(ErrorCode.INVALID_TYPE)
  })

  it('returns INVALID_TYPE for union failures', async () => {
    const schema = z.object({
      value: z.union([z.string(), z.number()])
    })
    setupRoute(schema)

    const res = await request(app)
      .post('/test')
      .send({ value: true })

    expect(res.status).toBe(400)
    expect(res.body.details[0].code).toBe(ErrorCode.INVALID_TYPE)
  })

  it('returns INVALID_TYPE for date with wrong type', async () => {
    const schema = z.object({
      date: z.date()
    })
    setupRoute(schema)

    const res = await request(app)
      .post('/test')
      .send({ date: 'not-a-date' })

    expect(res.status).toBe(400)
    expect(res.body.details[0].code).toBe(ErrorCode.INVALID_TYPE)
  })

  // ── INVALID_FORMAT (invalid_format / not_multiple_of / invalid_key) ─────

  it('returns INVALID_FORMAT for regex mismatches on non-address fields', async () => {
    const schema = z.object({
      id: z.string().regex(/^\d+$/)
    })
    setupRoute(schema)

    const res = await request(app)
      .post('/test')
      .send({ id: 'abc' })

    expect(res.status).toBe(400)
    expect(res.body.details[0].code).toBe(ErrorCode.INVALID_FORMAT)
  })

  it('returns INVALID_FORMAT for not_multiple_of', async () => {
    const schema = z.object({
      amount: z.number().multipleOf(5)
    })
    setupRoute(schema)

    const res = await request(app)
      .post('/test')
      .send({ amount: 7 })

    expect(res.status).toBe(400)
    expect(res.body.details[0].code).toBe(ErrorCode.INVALID_FORMAT)
  })

  // ── INVALID_ADDRESS (address-related format mismatches) ────────────────

  it('returns INVALID_ADDRESS for address regex mismatches', async () => {
    const schema = z.object({
      address: z.string().regex(/^0x[a-fA-F0-9]{40}$/)
    })
    setupRoute(schema)

    const res = await request(app)
      .post('/test')
      .send({ address: 'not-an-address' })

    expect(res.status).toBe(400)
    expect(res.body.details[0].code).toBe(ErrorCode.INVALID_ADDRESS)
  })

  it('returns INVALID_ADDRESS for fields whose name contains address', async () => {
    const schema = z.object({
      userAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/)
    })
    setupRoute(schema)

    const res = await request(app)
      .post('/test')
      .send({ userAddress: 'invalid' })

    expect(res.status).toBe(400)
    expect(res.body.details[0].code).toBe(ErrorCode.INVALID_ADDRESS)
  })

  // ── INVALID_STELLAR_ADDRESS (custom validator) ─────────────────────────

  it('returns INVALID_STELLAR_ADDRESS for custom stellar address check', async () => {
    const schema = z.object({
      stellar: z.string().refine((v) => v.startsWith('G') && v.length === 56, {
        message: 'INVALID_STELLAR_ADDRESS',
      })
    })
    setupRoute(schema)

    const res = await request(app)
      .post('/test')
      .send({ stellar: 'invalid' })

    expect(res.status).toBe(400)
    expect(res.body.details[0].code).toBe(ErrorCode.INVALID_STELLAR_ADDRESS)
  })

  it('returns INVALID_STELLAR_ADDRESS when message contains stellar and address', async () => {
    const schema = z.object({
      dest: z.string().refine(() => false, { message: 'Invalid stellar address format' })
    })
    setupRoute(schema)

    const res = await request(app)
      .post('/test')
      .send({ dest: 'GABC' })

    expect(res.status).toBe(400)
    expect(res.body.details[0].code).toBe(ErrorCode.INVALID_STELLAR_ADDRESS)
  })

  it('returns INVALID_ADDRESS for custom address validation that does not mention stellar', async () => {
    const schema = z.object({
      wallet: z.string().refine(() => false, { message: 'Invalid wallet address' })
    })
    setupRoute(schema)

    const res = await request(app)
      .post('/test')
      .send({ wallet: '0xbad' })

    expect(res.status).toBe(400)
    expect(res.body.details[0].code).toBe(ErrorCode.INVALID_ADDRESS)
  })

  it('returns VALIDATION_FAILED for custom errors unrelated to addresses', async () => {
    const schema = z.object({
      value: z.string().refine(() => false, { message: 'Custom business rule failed' })
    })
    setupRoute(schema)

    const res = await request(app)
      .post('/test')
      .send({ value: 'anything' })

    expect(res.status).toBe(400)
    expect(res.body.details[0].code).toBe(ErrorCode.VALIDATION_FAILED)
  })

  // ── VALUE_TOO_SMALL ────────────────────────────────────────────────────

  it('returns VALUE_TOO_SMALL for number min constraints', async () => {
    const schema = z.object({
      count: z.number().min(10)
    })
    setupRoute(schema)

    const res = await request(app)
      .post('/test')
      .send({ count: 5 })

    expect(res.status).toBe(400)
    expect(res.body.details[0].code).toBe(ErrorCode.VALUE_TOO_SMALL)
  })

  it('returns VALUE_TOO_SMALL for string min length', async () => {
    const schema = z.object({
      code: z.string().min(8)
    })
    setupRoute(schema)

    const res = await request(app)
      .post('/test')
      .send({ code: 'short' })

    expect(res.status).toBe(400)
    expect(res.body.details[0].code).toBe(ErrorCode.VALUE_TOO_SMALL)
  })

  it('returns VALUE_TOO_SMALL for array min items', async () => {
    const schema = z.object({
      tags: z.array(z.string()).min(2)
    })
    setupRoute(schema)

    const res = await request(app)
      .post('/test')
      .send({ tags: ['one'] })

    expect(res.status).toBe(400)
    expect(res.body.details[0].code).toBe(ErrorCode.VALUE_TOO_SMALL)
  })

  // ── VALUE_TOO_LARGE ────────────────────────────────────────────────────

  it('returns VALUE_TOO_LARGE for number max constraints', async () => {
    const schema = z.object({
      count: z.number().max(10)
    })
    setupRoute(schema)

    const res = await request(app)
      .post('/test')
      .send({ count: 15 })

    expect(res.status).toBe(400)
    expect(res.body.details[0].code).toBe(ErrorCode.VALUE_TOO_LARGE)
  })

  it('returns VALUE_TOO_LARGE for string max length', async () => {
    const schema = z.object({
      code: z.string().max(3)
    })
    setupRoute(schema)

    const res = await request(app)
      .post('/test')
      .send({ code: 'too-long' })

    expect(res.status).toBe(400)
    expect(res.body.details[0].code).toBe(ErrorCode.VALUE_TOO_LARGE)
  })

  // ── UNEXPECTED_FIELD ───────────────────────────────────────────────────

  it('returns UNEXPECTED_FIELD for strict schema violations', async () => {
    const schema = z.object({
      name: z.string()
    }).strict()
    setupRoute(schema)

    const res = await request(app)
      .post('/test')
      .send({ name: 'Alice', extra: 'field' })

    expect(res.status).toBe(400)
    expect(res.body.details[0].code).toBe(ErrorCode.UNEXPECTED_FIELD)
  })

  // ── Multiple issues ─────────────────────────────────────────────────────

  it('returns multiple details when multiple fields are invalid', async () => {
    const schema = z.object({
      name: z.string(),
      age: z.number().min(18),
    })
    setupRoute(schema)

    const res = await request(app)
      .post('/test')
      .send({ age: 15 })

    expect(res.status).toBe(400)
    expect(res.body.details.length).toBeGreaterThanOrEqual(2)
    const codes = res.body.details.map((d: any) => d.code)
    expect(codes).toContain(ErrorCode.FIELD_REQUIRED)
    expect(codes).toContain(ErrorCode.VALUE_TOO_SMALL)
  })

  it('returns 400 with validation_failed code for all validation errors', async () => {
    const schema = z.object({
      email: z.string().email(),
    })
    setupRoute(schema)

    const res = await request(app)
      .post('/test')
      .send({ email: 'not-an-email' })

    expect(res.status).toBe(400)
    expect(res.body.code).toBe(ErrorCode.VALIDATION_FAILED)
  })
})

describe('formatZodErrors - direct unit tests', () => {
  it('handles invalid_key code', () => {
    const issue = { code: 'invalid_key', path: ['key'], message: 'Invalid key' }
    const result = formatZodErrors({ issues: [issue], name: 'ZodError' } as any)
    expect(result[0].code).toBe(ErrorCode.INVALID_FORMAT)
  })

  it('handles invalid_arguments code', () => {
    const issue = { code: 'invalid_arguments', path: [], message: 'Invalid arguments' }
    const result = formatZodErrors({ issues: [issue], name: 'ZodError' } as any)
    expect(result[0].code).toBe(ErrorCode.VALIDATION_FAILED)
  })

  it('handles invalid_return_type code', () => {
    const issue = { code: 'invalid_return_type', path: [], message: 'Invalid return type' }
    const result = formatZodErrors({ issues: [issue], name: 'ZodError' } as any)
    expect(result[0].code).toBe(ErrorCode.VALIDATION_FAILED)
  })

  it('handles unknown code with VALIDATION_FAILED fallback', () => {
    const issue = { code: 'some_new_code', path: ['field'], message: 'Unknown error' }
    const result = formatZodErrors({ issues: [issue], name: 'ZodError' } as any)
    expect(result[0].code).toBe(ErrorCode.VALIDATION_FAILED)
  })
})
