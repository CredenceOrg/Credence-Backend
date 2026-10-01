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

    it('allows a root path with no trailing segment', () => {
      expect(isSafeRedirectTarget('/')).toBe(true)
    })

    it('allows a path with a trailing slash', () => {
      expect(isSafeRedirectTarget('/dashboard/')).toBe(true)
    })

    it('allows a path with a dot-dot segment that stays root-relative', () => {
      expect(isSafeRedirectTarget('/a/b../c')).toBe(true)
    })

    it('allows a path containing a literal space', () => {
      expect(isSafeRedirectTarget('/search?q=hello world')).toBe(true)
    })

    it('allows a path containing a literal percent sign that is not a valid escape', () => {
      // %25 is a valid encoded percent sign.
      expect(isSafeRedirectTarget('/search?q=100%25')).toBe(true)
    })
  })

  describe('allow-listed absolute URLs', () => {
    it('allows an absolute https URL whose host is allow-listed', () => {
      expect(isSafeRedirectTarget('https://admin.credence.io/dashboard', ['admin.credence.io'])).toBe(true)
    })

    it('allows an absolute http URL whose host is allow-listed', () => {
      expect(isSafeRedirectTarget('http://admin.credence.io/dashboard', ['admin.credence.io'])).toBe(true)
    })

    it('allows an absolute URL whose host includes an allow-listed port', () => {
      expect(isSafeRedirectTarget('https://admin.credence.io:8443/dashboard', ['admin.credence.io:8443'])).toBe(true)
    })

    it('rejects an absolute URL whose host is not allow-listed', () => {
      expect(isSafeRedirectTarget('https://evil.com/dashboard', ['admin.credence.io'])).toBe(false)
    })

    it('rejects any absolute URL when no allowlist is configured', () => {
      expect(isSafeRedirectTarget('https://admin.credence.io/dashboard')).toBe(false)
    })

    it('rejects an absolute URL when the allowlist is empty', () => {
      expect(isSafeRedirectTarget('https://admin.credence.io/dashboard', [])).toBe(false)
    })

    it('resolves userinfo host-confusion tricks to the real host, not the trusted-looking prefix', () => {
      // A naive `url.includes('admin.credence.io')` check would be fooled by this;
      // the real target host is evil.com.
      expect(isSafeRedirectTarget('https://admin.credence.io@evil.com/', ['admin.credence.io'])).toBe(false)
    })

    it('is case-insensitive when matching the allow-listed host', () => {
      expect(isSafeRedirectTarget('https://ADMIN.CREDENCE.IO/dashboard', ['admin.credence.io'])).toBe(true)
    })

    it('is case-insensitive when the allow-listed entry is uppercase', () => {
      expect(isSafeRedirectTarget('https://admin.credence.io/dashboard', ['ADMIN.CREDENCE.IO'])).toBe(true)
    })

    it('rejects an absolute URL with a non-http(s) scheme even when the host is allow-listed', () => {
      expect(isSafeRedirectTarget('ftp://admin.credence.io/file', ['admin.credence.io'])).toBe(false)
    })

    it('rejects an absolute URL whose host differs only by a port', () => {
      expect(isSafeRedirectTarget('https://admin.credence.io:8443/x', ['admin.credence.io'])).toBe(false)
    })

    it('rejects an absolute URL whose host is a suffix of an allow-listed host', () => {
      expect(isSafeRedirectTarget('https://evil.admin.credence.io/', ['admin.credence.io'])).toBe(false)
    })

    it('rejects an absolute URL with a trailing dot host that normalizes to a non-allow-listed host', () => {
      expect(isSafeRedirectTarget('https://admin.credence.io./', ['admin.credence.io'])).toBe(false)
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

    it('rejects a target containing a literal carriage return', () => {
      expect(isSafeRedirectTarget('/foo\rbar')).toBe(false)
    })

    it('rejects a target containing a NUL byte', () => {
      expect(isSafeRedirectTarget('/foo\x00bar')).toBe(false)
    })

    it('rejects a target containing a DEL character', () => {
      expect(isSafeRedirectTarget('/foo\x7fbar')).toBe(false)
    })

    it('rejects a target containing an encoded NUL byte', () => {
      expect(isSafeRedirectTarget('/%00foo')).toBe(false)
    })

    it('rejects a target containing an encoded DEL character', () => {
      expect(isSafeRedirectTarget('/%7Ffoo')).toBe(false)
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

    it('rejects a protocol-relative URL that is encoded only in the first slash', () => {
      expect(isSafeRedirectTarget('/%2Fevil.com')).toBe(false)
    })

    it('rejects a backslash trick that is encoded', () => {
      expect(isSafeRedirectTarget('/%5Cevil.com')).toBe(false)
    })

    it('rejects a target with a leading whitespace that hides an absolute URL', () => {
      expect(isSafeRedirectTarget(' https://evil.com', ['evil.com'])).toBe(false)
    })

    it('rejects an absolute URL with an empty host', () => {
      expect(isSafeRedirectTarget('https:///dashboard', ['admin.credence.io'])).toBe(false)
    })
  })

  describe('boundary and duplicate inputs', () => {
    it('is deterministic for the same input across repeated calls', () => {
      const target = '/dashboard'
      for (let i = 0; i < 5; i++) {
        expect(isSafeRedirectTarget(target)).toBe(true)
      }
    })

    it('returns the same result for duplicate allow-list entries', () => {
      expect(
        isSafeRedirectTarget('https://admin.credence.io/x', [
          'admin.credence.io',
          'admin.credence.io',
        ])
      ).toBe(true)
    })

    it('handles a very long relative path without throwing', () => {
      const longPath = '/' + 'a'.repeat(10000)
      expect(isSafeRedirectTarget(longPath)).toBe(true)
    })

    it('handles a long allow-list without throwing', () => {
      const hosts = Array.from({ length: 1000 }, (_, i) => `host${i}.example.org`)
      hosts.push('admin.credence.io')
      expect(isSafeRedirectTarget('https://admin.credence.io/x', hosts)).toBe(true)
    })

    it('rejects a target that is just a single backslash', () => {
      expect(isSafeRedirectTarget('\\')).toBe(false)
    })

    it('rejects a target that is just a single slash-backslash pair', () => {
      expect(isSafeRedirectTarget('/\\')).toBe(false)
    })

    it('rejects a target that is just a double backslash', () => {
      expect(isSafeRedirectTarget('\\\\')).toBe(false)
    })

    it('rejects a target that is just a double slash', () => {
      expect(isSafeRedirectTarget('//')).toBe(false)
    })

    it('rejects a target that is just a protocol relative prefix with a fragment', () => {
      expect(isSafeRedirectTarget('//#evil.com')).toBe(false)
    })

    it('rejects an absolute URL with a username but no allow-listed host', () => {
      expect(isSafeRedirectTarget('https://user@evil.com/', ['evil.com'])).toBe(false)
    })

    it('rejects an absolute URL with a password and a non-allow-listed host', () => {
      expect(isSafeRedirectTarget('https://user:pass@evil.com/', ['evil.com'])).toBe(false)
    })

    it('rejects an absolute URL with a non-allow-listed host and a fragment', () => {
      expect(isSafeRedirectTarget('https://evil.com/#x', ['admin.credence.io'])).toBe(false)
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

  it('returns the target unchanged for a root path', () => {
    expect(resolveSafeRedirectTarget('/')).toBe('/')
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
    expect(appError.status).toBe400)
  })

  it('throws for a disallowed absolute host', () => {
    expect(() => resolveSafeRedirectTarget('https://evil.com', ['admin.credence.io'])).toThrow(
      UnsafeRedirectError
    )
  })

  it('throws for an absolute URL when no allowlist is configured', () => {
    expect(() => resolveSafeRedirectTarget('https://admin.credence.io/x')).toThrow(
      UnsafeRedirectError
    )
  })

  it('throws for an empty target', () => {
    expect(() => resolveSafeRedirectTarget('')).toThrow(UnsafeRedirectError)
  })

  it('throws for non-string input without losing the input type in the error context', () => {
    let caught: unknown
    try {
      resolveSafeRedirectTarget(undefined)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInceanceOf(UnsafeRedirectError)
    const appError = caught as UnsafeRedirectError
    expect(appError.code).toBe('unsafe_redirect_target')
    expect(appError.status).toBe(400)
  })

  it('preserves the original target in the error context for diagnosis', () => {
    let caught: unknown
    try {
      resolveSafeRedirectTarget('//evil.com')
    } catch (err) {
      caught = err
    }
    const appError = caught as UnsafeRedirectError
    expect(appError.context).toMatchObject({ target: '//evil.com' })
  })

  it('is deterministic for repeated calls with the same input', () => {
    const target = 'https://admin.credence.io/dashboard'
    const allowed = ['admin.credence.io']
    for (let i = 0; i < 5; i++) {
      expect(resolveSafeRedirectTarget(target, allowed)).toBe(target)
    }
  })

  it('throws for a malformed percent-encoded sequence', () => {
    expect(() => resolveSafeRedirectTarget('/%E0%80')).toThrow(UnsafeRedirectError)
  })

  it('throws for a target containing a control character', () => {
    expect(() => resolveSafeRedirectTarget('/foo\nbar')).toThrow(UnsafeRedirectError)
  })

  it('rejects a target whose allow-listed host matches only after normalization', () => {
    expect(() =>
      resolveSafeRedirectTarget('https://ADMIN.CREDENCE.IO/dashboard', ['admin.credence.io'])
    ).not.toThrow()
  })

  it('recovers: a rejected target does not mutate the allowlist or later calls', () => {
    const allowed = ['admin.credence.io']
    expect(() => resolveSafeRedirectTarget('https://evil.com/', allowed)).toThrow(
      UnsafeRedirectError
    )
    expect(allowed).toEqual(['admin.credence.io'])
    expect(resolveSafeRedirectTarget('https://admin.credence.io/x', allowed)).toBe(
      'https://admin.credence.io/x'
    )
  })

  it('recovery: a rejected target does not affect a later valid relative target', () => {
    expect(() => resolveSafeRedirectTarget('//evil.com')).toThrow(UnsafeRedirectError)
    expect(resolveSafeRedirectTarget('/dashboard')).toBe('/dashboard')
  })

  it('concurrency: parallel calls with mixed inputs produce independent results', () => {
    const inputs = [
      '/dashboard',
      '//evil.com',
      'https://admin.credence.io/x',
      'https://evil.com/x',
      '/search?q=%20hello',
      '/\\evil.com',
    ]
    const allowed = ['admin.credence.io']
    const results = inputs.map((input) => {
      try {
        return { ok: true, value: resolveSafeRedirectTarget(input, allowed) }
      } catch {
        return { ok: false, value: input }
      }
    })
    expect(results).toEqual([
      { ok: true, value: '/dashboard' },
      { ok: false, value: '//evil.com' },
      { ok: true, value: 'https://admin.credence.io/x' },
      { ok: false, value: 'https://evil.com/x' },
      { ok: true, value: '/search?q=%20hello' },
      { ok: false, value: '/\\evil.com' },
    ])
  })

  it('concurrency: a rejection in one call does not leak into a concurrent success', () => {
    const allowed = ['admin.credence.io']
    const results = Promise.all([
      Promise.resolve().then(() => {
        try {
          return resolveSafeRedirectTarget('//evil.com', allowed)
        } catch {
          return 'rejected'
        }
      }),
      Promise.resolve().then(() => resolveSafeRedirectTarget('/dashboard', allowed)),
    ])
    return expect(results).resolves.toEqual(['rejected', '/dashboard'])
  })
})
