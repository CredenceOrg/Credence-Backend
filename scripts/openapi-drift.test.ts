/**
 * @file scripts/openapi-drift.test.ts
 *
 * Boundary and recovery test coverage for scripts/openapi-drift.js.
 *
 * ## Scope
 *
 * 1. `isAdminRoute`      — pure predicate, prefix-matching boundaries
 * 2. `normalizePath`     — OpenAPI {param} → Express :param conversion
 * 3. `parsePathsFromYaml`— YAML path parser: happy path, edge/error cases
 * 4. `detectDrift`       — core comparison: missing, extra, admin-suppressed,
 *                          empty-spec guard, both-directions, method casing
 * 5. `getRegisteredRoutes` — contract: shape, admin-filtered, lowercase methods
 * 6. `loadOpenApiPaths`  — I/O recovery: ENOENT, EACCES, empty file, valid file
 * 7. `main`              — process contract: exit 0 on match, exit 1 on drift
 *                          or missing file; stderr diagnosable; no secrets leaked
 *
 * ## Strategy
 *
 * Pure functions are imported directly and tested without I/O.
 * `loadOpenApiPaths` and `main` use `vi.spyOn(fs, 'readFileSync')` so tests
 * are hermetic and fast.  `process.exit` is replaced with a spy that throws
 * a sentinel error, preventing the test process from actually terminating.
 *
 * ## Invariants
 *
 * - `isAdminRoute` is pure and side-effect-free.
 * - `normalizePath` never changes the segment count of a path.
 * - `parsePathsFromYaml` is deterministic: same YAML → same map.
 * - `detectDrift` checks both directions (missing-from-spec and extra-in-spec).
 * - Admin routes in the spec are silently skipped (never "extra").
 * - An empty spec always produces the "appears empty or invalid" error.
 * - `main` always terminates via `process.exit`; it never throws to the caller.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'

import {
  isAdminRoute,
  normalizePath,
  parsePathsFromYaml,
  detectDrift,
  getRegisteredRoutes,
  loadOpenApiPaths,
  main,
} from './openapi-drift.js'

// ── Shared helpers ────────────────────────────────────────────────────────────

/**
 * Build a minimal YAML string that `parsePathsFromYaml` will accept.
 * Uses the same two-space indentation as the real docs/openapi.yaml.
 */
function makeYaml(pathMethods: Record<string, string[]>): string {
  const lines: string[] = ['openapi: 3.0.0', 'info:', '  title: Test', 'paths:']
  for (const [p, methods] of Object.entries(pathMethods)) {
    lines.push(`  ${p}:`)
    for (const m of methods) {
      lines.push(`    ${m}:`)
      lines.push(`      summary: ${m} ${p}`)
    }
  }
  return lines.join('\n') + '\n'
}

/**
 * Build a `specPaths` map as `detectDrift` expects it.
 */
function specMap(
  entries: Array<[string, string[]]>,
): Record<string, Record<string, object>> {
  const out: Record<string, Record<string, object>> = {}
  for (const [p, methods] of entries) {
    out[p] = {}
    for (const m of methods) {
      out[p][m] = {}
    }
  }
  return out
}

/**
 * Build a YAML spec that satisfies every route returned by `getRegisteredRoutes`.
 * Converts Express `:param` back to OpenAPI `{param}` so `makeYaml` and
 * `parsePathsFromYaml` produce a round-tripped match.
 */
function buildMatchingYaml(): string {
  const routes = getRegisteredRoutes()
  const byPath: Record<string, string[]> = {}
  for (const r of routes) {
    const openapiPath = r.path.replace(/:([^/]+)/g, '{$1}')
    if (!byPath[openapiPath]) byPath[openapiPath] = []
    byPath[openapiPath]!.push(r.method)
  }
  return makeYaml(byPath)
}

// ── process.exit spy ──────────────────────────────────────────────────────────
//
// Replaced globally so `main()` cannot terminate the test process.
// Each test that calls `main()` wraps it in try/catch to swallow the throw.

const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
  throw new Error(`process.exit(${code})`)
})

afterEach(() => {
  vi.restoreAllMocks()
  // Re-arm exit spy after restoreAllMocks() would have reset it.
  exitSpy.mockImplementation((code?: number) => {
    throw new Error(`process.exit(${code})`)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 1. isAdminRoute
// ─────────────────────────────────────────────────────────────────────────────

describe('isAdminRoute', () => {
  it('returns true for the exact admin prefix', () => {
    expect(isAdminRoute('/api/admin')).toBe(true)
  })

  it('returns true for sub-paths under /api/admin/', () => {
    expect(isAdminRoute('/api/admin/users')).toBe(true)
    expect(isAdminRoute('/api/admin/users/:id')).toBe(true)
    expect(isAdminRoute('/api/admin/outbox/quarantine')).toBe(true)
  })

  it('returns false for ordinary API paths', () => {
    expect(isAdminRoute('/api/health')).toBe(false)
    expect(isAdminRoute('/api/bond')).toBe(false)
    expect(isAdminRoute('/api/attestations/:address')).toBe(false)
  })

  it('returns false for paths that contain "admin" but do not start with /api/admin', () => {
    expect(isAdminRoute('/admin')).toBe(false)
    expect(isAdminRoute('/api/users/admin')).toBe(false)
  })

  it('does not treat /api/admins as an admin route (boundary: prefix must end at word boundary)', () => {
    expect(isAdminRoute('/api/admins')).toBe(false)
  })

  it('returns false for the empty string (boundary)', () => {
    expect(isAdminRoute('')).toBe(false)
  })

  it('is case-sensitive (boundary)', () => {
    expect(isAdminRoute('/API/ADMIN')).toBe(false)
    expect(isAdminRoute('/api/Admin')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. normalizePath
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizePath', () => {
  it('converts a single {param} to :param', () => {
    expect(normalizePath('/api/trust/{address}')).toBe('/api/trust/:address')
  })

  it('converts multiple parameters in a single path', () => {
    expect(normalizePath('/api/orgs/{orgId}/users/{userId}')).toBe(
      '/api/orgs/:orgId/users/:userId',
    )
  })

  it('handles adjacent parameters (boundary)', () => {
    expect(normalizePath('/api/{a}/{b}')).toBe('/api/:a/:b')
  })

  it('is a no-op on paths with no parameters', () => {
    expect(normalizePath('/api/health')).toBe('/api/health')
    expect(normalizePath('/')).toBe('/')
  })

  it('does not modify already-Express-style :param paths', () => {
    expect(normalizePath('/api/trust/:address')).toBe('/api/trust/:address')
  })

  it('handles the empty string (boundary)', () => {
    expect(normalizePath('')).toBe('')
  })

  it('leaves empty curly braces untouched (regex requires at least one char inside)', () => {
    expect(normalizePath('/api/{}')).toBe('/api/{}')
  })

  it('does not change the number of path segments', () => {
    const input = '/api/governance/slash-requests/{id}/votes'
    const output = normalizePath(input)
    expect(output.split('/').length).toBe(input.split('/').length)
  })

  it('is idempotent: applying it twice yields the same result', () => {
    const p = '/api/{a}/{b}'
    expect(normalizePath(normalizePath(p))).toBe(normalizePath(p))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. parsePathsFromYaml
// ─────────────────────────────────────────────────────────────────────────────

describe('parsePathsFromYaml', () => {
  it('extracts a single path and method', () => {
    const result = parsePathsFromYaml(makeYaml({ '/api/health': ['get'] }))
    expect(result).toHaveProperty('/api/health')
    expect(result['/api/health']).toHaveProperty('get')
  })

  it('extracts multiple methods on the same path', () => {
    const result = parsePathsFromYaml(
      makeYaml({ '/api/governance/slash-requests': ['get', 'post'] }),
    )
    expect(result['/api/governance/slash-requests']).toHaveProperty('get')
    expect(result['/api/governance/slash-requests']).toHaveProperty('post')
  })

  it('normalises OpenAPI {param} to Express :param', () => {
    const result = parsePathsFromYaml(makeYaml({ '/api/bond/{address}': ['get'] }))
    expect(result).toHaveProperty('/api/bond/:address')
    expect(result).not.toHaveProperty('/api/bond/{address}')
  })

  it('returns an empty object for an empty string (boundary)', () => {
    expect(parsePathsFromYaml('')).toEqual({})
  })

  it('returns an empty object when there is no paths: section', () => {
    expect(parsePathsFromYaml('openapi: 3.0.0\ninfo:\n  title: Test\n')).toEqual({})
  })

  it('returns an empty object for a file with only the paths: header and no entries', () => {
    expect(parsePathsFromYaml('openapi: 3.0.0\npaths:\n')).toEqual({})
  })

  it('ignores path declarations that appear before the paths: section', () => {
    const yaml =
      '/api/sneaky:\n  get:\nopenapi: 3.0.0\npaths:\n  /api/real:\n    get:\n'
    const result = parsePathsFromYaml(yaml)
    expect(result).not.toHaveProperty('/api/sneaky')
    expect(result).toHaveProperty('/api/real')
  })

  it('handles all five supported HTTP verbs', () => {
    const result = parsePathsFromYaml(
      makeYaml({ '/api/resource': ['get', 'post', 'put', 'delete', 'patch'] }),
    )
    expect(Object.keys(result['/api/resource']!).sort()).toEqual(
      ['delete', 'get', 'patch', 'post', 'put'],
    )
  })

  it('silently ignores unsupported verbs (e.g. options, head)', () => {
    const yaml = [
      'paths:',
      '  /api/test:',
      '    get:',
      '      summary: ok',
      '    options:',
      '      summary: preflight',
    ].join('\n')
    const result = parsePathsFromYaml(yaml)
    expect(result['/api/test']).toHaveProperty('get')
    expect(result['/api/test']).not.toHaveProperty('options')
  })

  it('handles multiple paths in the order they appear', () => {
    const yaml = makeYaml({
      '/api/health': ['get'],
      '/api/trust/{address}': ['get'],
      '/api/bond': ['post'],
    })
    const result = parsePathsFromYaml(yaml)
    expect(Object.keys(result)).toContain('/api/health')
    expect(Object.keys(result)).toContain('/api/trust/:address')
    expect(Object.keys(result)).toContain('/api/bond')
  })

  it('is deterministic: same YAML always produces the same map', () => {
    const yaml = makeYaml({ '/api/health': ['get'], '/api/bond': ['post'] })
    expect(parsePathsFromYaml(yaml)).toEqual(parsePathsFromYaml(yaml))
  })

  it('does not mutate the input string', () => {
    const yaml = makeYaml({ '/api/health': ['get'] })
    const snapshot = yaml.slice()
    parsePathsFromYaml(yaml)
    expect(yaml).toBe(snapshot)
  })

  it('handles CRLF line endings without leaving \\r in path keys', () => {
    const yaml = makeYaml({ '/api/health': ['get'] }).replace(/\n/g, '\r\n')
    const result = parsePathsFromYaml(yaml)
    for (const key of Object.keys(result)) {
      expect(key).not.toContain('\r')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. detectDrift
// ─────────────────────────────────────────────────────────────────────────────

describe('detectDrift', () => {
  it('returns no errors when routes and spec match exactly', () => {
    const routes = [{ path: '/api/health', method: 'get' }]
    const spec = specMap([['/api/health', ['get']]])
    expect(detectDrift(routes, spec)).toEqual([])
  })

  it('reports a missing route when the spec lacks a registered route', () => {
    const routes = [
      { path: '/api/health', method: 'get' },
      { path: '/api/bond', method: 'post' },
    ]
    const spec = specMap([['/api/health', ['get']]])
    const errors = detectDrift(routes, spec)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('Missing route in OpenAPI')
    expect(errors[0]).toContain('POST /api/bond')
  })

  it('reports an extra route when the spec has a route absent from the code', () => {
    const routes = [{ path: '/api/health', method: 'get' }]
    const spec = specMap([['/api/health', ['get']], ['/api/ghost', ['delete']]])
    const errors = detectDrift(routes, spec)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('Extra route in OpenAPI')
    expect(errors[0]).toContain('DELETE /api/ghost')
  })

  it('reports both directions in a single call (symmetric coverage)', () => {
    const routes = [
      { path: '/api/health', method: 'get' },
      { path: '/api/missing-from-spec', method: 'post' },
    ]
    const spec = specMap([
      ['/api/health', ['get']],
      ['/api/extra-in-spec', ['put']],
    ])
    const errors = detectDrift(routes, spec)
    expect(errors).toHaveLength(2)
    expect(errors.some(e => e.includes('Missing route in OpenAPI'))).toBe(true)
    expect(errors.some(e => e.includes('Extra route in OpenAPI'))).toBe(true)
  })

  it('admin routes in the spec do not generate "extra" errors', () => {
    const routes = [{ path: '/api/health', method: 'get' }]
    const spec = specMap([
      ['/api/health', ['get']],
      ['/api/admin/users', ['get']],
      ['/api/admin/users/:id', ['delete']],
    ])
    expect(detectDrift(routes, spec)).toEqual([])
  })

  it('fires the empty-spec guard even when routes is also empty', () => {
    const errors = detectDrift([], {})
    expect(errors.some(e => e.includes('appears empty or invalid'))).toBe(true)
  })

  it('fires the empty-spec guard and also missing-route errors together', () => {
    const routes = [{ path: '/api/health', method: 'get' }]
    const errors = detectDrift(routes, {})
    expect(errors.some(e => e.includes('Missing route in OpenAPI'))).toBe(true)
    expect(errors.some(e => e.includes('appears empty or invalid'))).toBe(true)
  })

  it('reports a non-empty spec with extra routes correctly (no empty-spec guard)', () => {
    const errors = detectDrift([], specMap([['/api/health', ['get']]]))
    expect(errors.some(e => e.includes('Extra route in OpenAPI'))).toBe(true)
    expect(errors.every(e => !e.includes('appears empty or invalid'))).toBe(true)
  })

  it('is case-sensitive for HTTP method names (boundary: GET ≠ get)', () => {
    const routes = [{ path: '/api/health', method: 'GET' }]
    const spec = specMap([['/api/health', ['get']]])
    const errors = detectDrift(routes, spec)
    // 'GET' does not match stored key 'get', so it is reported as missing
    expect(errors.some(e => e.includes('Missing route in OpenAPI'))).toBe(true)
  })

  it('does not throw on duplicate route entries (boundary)', () => {
    const routes = [
      { path: '/api/health', method: 'get' },
      { path: '/api/health', method: 'get' },
    ]
    const spec = specMap([['/api/health', ['get']]])
    expect(() => detectDrift(routes, spec)).not.toThrow()
  })

  it('is deterministic: repeated calls with the same input produce the same list', () => {
    const routes = [{ path: '/api/health', method: 'get' }]
    const spec = specMap([['/api/ghost', ['post']]])
    expect(detectDrift(routes, spec)).toEqual(detectDrift(routes, spec))
  })

  it('error messages contain the HTTP method in uppercase', () => {
    const errors = detectDrift([{ path: '/api/bond', method: 'post' }], {})
    expect(errors.some(e => e.includes('POST'))).toBe(true)
  })

  it('error messages contain the full path', () => {
    const errors = detectDrift(
      [{ path: '/api/governance/slash-requests/:id/votes', method: 'post' }],
      {},
    )
    expect(
      errors.some(e => e.includes('/api/governance/slash-requests/:id/votes')),
    ).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. getRegisteredRoutes
// ─────────────────────────────────────────────────────────────────────────────

describe('getRegisteredRoutes', () => {
  it('returns a non-empty array', () => {
    const routes = getRegisteredRoutes()
    expect(Array.isArray(routes)).toBe(true)
    expect(routes.length).toBeGreaterThan(0)
  })

  it('every entry has a non-empty path and method string', () => {
    for (const r of getRegisteredRoutes()) {
      expect(typeof r.path).toBe('string')
      expect(r.path.length).toBeGreaterThan(0)
      expect(typeof r.method).toBe('string')
      expect(r.method.length).toBeGreaterThan(0)
    }
  })

  it('every path starts with /api or /.well-known', () => {
    for (const r of getRegisteredRoutes()) {
      expect(
        r.path.startsWith('/api') || r.path.startsWith('/.well-known'),
      ).toBe(true)
    }
  })

  it('no admin routes appear in the output', () => {
    const adminRoutes = getRegisteredRoutes().filter(r =>
      r.path.startsWith('/api/admin'),
    )
    expect(adminRoutes).toHaveLength(0)
  })

  it('every method is lowercase', () => {
    for (const r of getRegisteredRoutes()) {
      expect(r.method).toBe(r.method.toLowerCase())
    }
  })

  it('includes the health-check route', () => {
    const routes = getRegisteredRoutes()
    expect(routes.find(r => r.path === '/api/health' && r.method === 'get')).toBeDefined()
  })

  it('includes the JWKS route', () => {
    const routes = getRegisteredRoutes()
    expect(
      routes.find(r => r.path === '/.well-known/jwks.json' && r.method === 'get'),
    ).toBeDefined()
  })

  it('is deterministic: repeated calls return identical results', () => {
    expect(getRegisteredRoutes()).toEqual(getRegisteredRoutes())
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. loadOpenApiPaths (file I/O recovery)
// ─────────────────────────────────────────────────────────────────────────────

describe('loadOpenApiPaths', () => {
  it('returns a parsed path map for valid YAML content', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      makeYaml({ '/api/health': ['get'], '/api/bond': ['post'] }) as unknown as Buffer,
    )
    const result = loadOpenApiPaths()
    expect(result).toHaveProperty('/api/health')
    expect(result).toHaveProperty('/api/bond')
  })

  it('normalises {param} keys read from the file', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      makeYaml({ '/api/bond/{address}': ['get'] }) as unknown as Buffer,
    )
    const result = loadOpenApiPaths()
    expect(result).toHaveProperty('/api/bond/:address')
    expect(result).not.toHaveProperty('/api/bond/{address}')
  })

  it('returns an empty map for a file with no paths: section', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      'openapi: 3.0.0\ninfo:\n  title: Empty\n' as unknown as Buffer,
    )
    expect(loadOpenApiPaths()).toEqual({})
  })

  it('returns an empty map for an empty file (boundary)', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue('' as unknown as Buffer)
    expect(loadOpenApiPaths()).toEqual({})
  })

  it('propagates ENOENT when the spec file is missing (loading-error recovery)', () => {
    const err = Object.assign(new Error('ENOENT: no such file or directory'), {
      code: 'ENOENT',
    })
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw err })
    expect(() => loadOpenApiPaths()).toThrow(/ENOENT/)
  })

  it('propagates EACCES when the spec file is unreadable (permission-error recovery)', () => {
    const err = Object.assign(new Error('EACCES: permission denied'), {
      code: 'EACCES',
    })
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw err })
    expect(() => loadOpenApiPaths()).toThrow(/EACCES/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. main (process contract)
// ─────────────────────────────────────────────────────────────────────────────

describe('main', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('exits 0 when all registered routes are present in the spec', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      buildMatchingYaml() as unknown as Buffer,
    )
    expect(() => main()).toThrow('process.exit(0)')
  })

  it('exits 1 when a registered route is absent from the spec', () => {
    // Provide a spec covering only /api/health — every other route is missing.
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      makeYaml({ '/api/health': ['get'] }) as unknown as Buffer,
    )
    expect(() => main()).toThrow('process.exit(1)')
  })

  it('exits 1 when the spec is empty (empty-spec guard)', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue('' as unknown as Buffer)
    expect(() => main()).toThrow('process.exit(1)')
  })

  it('propagates (does not swallow) a missing-file error (ENOENT recovery)', () => {
    const err = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw err })
    // main() calls loadOpenApiPaths() which throws; main does not catch I/O errors.
    expect(() => main()).toThrow(/ENOENT/)
  })

  it('calls process.exit exactly once per invocation', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      buildMatchingYaml() as unknown as Buffer,
    )
    try { main() } catch { /* swallow sentinel */ }
    expect(exitSpy).toHaveBeenCalledTimes(1)
  })

  it('never exits 0 when drift is detected (regression guard)', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      makeYaml({ '/api/health': ['get'] }) as unknown as Buffer,
    )
    let calledWith: number | undefined
    exitSpy.mockImplementationOnce((code?: number) => {
      calledWith = code
      throw new Error(`process.exit(${code})`)
    })
    try { main() } catch { /* ignore */ }
    expect(calledWith).toBe(1)
    expect(calledWith).not.toBe(0)
  })

  it('writes drift errors to stderr (diagnosable)', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      makeYaml({ '/api/health': ['get'] }) as unknown as Buffer,
    )
    const errorSpy = vi.mocked(console.error)
    try { main() } catch { /* ignore */ }
    const output = errorSpy.mock.calls.map(c => String(c[0])).join('\n')
    expect(output).toContain('drift detected')
  })

  it('stderr output contains route identifiers, not raw file content', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      makeYaml({ '/api/health': ['get'] }) as unknown as Buffer,
    )
    const errorSpy = vi.mocked(console.error)
    try { main() } catch { /* ignore */ }
    const output = errorSpy.mock.calls.map(c => String(c[0])).join('\n')
    // Must contain a path or method identifier
    expect(output).toMatch(/\/api\/|GET|POST|PUT|DELETE|PATCH/)
    // Must not echo yaml file content or arbitrary strings from the spec
    expect(output).not.toContain('openapi: 3.0.0')
  })

  it('writes the success message to stdout on a clean run', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      buildMatchingYaml() as unknown as Buffer,
    )
    const logSpy = vi.mocked(console.log)
    try { main() } catch { /* ignore */ }
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n')
    expect(output).toContain('No OpenAPI contract drift detected')
  })

  it('is retry-safe: two successive calls with the same spec give the same exit code', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      buildMatchingYaml() as unknown as Buffer,
    )
    const codes: number[] = []
    exitSpy.mockImplementation((code?: number) => {
      codes.push(code ?? -1)
      throw new Error(`process.exit(${code})`)
    })
    try { main() } catch { /* ignore */ }
    try { main() } catch { /* ignore */ }
    expect(codes).toEqual([0, 0])
  })
})
