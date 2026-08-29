import { describe, it, expect } from 'vitest'
import { isSafeRedirectTarget, resolveSafeRedirectTarget } from './safeRedirect.js'
import { UnsafeRedirectError } from './errors.js'

describe('isSafeRedirectTarget', () => {
  describe('safe relative paths', () => {
    it('allows a plain root-relative path', () => {
      expect(isSafeRedirectTarget('/dashboard')).toBe(true)
    })

    it('allows a relative path with query string and fragment', () => {
      expect(isSafeRedirectTarget('/orgs/org-1/members?page=2#top')).toBe(true)
    })

    it('allows a relative path containing an encoded (non-control) character', () => {
      expect(isSafeRedirectTarget('/search?q=%20hello')).toBe(true)
    })
  })

  describe('allow-listed absolute URLs', () => {
    it('allows an absolute https URL whose host is allow-listed', () => {
      expect(isSafeRedirectTarget('https://admin.credence.io/dashboard', ['admin.credence.io'])).toBe(true)
    })

    it('rejects an absolute URL whose host is not allow-listed', () => {
      expect(isSafeRedirectTarget('https://evil.com/dashboard', ['admin.credence.io'])).toBe(false)
    })

    it('rejects any absolute URL when no allowlist is configured', () => {
      expect(isSafeRedirectTarget('https://admin.credence.io/dashboard')).toBe(false)
    })

    it('resolves userinfo host-confusion tricks to the real host, not the trusted-looking prefix', () => {
      // A naive `url.includes('admin.credence.io')` check would be fooled by this;
      // the real target host is evil.com.
      expect(isSafeRedirectTarget('https://admin.credence.io@evil.com/', ['admin.credence.io'])).toBe(false)
    })

    it('is case-insensitive when matching the allow-listed host', () => {
      expect(isSafeRedirectTarget('https://ADMIN.CREDENCE.IO/dashboard', ['admin.credence.io'])).toBe(true)
    })
  })

  describe('open-redirect attack vectors (negative cases)', () => {
    it('rejects a protocol-relative URL (//evil.com)', () => {
      expect(isSafeRedirectTarget('//evil.com', ['admin.credence.io'])).toBe(false)
    })

    it('rejects a triple-slash URL (///evil.com)', () => {
      expect(isSafeRedirectTarget('///evil.com')).toBe(false)
    })

    it('rejects the backslash-as-slash trick (/\\evil.com)', () => {
      expect(isSafeRedirectTarget('/\\evil.com')).toBe(false)
    })

    it('rejects a leading double backslash (\\\\evil.com)', () => {
      expect(isSafeRedirectTarget('\\\\evil.com')).toBe(false)
    })

    it('rejects a double-encoded protocol-relative URL (/%2F%2Fevil.com)', () => {
      expect(isSafeRedirectTarget('/%2F%2Fevil.com')).toBe(false)
    })

    it('rejects a javascript: URI', () => {
      expect(isSafeRedirectTarget('javascript:alert(document.domain)')).toBe(false)
    })

    it('rejects a data: URI', () => {
      expect(isSafeRedirectTarget('data:text/html,<script>alert(1)</script>')).toBe(false)
    })

    it('rejects a target containing a literal tab character (WHATWG tab-stripping bypass)', () => {
      expect(isSafeRedirectTarget('/\t/evil.com')).toBe(false)
    })

    it('rejects a target containing an encoded tab that decodes to a protocol-relative prefix', () => {
      expect(isSafeRedirectTarget('/%09/evil.com')).toBe(false)
    })

    it('rejects a target containing a literal newline', () => {
      expect(isSafeRedirectTarget('/foo\nbar')).toBe(false)
    })

    it('rejects an empty string', () => {
      expect(isSafeRedirectTarget('')).toBe(false)
    })

    it('rejects non-string input', () => {
      expect(isSafeRedirectTarget(undefined)).toBe(false)
      expect(isSafeRedirectTarget(null)).toBe(false)
      expect(isSafeRedirectTarget(123)).toBe(false)
      expect(isSafeRedirectTarget(['/dashboard'])).toBe(false)
    })

    it('rejects a malformed percent-encoded sequence instead of throwing', () => {
      expect(isSafeRedirectTarget('/%E0%80')).toBe(false)
    })

    it('rejects a relative path that does not start with a slash', () => {
      expect(isSafeRedirectTarget('dashboard')).toBe(false)
    })
  })
})

describe('resolveSafeRedirectTarget', () => {
  it('returns the target unchanged when safe', () => {
    expect(resolveSafeRedirectTarget('/dashboard')).toBe('/dashboard')
  })

  it('returns an allow-listed absolute URL unchanged', () => {
    expect(resolveSafeRedirectTarget('https://admin.credence.io/x', ['admin.credence.io'])).toBe(
      'https://admin.credence.io/x'
    )
  })

  it('throws UnsafeRedirectError for a protocol-relative target', () => {
    expect(() => resolveSafeRedirectTarget('//evil.com')).toThrow(UnsafeRedirectError)
  })

  it('surfaces a typed, catalog-backed error rather than a generic error', () => {
    let caught: unknown
    try {
      resolveSafeRedirectTarget('//evil.com')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(UnsafeRedirectError)
    const appError = caught as UnsafeRedirectError
    expect(appError.code).toBe('unsafe_redirect_target')
    expect(appError.status).toBe(400)
  })

  it('throws for a disallowed absolute host', () => {
    expect(() => resolveSafeRedirectTarget('https://evil.com', ['admin.credence.io'])).toThrow(
      UnsafeRedirectError
    )
  })
})
