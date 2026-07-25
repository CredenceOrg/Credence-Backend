import { describe, it, expect } from 'vitest'
import express, { type Request, type Response, type NextFunction } from 'express'
import request from 'supertest'
import { ipMatchesAnyCidr, createCidrWhitelistMiddleware } from '../cidrWhitelist.js'

describe('ipMatchesAnyCidr', () => {
  it('matches IP within a /16 CIDR', () => {
    expect(ipMatchesAnyCidr('192.168.1.5', ['192.168.0.0/16'])).toBe(true)
  })

  it('does not match IP outside CIDR', () => {
    expect(ipMatchesAnyCidr('10.0.0.1', ['192.168.0.0/16'])).toBe(false)
  })

  it('matches exact /32 CIDR', () => {
    expect(ipMatchesAnyCidr('10.0.0.1', ['10.0.0.1/32'])).toBe(true)
  })

  it('does not match /32 CIDR with different IP', () => {
    expect(ipMatchesAnyCidr('10.0.0.2', ['10.0.0.1/32'])).toBe(false)
  })

  it('matches IP in first CIDR of multiple', () => {
    expect(ipMatchesAnyCidr('172.16.5.1', ['192.168.0.0/16', '172.16.0.0/12'])).toBe(true)
  })

  it('matches IP in last CIDR of multiple', () => {
    expect(ipMatchesAnyCidr('192.168.5.1', ['10.0.0.0/8', '192.168.0.0/16'])).toBe(true)
  })

  it('returns false for empty CIDR list', () => {
    expect(ipMatchesAnyCidr('192.168.1.1', [])).toBe(false)
  })

  it('returns false for non-IPv4 input', () => {
    expect(ipMatchesAnyCidr('::1', ['127.0.0.0/8'])).toBe(false)
    expect(ipMatchesAnyCidr('unknown', ['127.0.0.0/8'])).toBe(false)
  })

  it('handles /8 CIDR', () => {
    expect(ipMatchesAnyCidr('10.255.255.255', ['10.0.0.0/8'])).toBe(true)
    expect(ipMatchesAnyCidr('11.0.0.0', ['10.0.0.0/8'])).toBe(false)
  })

  it('handles /0 CIDR (matches everything)', () => {
    expect(ipMatchesAnyCidr('1.2.3.4', ['0.0.0.0/0'])).toBe(true)
  })

  it('handles invalid CIDR format gracefully', () => {
    expect(ipMatchesAnyCidr('10.0.0.1', ['not-a-cidr'])).toBe(false)
    expect(ipMatchesAnyCidr('10.0.0.1', ['10.0.0.0/99'])).toBe(false)
    expect(ipMatchesAnyCidr('10.0.0.1', ['10.0.0.0'])).toBe(false)
  })
})

describe('createCidrWhitelistMiddleware', () => {
  function createAppWithIp(cidrs: string[], fakeIp: string) {
    const app = express()
    app.use((_req: Request, _res: Response, next: NextFunction) => {
      Object.defineProperty(_req, 'ip', { value: fakeIp, configurable: true })
      next()
    })
    app.get('/metrics', createCidrWhitelistMiddleware(cidrs), (_req, res) => {
      res.json({ ok: true })
    })
    return app
  }

  it('allows request from allowed CIDR', async () => {
    const app = createAppWithIp(['192.168.0.0/16'], '192.168.1.100')
    const res = await request(app).get('/metrics')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('blocks request from disallowed CIDR', async () => {
    const app = createAppWithIp(['192.168.0.0/16'], '10.0.0.1')
    const res = await request(app).get('/metrics')
    expect(res.status).toBe(403)
    expect(res.body.error).toContain('not accessible')
  })

  it('allows localhost when 127.0.0.0/8 is allowed', async () => {
    const app = createAppWithIp(['127.0.0.0/8'], '127.0.0.1')
    const res = await request(app).get('/metrics')
    expect(res.status).toBe(200)
  })

  it('blocks localhost when not in allowed CIDRs', async () => {
    const app = createAppWithIp(['10.0.0.0/8'], '127.0.0.1')
    const res = await request(app).get('/metrics')
    expect(res.status).toBe(403)
  })
})
