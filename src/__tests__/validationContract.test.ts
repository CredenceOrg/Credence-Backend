import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import express, { type Express } from 'express'
import { z } from 'zod'
import { validate } from '../middleware/validate.js'
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

  it('returns FIELD_REQUIRED when a required field is missing', async () => {
    const schema = z.object({
      name: z.string()
    })
    setupRoute(schema)

    const res = await request(app)
      .post('/test')
      .send({})

    expect(res.status).toBe(400)
    expect(res.body.code).toBe(ErrorCode.VALIDATION_FAILED)
    expect(res.body.details[0].code).toBe(ErrorCode.FIELD_REQUIRED)
    expect(res.body.details[0].path).toBe('name')
  })

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

  it('returns VALUE_TOO_SMALL for min constraints', async () => {
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

  it('returns VALUE_TOO_LARGE for max constraints', async () => {
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
})
