import { describe, it, expect, beforeEach, vi } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import { securityHeadersMiddleware, securityHeadersWithOverride } from '../securityHeaders.js'

describe('Security Headers Middleware', () => {
  let app: Express

  beforeEach(() => {
    app = express()
    // Reset NODE_ENV for each test
    process.env.NODE_ENV = 'test'
  })

  describe('securityHeadersMiddleware', () => {
    beforeEach(() => {
      app = express()
      app.use(securityHeadersMiddleware)
      app.get('/test', (req, res) => {
        res.json({ message: 'test' })
      })
    })

    it('sets Content-Security-Policy header', async () => {
      const response = await request(app).get('/test')
      
      expect(response.headers['content-security-policy']).toBeDefined()
      expect(response.headers['content-security-policy']).toContain("default-src 'self'")
      expect(response.headers['content-security-policy']).toContain("script-src 'self'")
      expect(response.headers['content-security-policy']).toContain("script-src-attr 'none'")
    })

    it('sets Strict-Transport-Security header', async () => {
      const response = await request(app).get('/test')
      
      expect(response.headers['strict-transport-security']).toBeDefined()
      expect(response.headers['strict-transport-security']).toContain('max-age=31536000')
      expect(response.headers['strict-transport-security']).toContain('includeSubDomains')
    })

    it('disables HSTS preload in non-production environment', async () => {
      process.env.NODE_ENV = 'development'
      
      const response = await request(app).get('/test')
      
      expect(response.headers['strict-transport-security']).toBeDefined()
      expect(response.headers['strict-transport-security']).not.toContain('preload')
    })

    it('enables HSTS preload in production environment', async () => {
      process.env.NODE_ENV = 'production'
      
      const response = await request(app).get('/test')
      
      expect(response.headers['strict-transport-security']).toBeDefined()
      expect(response.headers['strict-transport-security']).toContain('preload')
    })

    it('sets Referrer-Policy header', async () => {
      const response = await request(app).get('/test')
      
      expect(response.headers['referrer-policy']).toBeDefined()
      expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin')
    })

    it('sets Cross-Origin-Resource-Policy header', async () => {
      const response = await request(app).get('/test')
      
      expect(response.headers['cross-origin-resource-policy']).toBeDefined()
      expect(response.headers['cross-origin-resource-policy']).toBe('same-origin')
    })

    it('sets X-Content-Type-Options header', async () => {
      const response = await request(app).get('/test')
      
      expect(response.headers['x-content-type-options']).toBeDefined()
      expect(response.headers['x-content-type-options']).toBe('nosniff')
    })

    it('removes X-Powered-By header', async () => {
      const response = await request(app).get('/test')
      
      expect(response.headers['x-powered-by']).toBeUndefined()
    })

    it('blocks unsafe-inline in CSP', async () => {
      const response = await request(app).get('/test')
      
      const csp = response.headers['content-security-policy']
      expect(csp).toBeDefined()
      expect(csp).not.toContain('unsafe-inline')
      expect(csp).not.toContain('unsafe-eval')
    })

    it('sets frame-src to none', async () => {
      const response = await request(app).get('/test')
      
      const csp = response.headers['content-security-policy']
      expect(csp).toBeDefined()
      expect(csp).toContain("frame-src 'none'")
    })

    it('sets object-src to none', async () => {
      const response = await request(app).get('/test')
      
      const csp = response.headers['content-security-policy']
      expect(csp).toBeDefined()
      expect(csp).toContain("object-src 'none'")
    })
  })

  describe('securityHeadersWithOverride', () => {
    it('uses default headers when no override is provided', async () => {
      app.use(securityHeadersWithOverride)
      app.get('/test', (req, res) => {
        res.json({ message: 'test' })
      })

      const response = await request(app).get('/test')
      
      expect(response.headers['content-security-policy']).toBeDefined()
      expect(response.headers['strict-transport-security']).toBeDefined()
      expect(response.headers['referrer-policy']).toBeDefined()
      expect(response.headers['cross-origin-resource-policy']).toBeDefined()
    })

    it('allows disabling CSP via override', async () => {
      app.use((req, res, next) => {
        res.locals.securityHeaders = {
          contentSecurityPolicy: false,
        }
        next()
      })
      app.use(securityHeadersWithOverride)
      app.get('/test', (req, res) => {
        res.json({ message: 'test' })
      })

      const response = await request(app).get('/test')
      
      expect(response.headers['content-security-policy']).toBeUndefined()
    })

    it('allows custom CSP via override', async () => {
      app.use((req, res, next) => {
        res.locals.securityHeaders = {
          contentSecurityPolicy: {
            directives: {
              defaultSrc: ["'self'", 'https://example.com'],
            },
          },
        }
        next()
      })
      app.use(securityHeadersWithOverride)
      app.get('/test', (req, res) => {
        res.json({ message: 'test' })
      })

      const response = await request(app).get('/test')
      
      expect(response.headers['content-security-policy']).toBeDefined()
      expect(response.headers['content-security-policy']).toContain('https://example.com')
    })

    it('allows disabling HSTS via override', async () => {
      app.use((req, res, next) => {
        res.locals.securityHeaders = {
          hsts: false,
        }
        next()
      })
      app.use(securityHeadersWithOverride)
      app.get('/test', (req, res) => {
        res.json({ message: 'test' })
      })

      const response = await request(app).get('/test')
      
      expect(response.headers['strict-transport-security']).toBeUndefined()
    })

    it('allows custom HSTS via override', async () => {
      app.use((req, res, next) => {
        res.locals.securityHeaders = {
          hsts: {
            maxAge: 1800,
            includeSubDomains: false,
          },
        }
        next()
      })
      app.use(securityHeadersWithOverride)
      app.get('/test', (req, res) => {
        res.json({ message: 'test' })
      })

      const response = await request(app).get('/test')
      
      expect(response.headers['strict-transport-security']).toBeDefined()
      expect(response.headers['strict-transport-security']).toContain('max-age=1800')
    })

    it('allows custom referrer policy via override', async () => {
      app.use((req, res, next) => {
        res.locals.securityHeaders = {
          referrerPolicy: {
            policy: 'no-referrer',
          },
        }
        next()
      })
      app.use(securityHeadersWithOverride)
      app.get('/test', (req, res) => {
        res.json({ message: 'test' })
      })

      const response = await request(app).get('/test')
      
      expect(response.headers['referrer-policy']).toBeDefined()
      expect(response.headers['referrer-policy']).toBe('no-referrer')
    })

    it('allows custom CORP via override', async () => {
      app.use((req, res, next) => {
        res.locals.securityHeaders = {
          crossOriginResourcePolicy: {
            policy: 'cross-origin',
          },
        }
        next()
      })
      app.use(securityHeadersWithOverride)
      app.get('/test', (req, res) => {
        res.json({ message: 'test' })
      })

      const response = await request(app).get('/test')
      
      expect(response.headers['cross-origin-resource-policy']).toBeDefined()
      expect(response.headers['cross-origin-resource-policy']).toBe('cross-origin')
    })

    it('applies multiple overrides simultaneously', async () => {
      app.use((req, res, next) => {
        res.locals.securityHeaders = {
          contentSecurityPolicy: false,
          hsts: false,
        }
        next()
      })
      app.use(securityHeadersWithOverride)
      app.get('/test', (req, res) => {
        res.json({ message: 'test' })
      })

      const response = await request(app).get('/test')
      
      expect(response.headers['content-security-policy']).toBeUndefined()
      expect(response.headers['strict-transport-security']).toBeUndefined()
      // Other headers should still be set
      expect(response.headers['referrer-policy']).toBeDefined()
      expect(response.headers['cross-origin-resource-policy']).toBeDefined()
    })

    it('does not affect responses from routes without override', async () => {
      app.use(securityHeadersWithOverride)
      
      // Route without override
      app.get('/no-override', (req, res) => {
        res.json({ message: 'no override' })
      })

      const response = await request(app).get('/no-override')
      
      expect(response.headers['content-security-policy']).toBeDefined()
      expect(response.headers['strict-transport-security']).toBeDefined()
    })

    it('allows per-route CSP relaxation for OpenAPI docs', async () => {
      // OpenAPI docs route
      app.get('/api/docs', (req, res, next) => {
        res.locals.securityHeaders = {
          contentSecurityPolicy: {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
              styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
              imgSrc: ["'self'", "data:", "https:"],
            },
          },
        }
        next()
      })

      app.use(securityHeadersWithOverride)
      
      app.get('/api/docs', (req, res) => {
        res.json({ message: 'docs' })
      })

      // Regular API route
      app.get('/api/regular', (req, res) => {
        res.json({ message: 'regular' })
      })

      const docsResponse = await request(app).get('/api/docs')
      const regularResponse = await request(app).get('/api/regular')
      
      // Docs route should have relaxed CSP
      expect(docsResponse.headers['content-security-policy']).toContain('unsafe-inline')
      expect(docsResponse.headers['content-security-policy']).toContain('cdn.jsdelivr.net')
      
      // Regular route should have strict CSP
      expect(regularResponse.headers['content-security-policy']).not.toContain('unsafe-inline')
      expect(regularResponse.headers['content-security-policy']).not.toContain('cdn.jsdelivr.net')
    })
  })

  describe('edge cases', () => {
    it('handles large error responses correctly', async () => {
      app.use(securityHeadersMiddleware)
      app.get('/error', (req, res) => {
        const largeError = {
          error: 'Test error',
          details: 'x'.repeat(10000),
        }
        res.status(500).json(largeError)
      })

      const response = await request(app).get('/error')
      
      expect(response.status).toBe(500)
      expect(response.headers['content-security-policy']).toBeDefined()
    })

    it('handles requests with existing headers', async () => {
      app.use(securityHeadersMiddleware)
      app.get('/test', (req, res) => {
        res.setHeader('X-Custom-Header', 'custom-value')
        res.json({ message: 'test' })
      })

      const response = await request(app).get('/test')
      
      expect(response.headers['x-custom-header']).toBe('custom-value')
      expect(response.headers['content-security-policy']).toBeDefined()
    })

    it('handles middleware chain correctly', async () => {
      app.use(express.json())
      app.use(securityHeadersMiddleware)
      app.use((req, res, next) => {
        res.setHeader('X-Middleware-Test', 'passed')
        next()
      })
      app.get('/test', (req, res) => {
        res.json({ message: 'test' })
      })

      const response = await request(app).get('/test')
      
      expect(response.headers['x-middleware-test']).toBe('passed')
      expect(response.headers['content-security-policy']).toBeDefined()
    })
  })
})
