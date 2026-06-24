import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  ERROR_CATALOG,
  ERROR_CATALOG_CODES,
  API_ERROR_CATALOG_CODES,
  TRANSPORT_ERROR_CATALOG_CODES,
  ERROR_CATALOG_BY_CODE,
  getCatalogEntry,
  getUnmappedHttpFallbackEntry,
} from '../lib/errorCatalog.js'
import {
  CREDENCE_ERROR_REGISTRY,
  CREDENCE_ERROR_CODES,
  CredenceError,
  sanitizeCauseChain,
  createCredenceErrorFromEnvelope,
  createTransportCredenceError,
  parseCredenceErrorEnvelope,
  isCredenceError,
  InvalidInputCredenceError,
  NotFoundCredenceError,
  SdkRequestTimeoutCredenceError,
  SdkNetworkErrorCredenceError,
  SdkInvalidJsonCredenceError,
  SdkUnmappedHttpCredenceError,
} from '../sdk/errors.generated.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const generatedPath = path.resolve(__dirname, '../sdk/errors.generated.ts')

describe('SDK error catalog parity', () => {
  it('has a generated errors file on disk', () => {
    expect(fs.existsSync(generatedPath)).toBe(true)
  })

  it('maps every catalog entry to a generated SDK class', () => {
    for (const key of ERROR_CATALOG_CODES) {
      const entry = ERROR_CATALOG[key]
      expect(CREDENCE_ERROR_REGISTRY[entry.code]).toBeDefined()
    }
  })

  it('maps every generated registry entry back to the catalog', () => {
    for (const code of CREDENCE_ERROR_CODES) {
      expect(ERROR_CATALOG_BY_CODE[code as any]).toBeDefined()
    }
  })

  it('matches wire codes between catalog and generated classes', () => {
    for (const key of ERROR_CATALOG_CODES) {
      const entry = ERROR_CATALOG[key]
      const Ctor = CREDENCE_ERROR_REGISTRY[entry.code]
      expect((Ctor as { errorCode?: string }).errorCode).toBe(entry.code)
    }
  })

  it('has exactly one unmapped HTTP fallback transport entry', () => {
    const fallbacks = ERROR_CATALOG_CODES.filter(
      (key) => ERROR_CATALOG[key].unmappedHttpFallback,
    )
    expect(fallbacks).toHaveLength(1)
    expect(fallbacks[0]).toBe('sdk_unmapped_http')
  })

  it('includes all api and transport codes in the registry', () => {
    expect(CREDENCE_ERROR_CODES.length).toBe(ERROR_CATALOG_CODES.length)
    expect(API_ERROR_CATALOG_CODES.every((code) => CREDENCE_ERROR_REGISTRY[code])).toBe(true)
    expect(
      TRANSPORT_ERROR_CATALOG_CODES.every((code) => CREDENCE_ERROR_REGISTRY[code]),
    ).toBe(true)
  })

  it('exposes catalog lookup helpers', () => {
    expect(getCatalogEntry('not_found')?.sdkClassName).toBe('NotFoundCredenceError')
    expect(getCatalogEntry('missing-code')).toBeUndefined()
    expect(getUnmappedHttpFallbackEntry().code).toBe('sdk_unmapped_http')
  })

  it('marks deprecated catalog entries with @deprecated in generated output', () => {
    const source = fs.readFileSync(generatedPath, 'utf-8')
    expect(source).toContain('@deprecated Legacy error code.')
    expect(source).toContain('export class InvalidInputCredenceError extends CredenceError')
  })

  it('instantiates every generated class as a CredenceError subclass', () => {
    for (const code of CREDENCE_ERROR_CODES) {
      const Ctor = CREDENCE_ERROR_REGISTRY[code]
      const instance = new Ctor('test message', 418, { sample: true })
      expect(instance).toBeInstanceOf(CredenceError)
      expect(instance.code).toBe(code)
      expect(instance.message).toBe('test message')
      expect(instance.status).toBe(418)
      expect(instance.details).toEqual({ sample: true })
    }
  })
})

describe('SDK error serialization and mapping', () => {
  it('parses standard API error envelopes', () => {
    const envelope = parseCredenceErrorEnvelope(
      JSON.stringify({ error: 'missing', code: 'not_found', details: { id: 1 } }),
    )
    expect(envelope).toEqual({
      error: 'missing',
      code: 'not_found',
      details: { id: 1 },
    })
  })

  it('returns null for non-envelope JSON bodies', () => {
    expect(parseCredenceErrorEnvelope('not json')).toBeNull()
    expect(parseCredenceErrorEnvelope(JSON.stringify({ message: 'nope' }))).toBeNull()
  })

  it('maps API envelopes to typed errors', () => {
    const err = createCredenceErrorFromEnvelope(
      { error: 'Identity not found', code: 'not_found' },
      404,
    )
    expect(err).toBeInstanceOf(NotFoundCredenceError)
    expect(err.code).toBe('not_found')
    expect(err.status).toBe(404)
  })

  it('maps deprecated invalid_input to InvalidInputCredenceError', () => {
    const err = createCredenceErrorFromEnvelope(
      { error: 'bad input', code: 'invalid_input' },
      400,
    )
    expect(err).toBeInstanceOf(InvalidInputCredenceError)
    expect(err.code).toBe('invalid_input')
  })

  it('falls back to unmapped HTTP error for unknown api codes', () => {
    const err = createCredenceErrorFromEnvelope(
      { error: 'mystery', code: 'totally_unknown_code' },
      502,
    )
    expect(err).toBeInstanceOf(SdkUnmappedHttpCredenceError)
    expect(err.code).toBe('sdk_unmapped_http')
  })

  it('creates transport errors for timeout, network, invalid JSON, and unmapped HTTP', () => {
    expect(
      createTransportCredenceError('sdk_request_timeout', 'Request timed out', 0),
    ).toBeInstanceOf(SdkRequestTimeoutCredenceError)
    expect(
      createTransportCredenceError('sdk_network_error', 'Network error', 0),
    ).toBeInstanceOf(SdkNetworkErrorCredenceError)
    expect(
      createTransportCredenceError('sdk_invalid_json', 'Invalid JSON response', 200),
    ).toBeInstanceOf(SdkInvalidJsonCredenceError)
    expect(
      createTransportCredenceError('sdk_unmapped_http', 'HTTP 502: Bad Gateway', 502),
    ).toBeInstanceOf(SdkUnmappedHttpCredenceError)
  })

  it('strips stack traces from nested cause chains', () => {
    const root = new Error('root failure')
    const wrapped = new Error('wrapped', { cause: root })
    ;(root as Error & { stack?: string }).stack = 'SECRET STACK'

    const sanitized = sanitizeCauseChain(wrapped)
    expect(sanitized).toEqual({
      name: 'Error',
      message: 'wrapped',
      cause: {
        name: 'Error',
        message: 'root failure',
      },
    })
    expect(JSON.stringify(sanitized)).not.toContain('SECRET STACK')
  })

  it('serializes CredenceError without stack traces', () => {
    const err = new NotFoundCredenceError('missing', 404, { id: 'abc' })
    const json = err.toJSON()
    expect(json).toEqual({
      error: 'missing',
      code: 'not_found',
      status: 404,
      details: { id: 'abc' },
    })
    expect(JSON.stringify(json)).not.toContain('stack')
  })

  it('sanitizes cause when constructing CredenceError', () => {
    const cause = new Error('inner')
    ;(cause as Error & { stack?: string }).stack = 'INNER STACK'
    const err = new SdkNetworkErrorCredenceError('Network error', 0, undefined, { cause })
    expect((err.cause as { message?: string }).message).toBe('inner')
    expect(JSON.stringify(err.cause)).not.toContain('INNER STACK')
  })

  it('identifies CredenceError instances via isCredenceError', () => {
    expect(isCredenceError(new NotFoundCredenceError())).toBe(true)
    expect(isCredenceError(new Error('nope'))).toBe(false)
  })

  it('sanitizes plain object causes without stack metadata', () => {
    const sanitized = sanitizeCauseChain({
      name: 'TransportFailure',
      message: 'socket hang up',
      stack: 'SECRET',
      cause: { message: 'nested', stack: 'NESTED SECRET' },
    })
    expect(sanitized).toEqual({
      name: 'TransportFailure',
      message: 'socket hang up',
      cause: { message: 'nested' },
    })
    expect(JSON.stringify(sanitized)).not.toContain('SECRET')
  })

  it('returns undefined when sanitizeCauseChain receives nullish values', () => {
    expect(sanitizeCauseChain(null)).toBeUndefined()
    expect(sanitizeCauseChain(undefined)).toBeUndefined()
  })
})
