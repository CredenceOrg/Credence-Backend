import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { redirectTargetSchema } from './redirect.js'

describe('redirectTargetSchema', () => {
  const originalEnv = process.env.ADMIN_REDIRECT_ALLOWED_HOSTS

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ADMIN_REDIRECT_ALLOWED_HOSTS
    } else {
      process.env.ADMIN_REDIRECT_ALLOWED_HOSTS = originalEnv
    }
  })

  it('accepts a same-origin relative path', () => {
    const result = redirectTargetSchema.safeParse('/orgs/org-1/members')
    expect(result.success).toBe(true)
  })

  it('rejects an empty string', () => {
    const result = redirectTargetSchema.safeParse('')
    expect(result.success).toBe(false)
  })

  // Negative test: without a fix, a schema that only checked
  // `z.string().min(1)` would accept this and let it flow to res.redirect().
  it('rejects a protocol-relative open-redirect target', () => {
    const result = redirectTargetSchema.safeParse('//evil.com')
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('allow-listed host')
    }
  })

  it('rejects an absolute URL when ADMIN_REDIRECT_ALLOWED_HOSTS is unset', () => {
    delete process.env.ADMIN_REDIRECT_ALLOWED_HOSTS
    const result = redirectTargetSchema.safeParse('https://evil.com')
    expect(result.success).toBe(false)
  })

  it('accepts an absolute URL whose host is listed in ADMIN_REDIRECT_ALLOWED_HOSTS', () => {
    process.env.ADMIN_REDIRECT_ALLOWED_HOSTS = 'admin.credence.io, partner.credence.io'
    const result = redirectTargetSchema.safeParse('https://admin.credence.io/dashboard')
    expect(result.success).toBe(true)
  })

  it('rejects a host not present in ADMIN_REDIRECT_ALLOWED_HOSTS', () => {
    process.env.ADMIN_REDIRECT_ALLOWED_HOSTS = 'admin.credence.io'
    const result = redirectTargetSchema.safeParse('https://evil.com/dashboard')
    expect(result.success).toBe(false)
  })
})
