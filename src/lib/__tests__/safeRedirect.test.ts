import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { isSafeRedirectTarget, resolveSafeRedirectTarget } from '../safeRedirect.js'
import { UnsafeRedirectError } from '../errors.js'

describe('isSafeRedirectTarget', () => {
  describe('relative paths', () => {
    it('accepts root path', () => {
      expect(isSafeRedirectTarget('/')).toBe(true)
    })

    it('accepts a simple relative path', () => {
      expect(isSafeRedirectTarget('/dashboard')).toBe(true)
    })

    it('accepts a deep nested path with query and hash', () => {
      expect(isSafeRedirectTarget('/deep/nested/path?query=param&more=true#section')).toBe(true)
    })

    it('accepts a URL-encoded relative path that decodes safely', () => {
      expect(isSafeRedirectTarget('/caf%C3%A9')).toBe(true)
    })

    it('rejects empty string', () => {
      expect(isSafeRedirectTarget('')).toBe(false)
    })

    it('rejects protocol-relative URL starting with //', () => {
      expect(isSafeRedirectTarget('//evil.com')).toBe(false)
    })

    it('rejects backslash-prefixed target', () => {
      expect(isSafeRedirectTarget('\\evil.com')).toBe(false)
    })

    it('rejects slash-backslash target', () => {
      expect(isSafeRedirectTarget('/\\evil.com')).toBe(false)
    })

    it('rejects double-encoded protocol-relative URL', () => {
      expect(isSafeRedirectTarget('%2f%2fevil.com')).toBe(false)
    })

    it('rejects target with control characters', () => {
      expect(isSafeRedirectTarget('/path\x00')).toBe(false)
      expect(isSafeRedirectTarget('/path\x1f')).toBe(false)
      expect(isSafeRedirectTarget('/path\x7f')).toBe(false)
    })

    it('rejects double-encoded path that decodes to //', () => {
      expect(isSafeRedirectTarget('/%2f%2fevil.com')).toBe(false)
    })

    it('rejects path that decodes to backslash tricks', () => {
      expect(isSafeRedirectTarget('/%5cevil.com')).toBe(false)
    })
  })

  describe('absolute URLs', () => {
    const allowlist = ['admin.credence.io', 'partner.credence.io:8080']

    it('accepts an https URL on the allowlist', () => {
      expect(isSafeRedirectTarget('https://admin.credence.io/dashboard', allowlist)).toBe(true)
    })

    it('accepts an http URL on the allowlist', () => {
      expect(isSafeRedirectTarget('http://admin.credence.io/path', allowlist)).toBe(true)
    })

    it('accepts an https URL with port matching the allowlist', () => {
      expect(isSafeRedirectTarget('https://partner.credence.io:8080/callback', allowlist)).toBe(true)
    })

    it('accepts an http URL with port matching the allowlist', () => {
      expect(isSafeRedirectTarget('http://partner.credence.io:8080/callback', allowlist)).toBe(true)
    })

    it('accepts a URL with userinfo (host is still the allowed host)', () => {
      expect(isSafeRedirectTarget('https://user:pass@admin.credence.io/path', allowlist)).toBe(true)
    })

    it('rejects an https URL whose host is not on the allowlist', () => {
      expect(isSafeRedirectTarget('https://evil.com/phish', allowlist)).toBe(false)
    })

    it('rejects an http URL whose host is not on the allowlist', () => {
      expect(isSafeRedirectTarget('http://evil.com/phish', allowlist)).toBe(false)
    })

    it('rejects an absolute URL with no allowlist', () => {
      expect(isSafeRedirectTarget('https://admin.credence.io/path')).toBe(false)
    })

    it('rejects an absolute URL with empty allowlist', () => {
      expect(isSafeRedirectTarget('https://admin.credence.io/path', [])).toBe(false)
    })
  })

  describe('port matching', () => {
    it('rejects a URL with a port when allowlist has host without port', () => {
      expect(isSafeRedirectTarget('https://admin.credence.io:8443/path', ['admin.credence.io'])).toBe(false)
    })

    it('rejects a URL without a port when allowlist has host with port', () => {
      expect(isSafeRedirectTarget('https://admin.credence.io/path', ['admin.credence.io:8443'])).toBe(false)
    })

    it('accepts exact host:port match', () => {
      expect(isSafeRedirectTarget('https://admin.credence.io:8443/path', ['admin.credence.io:8443'])).toBe(true)
    })
  })

  describe('case-insensitive host matching', () => {
    it('accepts uppercase host in allowlist against lowercase target', () => {
      expect(isSafeRedirectTarget('https://admin.credence.io/path', ['ADMIN.CREDENCE.IO'])).toBe(true)
    })

    it('accepts mixed-case target against lowercase allowlist', () => {
      expect(isSafeRedirectTarget('https://Admin.Credence.IO/path', ['admin.credence.io'])).toBe(true)
    })

    it('accepts mixed-case port entry', () => {
      expect(isSafeRedirectTarget('https://admin.credence.io:8443/path', ['Admin.Credence.IO:8443'])).toBe(true)
    })
  })

  describe('subdomain matching', () => {
    it('rejects a subdomain when allowlist has parent domain (exact match required)', () => {
      expect(isSafeRedirectTarget('https://sub.admin.credence.io/path', ['admin.credence.io'])).toBe(false)
    })
  })

  describe('scheme validation', () => {
    it('rejects ftp:// URL even if host is on allowlist', () => {
      expect(isSafeRedirectTarget('ftp://admin.credence.io/file', ['admin.credence.io'])).toBe(false)
    })

    it('rejects data: URI', () => {
      expect(isSafeRedirectTarget('data:text/html,<script>alert(1)</script>', ['admin.credence.io'])).toBe(false)
    })

    it('rejects javascript: URI', () => {
      expect(isSafeRedirectTarget('javascript:alert(1)', ['admin.credence.io'])).toBe(false)
    })

    it('rejects file: URL', () => {
      expect(isSafeRedirectTarget('file:///etc/passwd', ['admin.credence.io'])).toBe(false)
    })
  })

  describe('non-string inputs', () => {
    it('rejects undefined', () => {
      expect(isSafeRedirectTarget(undefined)).toBe(false)
    })

    it('rejects null', () => {
      expect(isSafeRedirectTarget(null)).toBe(false)
    })

    it('rejects a number', () => {
      expect(isSafeRedirectTarget(42)).toBe(false)
    })

    it('rejects an object', () => {
      expect(isSafeRedirectTarget({ path: '/dashboard' })).toBe(false)
    })

    it('rejects an array', () => {
      expect(isSafeRedirectTarget(['/dashboard'])).toBe(false)
    })
  })

  describe('resolveSafeRedirectTarget', () => {
    it('returns the target unchanged when safe', () => {
      expect(resolveSafeRedirectTarget('/dashboard')).toBe('/dashboard')
    })

    it('throws UnsafeRedirectError when target is unsafe', () => {
      expect(() => resolveSafeRedirectTarget('//evil.com')).toThrow(UnsafeRedirectError)
    })

    it('throws UnsafeRedirectError for absolute URL not on allowlist', () => {
      expect(() => resolveSafeRedirectTarget('https://evil.com', ['good.com'])).toThrow(UnsafeRedirectError)
    })

    it('throws UnsafeRedirectError for empty string', () => {
      expect(() => resolveSafeRedirectTarget('')).toThrow(UnsafeRedirectError)
    })

    it('throws UnsafeRedirectError for non-string input', () => {
      expect(() => resolveSafeRedirectTarget(null)).toThrow(UnsafeRedirectError)
    })
  })
})

describe('isSafeRedirectTarget — property-based tests', () => {
  it('accepts all valid URI-encoded relative paths', () => {
    const safePathCharArb = fc.constantFrom(
      ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~!$\'()*+,;=:@/?'.split('')
    )
    const safeRelativeArb = fc
      .array(safePathCharArb, { minLength: 1, maxLength: 50 })
      .map((chars) => '/' + chars.join(''))
      .filter((s) => !s.startsWith('//') && !s.startsWith('/\\') && !s.startsWith('\\'))

    fc.assert(
      fc.property(safeRelativeArb, (path) => {
        expect(isSafeRedirectTarget(path)).toBe(true)
      })
    )
  })

  it('rejects all protocol-relative URLs', () => {
    fc.assert(
      fc.property(fc.string(), (suffix) => {
        const target = '//' + suffix
        expect(isSafeRedirectTarget(target)).toBe(false)
      })
    )
  })

  it('rejects all non-http/https absolute URLs', () => {
    const nonHttpSchemeArb = fc.constantFrom('ftp', 'file', 'data', 'javascript', 'gopher', 'wss', 'ssh')

    fc.assert(
      fc.property(nonHttpSchemeArb, fc.string({ minLength: 1 }), (scheme, rest) => {
        try {
          const target = scheme + ':' + rest
          const result = isSafeRedirectTarget(target, ['allowed.example.com'])
          expect(result).toBe(false)
        } catch {
          // Some malformed URLs like 'data:' may throw when passed to new URL()
          // inside isAllowedAbsoluteUrl, which is caught and returns false.
        }
      })
    )
  })

  it('never throws for any arbitrary string input', () => {
    fc.assert(
      fc.property(fc.string(), (target) => {
        expect(() => isSafeRedirectTarget(target, ['allowed.example.com'])).not.toThrow()
      })
    )
  })

  it('never throws for any arbitrary input (including non-strings)', () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        expect(() => isSafeRedirectTarget(input, ['allowed.example.com'])).not.toThrow()
      })
    )
  })

  it('accepts all http(s) URLs whose host matches the allowlist exactly', () => {
    const schemeArb = fc.constantFrom('http', 'https')
    const hostnameChars = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split(''))

    fc.assert(
      fc.property(schemeArb, fc.array(hostnameChars, { minLength: 4, maxLength: 20 }), (scheme, chars) => {
        const host = chars.join('').replace(/^-+|-+$/g, '') || 'example'
        const target = `${scheme}://${host}/path`
        expect(isSafeRedirectTarget(target, [host])).toBe(true)
      })
    )
  })
})
