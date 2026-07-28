/**
 * Route-level validation error contract tests.
 *
 * These tests verify that actual API routes return stable error shapes
 * when validation fails, ensuring deterministic client handling.
 *
 * They test the full middleware stack (validate → handler → errorHandler)
 * to catch any regressions in error code mapping or envelope shape.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import request from 'supertest'
import express, { type Express, type Request, type Response, type NextFunction } from 'express'
import { z } from 'zod'
import { validate, type ValidateOptions } from '../../src/middleware/validate.js'
import { errorHandler } from '../../src/middleware/errorHandler.js'
import { ErrorCode } from '../../src/lib/errors.js'

describe('Route validation error contract', () => {
  let app: Express

  beforeEach(() => {
    app = express()
    app.use(express.json())
  })

  const setupRoute = (opts: ValidateOptions) => {
    app.post('/test', validate(opts), (_req: Request, res: Response) => {
      res.status(200).json({ ok: true })
    })
    app.use(errorHandler)
  }

  // ── Error envelope stability ────────────────────────────────────────────

  it('all validation errors return 400 with error, code, error_code fields', async () => {
    setupRoute({ body: z.object({ name: z.string() }) })

    const res = await request(app)
      .post('/test')
      .send({ name: 123 })

    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({
      error: expect.any(String),
      code: ErrorCode.VALIDATION_FAILED,
      error_code: ErrorCode.VALIDATION_FAILED,
    })
  })

  it('details field is an array when present', async () => {
    setupRoute({ body: z.object({ name: z.string() }) })

    const res = await request(app)
      .post('/test')
      .send({})

    expect(Array.isArray(res.body.details)).toBe(true)
    expect(res.body.details.length).toBeGreaterThanOrEqual(1)
  })

  it('each detail entry has path, message, and code strings', async () => {
    setupRoute({ body: z.object({ name: z.string() }) })

    const res = await request(app)
      .post('/test')
      .send({})

    for (const d of res.body.details) {
      expect(typeof d.path).toBe('string')
      expect(typeof d.message).toBe('string')
      expect(typeof d.code).toBe('string')
    }
  })

  // ── Field-level error code stability ────────────────────────────────────

  it('missing required body field yields FIELD_REQUIRED detail code', async () => {
    setupRoute({ body: z.object({ requiredField: z.string() }) })

    const res = await request(app)
      .post('/test')
      .send({})

    expect(res.body.details[0].code).toBe(ErrorCode.FIELD_REQUIRED)
    expect(res.body.details[0].path).toBe('requiredField')
  })

  it('wrong type body field yields INVALID_TYPE detail code', async () => {
    setupRoute({ body: z.object({ count: z.number() }) })

    const res = await request(app)
      .post('/test')
      .send({ count: 'not-a-number' })

    expect(res.body.details[0].code).toBe(ErrorCode.INVALID_TYPE)
  })

  it('invalid format yields INVALID_FORMAT detail code', async () => {
    setupRoute({ body: z.object({ code: z.string().regex(/^\d{3}$/) }) })

    const res = await request(app)
      .post('/test')
      .send({ code: 'abc' })

    expect(res.body.details[0].code).toBe(ErrorCode.INVALID_FORMAT)
  })

  it('value below minimum yields VALUE_TOO_SMALL detail code', async () => {
    setupRoute({ body: z.object({ age: z.number().min(18) }) })

    const res = await request(app)
      .post('/test')
      .send({ age: 15 })

    expect(res.body.details[0].code).toBe(ErrorCode.VALUE_TOO_SMALL)
  })

  it('value above maximum yields VALUE_TOO_LARGE detail code', async () => {
    setupRoute({ body: z.object({ age: z.number().max(120) }) })

    const res = await request(app)
      .post('/test')
      .send({ age: 200 })

    expect(res.body.details[0].code).toBe(ErrorCode.VALUE_TOO_LARGE)
  })

  it('unexpected field yields UNEXPECTED_FIELD detail code', async () => {
    setupRoute({ body: z.object({ name: z.string() }).strict() })

    const res = await request(app)
      .post('/test')
      .send({ name: 'Alice', unknownField: 'surprise' })

    expect(res.body.details[0].code).toBe(ErrorCode.UNEXPECTED_FIELD)
  })

  it('address format mismatch yields INVALID_ADDRESS detail code', async () => {
    setupRoute({ body: z.object({ address: z.string().regex(/^0x[a-fA-F0-9]{40}$/) }) })

    const res = await request(app)
      .post('/test')
      .send({ address: 'bad' })

    expect(res.body.details[0].code).toBe(ErrorCode.INVALID_ADDRESS)
  })

  // ── Query parameter validation ──────────────────────────────────────────

  it('validates query params and returns stable error codes', async () => {
    setupRoute({ query: z.object({ page: z.coerce.number().min(1) }) })

    const res = await request(app)
      .post('/test')
      .query({ page: '0' })

    expect(res.status).toBe(400)
    expect(res.body.code).toBe(ErrorCode.VALIDATION_FAILED)
    expect(res.body.details[0].code).toBe(ErrorCode.VALUE_TOO_SMALL)
  })

  // ── Path parameter validation ───────────────────────────────────────────

  it('validates path params and returns stable error codes', async () => {
    app.post('/test/:id', validate({ params: z.object({ id: z.string().regex(/^\d+$/) }) }), (_req: Request, res: Response) => {
      res.status(200).json({ ok: true })
    })
    app.use(errorHandler)

    const res = await request(app)
      .post('/test/abc')

    expect(res.status).toBe(400)
    expect(res.body.code).toBe(ErrorCode.VALIDATION_FAILED)
    expect(res.body.details[0].code).toBe(ErrorCode.INVALID_FORMAT)
  })

  // ── Multiple sources validated simultaneously ───────────────────────────

  it('validates body + query + params together and collects all errors', async () => {
    app.post('/test/:id', validate({
      params: z.object({ id: z.string().regex(/^\d+$/) }),
      query: z.object({ limit: z.coerce.number().max(100) }),
      body: z.object({ name: z.string() }),
    }), (_req: Request, res: Response) => {
      res.status(200).json({ ok: true })
    })
    app.use(errorHandler)

    const res = await request(app)
      .post('/test/bad')
      .query({ limit: '999' })
      .send({ name: 123 })

    // Expect errors from all three sources
    expect(res.status).toBe(400)
    expect(res.body.details.length).toBeGreaterThanOrEqual(3)
    const codes = res.body.details.map((d: any) => d.code)
    expect(codes).toContain(ErrorCode.INVALID_FORMAT)  // params.id
    expect(codes).toContain(ErrorCode.VALUE_TOO_LARGE)  // query.limit
    expect(codes).toContain(ErrorCode.INVALID_TYPE)     // body.name
  })
})
