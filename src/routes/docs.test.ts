import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createDocsRouter } from './docs.js'

function appWithDocs() {
  const app = express()
  app.use('/api-docs', createDocsRouter())
  return app
}

describe('Docs routes', () => {
  it('serves runtime OpenAPI JSON', async () => {
    const res = await request(appWithDocs()).get('/api-docs/openapi.json')

    expect(res.status).toBe(200)
    expect(res.body.openapi).toBe('3.1.0')
    expect(res.body.paths['/api/governance/disputes']).toBeDefined()
  })

  it('serves Swagger UI HTML at /api-docs', async () => {
    const res = await request(appWithDocs()).get('/api-docs')

    expect(res.status).toBe(301)
  })

  it('serves Swagger UI index at /api-docs/', async () => {
    const res = await request(appWithDocs()).get('/api-docs/')

    expect(res.status).toBe(200)
    expect(typeof res.text).toBe('string')
    expect(res.text).toContain('Swagger UI')
  })
})
