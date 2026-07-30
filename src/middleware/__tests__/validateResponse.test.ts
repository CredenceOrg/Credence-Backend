import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { z } from 'zod'
import express, { type Express } from 'express'
import request from 'supertest'
import { validateResponse } from '../validateResponse.js'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const validUserSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string().email(),
})

function createApp(): Express {
  return express()
}

// ─────────────────────────────────────────────────────────────────────────────
// validateResponse middleware
// ─────────────────────────────────────────────────────────────────────────────
describe('validateResponse middleware', () => {
  let originalNodeEnv: string | undefined

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV
  })

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = originalNodeEnv
    }
  })

  // ── Production: no-op ─────────────────────────────────────────────────────
  describe('in production', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production'
    })

    it('passes through without validation (no console.error)', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const app = createApp()
      app.get('/test',
        validateResponse({ schema: validUserSchema }),
        (_req, res) => {
          res.json({ this: 'is', totally: 'wrong' })
        },
      )

      const response = await request(app).get('/test')
      expect(response.status).toBe(200)
      expect(consoleErrorSpy).not.toHaveBeenCalled()

      consoleErrorSpy.mockRestore()
    })
  })

  // ── Test environment: no-op ───────────────────────────────────────────────
  describe('in test environment', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'test'
    })

    it('passes through without validation to keep test output clean', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const app = createApp()
      app.get('/test',
        validateResponse({ schema: validUserSchema }),
        (_req, res) => {
          res.json({ bad: 'shape' })
        },
      )

      const response = await request(app).get('/test')
      expect(response.status).toBe(200)
      expect(consoleErrorSpy).not.toHaveBeenCalled()

      consoleErrorSpy.mockRestore()
    })
  })

  // ── Development: fail loud ────────────────────────────────────────────────
  describe('in development', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'development'
    })

    it('passes through valid responses silently', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const app = createApp()
      app.get('/user',
        validateResponse({ schema: validUserSchema }),
        (_req, res) => {
          res.json({
            id: '550e8400-e29b-41d4-a716-446655440000',
            name: 'Alice',
            email: 'alice@example.com',
          })
        },
      )

      const response = await request(app).get('/user')
      expect(response.status).toBe(200)
      expect(response.body).toEqual({
        id: '550e8400-e29b-41d4-a716-446655440000',
        name: 'Alice',
        email: 'alice@example.com',
      })
      expect(consoleErrorSpy).not.toHaveBeenCalled()

      consoleErrorSpy.mockRestore()
    })

    it('logs loud error when response shape is wrong but still sends response', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const app = createApp()
      app.get('/user',
        validateResponse({ schema: validUserSchema }),
        (_req, res) => {
          // Missing 'email', wrong type for 'id'
          res.json({
            id: 'not-a-uuid',
            name: 'Bob',
          })
        },
      )

      const response = await request(app).get('/user')
      // Response still goes through — fail loud, not closed
      expect(response.status).toBe(200)
      expect(response.body).toEqual({
        id: 'not-a-uuid',
        name: 'Bob',
      })

      // Console.error should have been called with the violation
      expect(consoleErrorSpy).toHaveBeenCalled()
      const errorOutput = consoleErrorSpy.mock.calls[0][0]
      expect(errorOutput).toContain('RESPONSE SHAPE VIOLATION')
      expect(errorOutput).toContain('GET /user')

      consoleErrorSpy.mockRestore()
    })

    it('validates that required keys are present', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const schema = z.object({ required: z.string() })
      const app = createApp()
      app.get('/test',
        validateResponse({ schema }),
        (_req, res) => {
          res.json({ wrongKey: 'value' })
        },
      )

      const response = await request(app).get('/test')
      expect(response.status).toBe(200)
      expect(consoleErrorSpy).toHaveBeenCalled()

      consoleErrorSpy.mockRestore()
    })

    it('validates types of response fields', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const schema = z.object({ count: z.number() })
      const app = createApp()
      app.get('/test',
        validateResponse({ schema }),
        (_req, res) => {
          res.json({ count: 'not-a-number' })
        },
      )

      const response = await request(app).get('/test')
      expect(response.status).toBe(200)
      expect(consoleErrorSpy).toHaveBeenCalled()

      consoleErrorSpy.mockRestore()
    })

    it('reports multiple validation errors at once', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const schema = z.object({
        name: z.string(),
        age: z.number().min(18),
        email: z.string().email(),
      })
      const app = createApp()
      app.get('/test',
        validateResponse({ schema }),
        (_req, res) => {
          res.json({
            name: 123,
            age: 5,
            email: 'not-email',
          })
        },
      )

      const response = await request(app).get('/test')
      expect(response.status).toBe(200)
      expect(consoleErrorSpy).toHaveBeenCalled()

      // Should contain multiple error lines in the violation block
      const errorOutput = consoleErrorSpy.mock.calls[0][0]
      // Error lines have format "  - field: message" inside the box
      const errorCount = (errorOutput.match(/  - /g) || []).length
      expect(errorCount).toBeGreaterThanOrEqual(1)

      consoleErrorSpy.mockRestore()
    })

    it('validates nested object response shapes', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const schema = z.object({
        user: z.object({
          name: z.string(),
          address: z.object({
            street: z.string(),
          }),
        }),
      })
      const app = createApp()
      app.get('/test',
        validateResponse({ schema }),
        (_req, res) => {
          res.json({
            user: {
              name: 'Alice',
              address: { street: 12345 }, // wrong type
            },
          })
        },
      )

      const response = await request(app).get('/test')
      expect(response.status).toBe(200)
      expect(consoleErrorSpy).toHaveBeenCalled()

      consoleErrorSpy.mockRestore()
    })

    it('validates array response shapes', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const schema = z.array(z.object({ id: z.number() }))
      const app = createApp()
      app.get('/test',
        validateResponse({ schema }),
        (_req, res) => {
          res.json([{ id: 'bad' }])
        },
      )

      const response = await request(app).get('/test')
      expect(response.status).toBe(200)
      expect(consoleErrorSpy).toHaveBeenCalled()

      consoleErrorSpy.mockRestore()
    })

    it('logs correct HTTP method and URL in error message', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const schema = z.object({ name: z.string() })
      const app = createApp()
      app.post('/api/widgets',
        validateResponse({ schema }),
        (_req, res) => {
          res.json({ name: 123 })
        },
      )

      await request(app).post('/api/widgets')
      const errorOutput = consoleErrorSpy.mock.calls[0][0]
      expect(errorOutput).toContain('POST /api/widgets')

      consoleErrorSpy.mockRestore()
    })

    it('logs the response status code in error message', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const schema = z.object({ name: z.string() })
      const app = createApp()
      app.get('/test',
        validateResponse({ schema }),
        (_req, res) => {
          res.status(201).json({ name: 123 })
        },
      )

      await request(app).get('/test')
      const errorOutput = consoleErrorSpy.mock.calls[0][0]
      expect(errorOutput).toContain('Status: 201')

      consoleErrorSpy.mockRestore()
    })

    it('handles null/undefined response bodies gracefully', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const schema = z.object({ data: z.string() })
      const app = createApp()
      app.get('/test',
        validateResponse({ schema }),
        (_req, res) => {
          // Send null — should still log violation
          res.json(null)
        },
      )

      const response = await request(app).get('/test')
      expect(response.status).toBe(200)
      expect(consoleErrorSpy).toHaveBeenCalled()

      consoleErrorSpy.mockRestore()
    })
  })

  // ── Default NODE_ENV (unset) ──────────────────────────────────────────────
  describe('with unset NODE_ENV', () => {
    beforeEach(() => {
      delete process.env.NODE_ENV
    })

    it('validates when NODE_ENV is not set (defaults to development-like)', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const schema = z.object({ name: z.string() })
      const app = createApp()
      app.get('/test',
        validateResponse({ schema }),
        (_req, res) => {
          res.json({ name: 123 })
        },
      )

      await request(app).get('/test')
      expect(consoleErrorSpy).toHaveBeenCalled()

      consoleErrorSpy.mockRestore()
    })
  })
})
