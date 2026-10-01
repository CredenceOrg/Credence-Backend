import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

import {
  DEFAULT_OUTPUT_PATH,
  assertCatalogEntriesRenderable,
  assertRenderableSdkClassName,
  buildClassBlock,
  buildDefaultMessages,
  buildRegistryEntries,
  escapeStringLiteral,
  generate,
  runGenerateSdkErrors,
  writeGeneratedSdk,
} from './generate-sdk-errors.ts'

import { ERROR_CATALOG, ERROR_CATALOG_CODES, type ErrorCatalogEntry } from '../src/lib/errorCatalog.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const COMMITTED_ARTIFACT = path.resolve(__dirname, '../src/sdk/errors.generated.ts')

const entry = (overrides: Partial<ErrorCatalogEntry> = {}): ErrorCatalogEntry => ({
  code: 'sample_code',
  sdkClassName: 'SampleCredenceError',
  kind: 'api',
  httpStatus: 400,
  defaultMessage: 'Sample message',
  category: 'validation',
  ...overrides,
})

const catalogOf = (...entries: ErrorCatalogEntry[]): Record<string, ErrorCatalogEntry> =>
  Object.fromEntries(entries.map((e, i) => [`KEY_${i}`, e]))

const tmpDirs: string[] = []
const makeTmpDir = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  vi.restoreAllMocks()
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
  }
})

describe('escapeStringLiteral', () => {
  it('escapes a single quote so a literal cannot be terminated early', () => {
    expect(escapeStringLiteral("x'; evil(); //")).toBe("x\\'; evil(); //")
  })

  it('escapes backslashes before other escapes so the result is unambiguous', () => {
    expect(escapeStringLiteral(String.raw`a\b`)).toBe(String.raw`a\\b`)
    expect(escapeStringLiteral('a\\')).toBe(String.raw`a\\`)
  })

  it('escapes newlines and carriage returns, which would break the generated line', () => {
    expect(escapeStringLiteral('a\nb')).toBe(String.raw`a\nb`)
    expect(escapeStringLiteral('a\rb')).toBe(String.raw`a\rb`)
  })

  it('is a no-op for a string with no special characters', () => {
    expect(escapeStringLiteral('plain_code_1')).toBe('plain_code_1')
  })

  it('handles the empty string (boundary)', () => {
    expect(escapeStringLiteral('')).toBe('')
  })

  it('does not double-escape an already-escaped quote', () => {
    // Input chars: a \ ' b  ->  output chars: a \ \ \ ' b
    // Backslashes are escaped before quotes, so the backslash introduced for the
    // quote is never itself re-escaped, and the value round-trips unambiguously.
    expect(escapeStringLiteral(String.raw`a\'b`)).toBe(String.raw`a\\\'b`)
  })
})

describe('assertRenderableSdkClassName', () => {
  it('returns the name unchanged when it is a valid identifier', () => {
    expect(assertRenderableSdkClassName('SampleCredenceError', 'sample_code')).toBe('SampleCredenceError')
  })

  it('accepts underscore- and dollar-prefixed identifiers', () => {
    expect(assertRenderableSdkClassName('_Private', 'c')).toBe('_Private')
    expect(assertRenderableSdkClassName('$Dollar', 'c')).toBe('$Dollar')
  })

  it('rejects a missing sdkClassName instead of emitting `class undefined`', () => {
    expect(() => assertRenderableSdkClassName(undefined, 'no_class')).toThrowError(/missing sdkClassName/)
  })

  it('rejects an empty sdkClassName (boundary)', () => {
    expect(() => assertRenderableSdkClassName('', 'empty_class')).toThrowError(/missing sdkClassName/)
  })

  it('rejects an identifier that cannot be emitted as a class declaration', () => {
    expect(() => assertRenderableSdkClassName('9Bad', 'c')).toThrowError(/invalid sdkClassName/)
    expect(() => assertRenderableSdkClassName('has space', 'c')).toThrowError(/invalid sdkClassName/)
  })

  it('rejects a class name carrying an injection payload', () => {
    // Caught by identifier validation, so the payload can never reach the output.
    expect(() => assertRenderableSdkClassName("X' as any; evil(); //", 'c')).toThrowError(/invalid sdkClassName/)
  })

  it('rejects reserved words that are lexically valid but unparseable as a class name', () => {
    // `export class class extends ...` is a syntax error, so shape alone is not enough.
    for (const reserved of ['class', 'extends', 'return', 'new', 'null', 'true', 'await', 'static']) {
      expect(() => assertRenderableSdkClassName(reserved, 'c')).toThrowError(/reserved word/)
    }
  })

  it('accepts identifiers that merely contain a keyword as a substring', () => {
    expect(assertRenderableSdkClassName('ClassName', 'c')).toBe('ClassName')
    expect(assertRenderableSdkClassName('NewError', 'c')).toBe('NewError')
  })

  it('names the offending code so the diagnostic points at the catalog entry', () => {
    expect(() => assertRenderableSdkClassName(undefined, 'my_bad_entry')).toThrowError(/my_bad_entry/)
  })
})

describe('buildClassBlock (success + boundary)', () => {
  it('renders a class pinned to its wire code with the catalog httpStatus as default', () => {
    const block = buildClassBlock(entry({ code: 'not_found', sdkClassName: 'NotFoundCredenceError', httpStatus: 404 }))
    expect(block).toContain('export class NotFoundCredenceError extends CredenceError {')
    expect(block).toContain("static readonly errorCode = 'not_found' as const")
    expect(block).toContain('status: number = 404,')
    expect(block).toContain("super(message, 'not_found', status, details, options)")
    expect(block).toContain("this.name = 'NotFoundCredenceError'")
  })

  it('makes status a REQUIRED parameter when httpStatus is null (transport errors)', () => {
    // Boundary: transport codes have no single default status, so omitting the
    // default is required — otherwise a caller could construct one implicitly.
    const block = buildClassBlock(entry({ code: 'sdk_network_error', sdkClassName: 'SdkNetworkErrorCredenceError', httpStatus: null }))
    expect(block).toContain('status: number,')
    expect(block).not.toContain('status: number =')
  })

  it('defaults the message from DEFAULT_MESSAGES keyed by code', () => {
    expect(buildClassBlock(entry({ code: 'abc' }))).toContain("message: string = DEFAULT_MESSAGES['abc'],")
  })

  it('emits a @deprecated block naming the replacement code', () => {
    const block = buildClassBlock(entry({ deprecated: true, replacedBy: 'new_code' }))
    expect(block).toContain('/**')
    expect(block).toContain(' * @deprecated Legacy error code. Use `new_code` instead.')
    expect(block).toContain(' */')
  })

  it('emits @deprecated without a replacement clause when replacedBy is absent (boundary)', () => {
    const block = buildClassBlock(entry({ deprecated: true, replacedBy: undefined }))
    expect(block).toContain(' * @deprecated Legacy error code.')
    expect(block).not.toContain('instead.')
  })

  it('omits the @deprecated block for a current entry', () => {
    expect(buildClassBlock(entry())).not.toContain('@deprecated')
  })

  it('is deterministic across repeated calls', () => {
    expect(buildClassBlock(entry())).toBe(buildClassBlock(entry()))
  })
})

describe('buildClassBlock (injection / invalid input)', () => {
  it('escapes every quote in a hostile wire code so the payload stays inert', () => {
    const hostile = "x'; console.log('PWNED'); //"
    const block = buildClassBlock(entry({ code: hostile }))
    // Every quote in the value is escaped, so none of them can close the literal.
    expect(block).toContain(String.raw`errorCode = 'x\'; console.log(\'PWNED\'); //' as const`)
    expect(block).toContain(String.raw`super(message, 'x\'; console.log(\'PWNED\'); //', status, details, options)`)
    // The payload never becomes a top-level statement.
    expect(block).not.toMatch(/^\s*console\.log\(/m)
  })

  it('escapes a quote in the code used for the DEFAULT_MESSAGES lookup', () => {
    const block = buildClassBlock(entry({ code: "a'b" }))
    expect(block).toContain(String.raw`DEFAULT_MESSAGES['a\'b']`)
  })

  it('never interpolates defaultMessage into the class block, so a hostile message cannot reach it', () => {
    // The message is referenced indirectly via DEFAULT_MESSAGES[...]; the text
    // itself only ever appears in the map, where JSON.stringify escapes it.
    const hostile = 'line1 "quoted"\nline2 \\ backslash'
    const block = buildClassBlock(entry({ defaultMessage: hostile }))
    expect(block).not.toContain(hostile)
    expect(block).toContain("message: string = DEFAULT_MESSAGES['sample_code'],")
  })

  it('throws rather than emitting a class for a missing sdkClassName', () => {
    expect(() => buildClassBlock(entry({ sdkClassName: undefined }))).toThrowError(/missing sdkClassName/)
  })

  it('never emits the literal token `class undefined`', () => {
    expect(() => buildClassBlock(entry({ sdkClassName: undefined }))).toThrowError()
    try {
      buildClassBlock(entry({ sdkClassName: undefined }))
    } catch {
      /* expected */
    }
    expect(fs.readFileSync(COMMITTED_ARTIFACT, 'utf-8')).not.toContain('class undefined')
  })
})

describe('buildDefaultMessages', () => {
  it('emits one quoted entry per catalog code, in the given order', () => {
    const out = buildDefaultMessages(
      catalogOf(entry({ code: 'a_code', defaultMessage: 'First' }), entry({ code: 'b_code', defaultMessage: 'Second' })),
      ['KEY_0', 'KEY_1'],
    )
    expect(out).toBe('  \'a_code\': "First",\n  \'b_code\': "Second",')
  })

  it('JSON-escapes messages containing quotes', () => {
    const out = buildDefaultMessages(catalogOf(entry({ defaultMessage: 'He said "hi"' })), ['KEY_0'])
    expect(out).toBe('  \'sample_code\': "He said \\"hi\\"",')
  })

  it('escapes the code key so it cannot break out of the literal', () => {
    const out = buildDefaultMessages(catalogOf(entry({ code: "ev'il" })), ['KEY_0'])
    expect(out).toBe(String.raw`  'ev\'il': "Sample message",`)
  })

  it('returns an empty string for an empty catalog (boundary)', () => {
    expect(buildDefaultMessages({}, [])).toBe('')
  })

  it('renders every real catalog code exactly once', () => {
    const out = buildDefaultMessages()
    for (const key of ERROR_CATALOG_CODES) {
      const occurrences = out.split(`'${ERROR_CATALOG[key].code}':`).length - 1
      expect(occurrences, `${ERROR_CATALOG[key].code} should appear once`).toBe(1)
    }
  })
})

describe('buildRegistryEntries', () => {
  it('maps each code to its generated class name', () => {
    const out = buildRegistryEntries(catalogOf(entry({ code: 'a_code', sdkClassName: 'AError' })), ['KEY_0'])
    expect(out).toBe("  'a_code': AError,")
  })

  it('preserves catalog order so output is byte-stable (determinism)', () => {
    const catalog = catalogOf(
      entry({ code: 'z_code', sdkClassName: 'ZError' }),
      entry({ code: 'a_code', sdkClassName: 'AError' }),
    )
    expect(buildRegistryEntries(catalog, ['KEY_0', 'KEY_1'])).toBe("  'z_code': ZError,\n  'a_code': AError,")
  })

  it('throws on a missing sdkClassName rather than emitting `undefined` as the class', () => {
    expect(() => buildRegistryEntries(catalogOf(entry({ sdkClassName: undefined })), ['KEY_0'])).toThrowError(
      /missing sdkClassName/,
    )
  })

  it('returns an empty string for an empty catalog (boundary)', () => {
    expect(buildRegistryEntries({}, [])).toBe('')
  })
})

describe('assertCatalogEntriesRenderable (duplicate / missing-key inputs)', () => {
  it('accepts the real catalog and returns one entry per code', () => {
    expect(assertCatalogEntriesRenderable(ERROR_CATALOG, ERROR_CATALOG_CODES)).toHaveLength(
      ERROR_CATALOG_CODES.length,
    )
  })

  it('rejects a code list that repeats the same key', () => {
    const catalog = catalogOf(entry({ code: 'a_code' }))
    expect(() => assertCatalogEntriesRenderable(catalog, ['KEY_0', 'KEY_0'])).toThrow(
      /duplicate key 'KEY_0'/,
    )
  })

  it('rejects two distinct keys that share one error code', () => {
    const catalog = catalogOf(entry({ code: 'dup_code' }), entry({ code: 'dup_code' }))
    expect(() => assertCatalogEntriesRenderable(catalog, ['KEY_0', 'KEY_1'])).toThrow(
      /duplicate error code 'dup_code'.*'KEY_0' and 'KEY_1'/,
    )
  })

  it('rejects two distinct keys that share one sdkClassName', () => {
    const catalog = catalogOf(entry({ code: 'a_code' }), entry({ code: 'b_code' }))
    expect(() => assertCatalogEntriesRenderable(catalog, ['KEY_0', 'KEY_1'])).toThrow(
      /duplicate sdkClassName 'SampleCredenceError'/,
    )
  })

  it('rejects a code list key that is absent from the catalog', () => {
    expect(() => assertCatalogEntriesRenderable({}, ['KEY_0'])).toThrow(
      /missing key 'KEY_0'/,
    )
  })

  it('rejects a duplicate class name before any class name validation leaks a redeclaration', () => {
    const catalog = catalogOf(
      entry({ code: 'a_code', sdkClassName: 'Same' }),
      entry({ code: 'b_code', sdkClassName: 'Same' }),
    )
    expect(() => assertCatalogEntriesRenderable(catalog, ['KEY_0', 'KEY_1'])).toThrow(/duplicate sdkClassName/)
  })

  it('propagates the sdkClassName validation error for a malformed entry', () => {
    const catalog = catalogOf(entry({ code: 'bad', sdkClassName: 'class' }))
    expect(() => assertCatalogEntriesRenderable(catalog, ['KEY_0'])).toThrow(/invalid sdkClassName/)
  })

  it('is idempotent and order-preserving for a valid catalog', () => {
    const catalog = catalogOf(
      entry({ code: 'a_code', sdkClassName: 'AError' }),
      entry({ code: 'b_code', sdkClassName: 'BError' }),
    )
    const codes = ['KEY_0', 'KEY_1']
    const first = assertCatalogEntriesRenderable(catalog, codes)
    const second = assertCatalogEntriesRenderable(catalog, codes)
    expect(first.map((e) => e.code)).toEqual(['a_code', 'b_code'])
    expect(second.map((e) => e.code)).toEqual(['a_code', 'b_code'])
  })
})

describe('generate (duplicate / missing-key rejection)', () => {
  it('refuses to generate a document from a duplicated error code', () => {
    const catalog = catalogOf(entry({ code: 'dup_code' }), entry({ code: 'dup_code' }))
    expect(() => generate(catalog, ['KEY_0', 'KEY_1'])).toThrow(/duplicate error code 'dup_code'/)
  })

  it('refuses to generate a document from a duplicated sdkClassName', () => {
    const catalog = catalogOf(entry({ code: 'a_code' }), entry({ code: 'b_code' }))
    expect(() => generate(catalog, ['KEY_0', 'KEY_1'])).toThrow(/duplicate sdkClassName/)
  })

  it('refuses to generate a document referencing a missing catalog key', () => {
    expect(() => generate({}, ['KEY_0'])).toThrow(/missing key 'KEY_0'/)
  })

  it('leaves an existing artifact untouched when the catalog is invalid', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-gen-dupe-'))
    const outputPath = path.join(dir, 'nested', 'errors.generated.ts')
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.writeFileSync(outputPath, 'PRIOR GOOD CONTENT', 'utf-8')

    const catalog = catalogOf(entry({ code: 'dup_code' }), entry({ code: 'dup_code' }))
    expect(() => runGenerateSdkErrors({ outputPath, catalog, codes: ['KEY_0', 'KEY_1'] })).toThrow()

    expect(fs.readFileSync(outputPath, 'utf-8')).toBe('PRIOR GOOD CONTENT')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('generate (full document)', () => {
  it('emits a DO-NOT-EDIT banner naming the regeneration command', () => {
    const out = generate()
    expect(out).toContain('AUTO-GENERATED by scripts/generate-sdk-errors.ts — DO NOT EDIT.')
    expect(out).toContain('Regenerate with: npm run generate:sdk-errors')
  })

  it('defines the shared runtime surface the SDK depends on', () => {
    const out = generate()
    for (const symbol of [
      'export interface CredenceErrorEnvelope',
      'export interface CredenceErrorOptions',
      'export class CredenceError extends Error',
      'export const CREDENCE_ERROR_REGISTRY',
      'export type CredenceErrorCode',
      'export function isCredenceError',
      'export function parseCredenceErrorEnvelope',
      'export function createCredenceErrorFromEnvelope',
      'export function createTransportCredenceError',
      'export function sanitizeCauseChain',
    ]) {
      expect(out, `missing ${symbol}`).toContain(symbol)
    }
  })

  it('emits a class and a registry entry for every catalog code', () => {
    const out = generate()
    for (const key of ERROR_CATALOG_CODES) {
      const e = ERROR_CATALOG[key]
      expect(out, `missing class for ${e.code}`).toContain(`export class ${e.sdkClassName} extends CredenceError {`)
      expect(out, `missing registry entry for ${e.code}`).toContain(`  '${e.code}': ${e.sdkClassName},`)
    }
  })

  it('separates class blocks with a blank line', () => {
    const out = generate(catalogOf(entry({ code: 'a', sdkClassName: 'AError' }), entry({ code: 'b', sdkClassName: 'BError' })), ['KEY_0', 'KEY_1'])
    expect(out).toContain('}\n\nexport class BError extends CredenceError {')
  })

  it('renders a valid skeleton for an empty catalog (boundary)', () => {
    const out = generate({}, [])
    expect(out).toContain('export class CredenceError extends Error {')
    expect(out).toContain('export const CREDENCE_ERROR_REGISTRY = {')
    expect(out).toContain('const DEFAULT_MESSAGES = {')
  })

  it('is deterministic: identical input yields byte-identical output', () => {
    expect(generate()).toBe(generate())
  })

  it('does not mutate the catalog it is given', () => {
    const catalog = catalogOf(
      entry({ code: 'a', sdkClassName: 'AError' }),
      entry({ code: 'b', sdkClassName: 'BError' }),
    )
    const snapshot = JSON.stringify(catalog)
    generate(catalog, ['KEY_0', 'KEY_1'])
    expect(JSON.stringify(catalog)).toBe(snapshot)
  })

  it('propagates a catalog validation failure instead of emitting broken source', () => {
    expect(() => generate(catalogOf(entry({ sdkClassName: undefined })), ['KEY_0'])).toThrowError(
      /missing sdkClassName/,
    )
  })

  it('neutralises an injection payload carried in the catalog (security)', () => {
    const out = generate(catalogOf(entry({ code: "x'; evil(); //" })), ['KEY_0'])
    // The payload stays inside an escaped literal and never becomes a statement.
    expect(out).toContain("'x\\'; evil(); //': \"Sample message\",")
    expect(out).not.toMatch(/^\s*evil\(\);/m)
  })

  it('matches the committed artifact byte-for-byte, so a stale generated file fails here', () => {
    // This is the drift guard. `cors_blocked` was added to the catalog on main
    // without regenerating the artifact, which silently shipped an SDK missing
    // that error class; comparing generator output against the committed file
    // turns that class of mistake into a test failure.
    expect(generate()).toBe(fs.readFileSync(COMMITTED_ARTIFACT, 'utf-8'))
  })
})

describe('writeGeneratedSdk (permission / IO recovery)', () => {
  it('creates the parent directory and writes the file as utf-8', () => {
    const mkdir = vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined)
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined)

    writeGeneratedSdk('/fake/dir/errors.generated.ts', 'contents')

    expect(mkdir).toHaveBeenCalledWith('/fake/dir', { recursive: true })
    expect(write).toHaveBeenCalledWith('/fake/dir/errors.generated.ts', 'contents', 'utf-8')
  })

  it('propagates EACCES instead of swallowing it', () => {
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined)
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    })
    expect(() => writeGeneratedSdk('/readonly/errors.generated.ts', 'x')).toThrowError(/permission denied/)
  })

  it('propagates ENOSPC (disk full)', () => {
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined)
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    })
    expect(() => writeGeneratedSdk('/fake/errors.generated.ts', 'x')).toThrowError(/ENOSPC/)
  })

  it('propagates a read-only filesystem from mkdirSync without attempting to write', () => {
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {
      throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' })
    })
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined)
    expect(() => writeGeneratedSdk('/readonly/errors.generated.ts', 'x')).toThrowError(/EROFS/)
    expect(write).not.toHaveBeenCalled()
  })

  it('writes to a real nested temp path end to end', () => {
    vi.restoreAllMocks()
    const target = path.join(makeTmpDir('sdk-write-'), 'a', 'b', 'errors.generated.ts')
    writeGeneratedSdk(target, 'export const X = 1\n')
    expect(fs.readFileSync(target, 'utf-8')).toBe('export const X = 1\n')
  })
})

describe('runGenerateSdkErrors (orchestration)', () => {
  it('defaults to the committed SDK path', () => {
    expect(DEFAULT_OUTPUT_PATH).toBe(path.resolve(__dirname, '../src/sdk/errors.generated.ts'))
  })

  it('writes to the requested path and logs success', () => {
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined)
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined)
    const log = vi.fn()

    const outputPath = runGenerateSdkErrors({
      outputPath: '/tmp/fake/src/sdk/errors.generated.ts',
      catalog: catalogOf(entry()),
      codes: ['KEY_0'],
      log,
    })

    expect(outputPath).toBe('/tmp/fake/src/sdk/errors.generated.ts')
    expect(write).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toMatch(/^SDK error classes generated at /)
  })

  it('emits the success log only after the write resolves (no partial-success state)', () => {
    const order: string[] = []
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined)
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      order.push('write')
    })

    runGenerateSdkErrors({
      outputPath: '/tmp/fake/errors.generated.ts',
      catalog: catalogOf(entry()),
      codes: ['KEY_0'],
      log: () => order.push('log'),
    })

    expect(order).toEqual(['write', 'log'])
  })

  it('surfaces a write failure and never logs success', () => {
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined)
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    })
    const log = vi.fn()
    expect(() =>
      runGenerateSdkErrors({ outputPath: '/tmp/f/errors.generated.ts', catalog: catalogOf(entry()), codes: ['KEY_0'], log }),
    ).toThrowError(/ENOSPC/)
    expect(log).not.toHaveBeenCalled()
  })

  it('surfaces a mkdir failure and never logs success', () => {
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {
      throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' })
    })
    const log = vi.fn()
    expect(() =>
      runGenerateSdkErrors({ outputPath: '/readonly/errors.generated.ts', catalog: catalogOf(entry()), codes: ['KEY_0'], log }),
    ).toThrowError(/EROFS/)
    expect(log).not.toHaveBeenCalled()
  })

  it('leaves an existing artifact untouched when the catalog cannot be rendered', () => {
    // Critical recovery case: errors.generated.ts is imported directly by the
    // SDK, so a validation failure must never truncate the previous good file.
    vi.restoreAllMocks()
    const target = path.join(makeTmpDir('sdk-guard-'), 'errors.generated.ts')
    const good = generate(catalogOf(entry()), ['KEY_0'])
    fs.writeFileSync(target, good, 'utf-8')

    expect(() =>
      runGenerateSdkErrors({
        outputPath: target,
        catalog: catalogOf(entry({ sdkClassName: undefined })),
        codes: ['KEY_0'],
        log: () => {},
      }),
    ).toThrowError(/missing sdkClassName/)

    expect(fs.readFileSync(target, 'utf-8')).toBe(good)
  })

  it('produces a complete artifact in a real temp directory', () => {
    vi.restoreAllMocks()
    const target = path.join(makeTmpDir('sdk-run-'), 'src', 'sdk', 'errors.generated.ts')
    runGenerateSdkErrors({ outputPath: target, log: () => {} })
    const written = fs.readFileSync(target, 'utf-8')
    expect(written).toContain('export class CredenceError extends Error {')
    for (const key of ERROR_CATALOG_CODES) {
      expect(written).toContain(`  '${ERROR_CATALOG[key].code}': ${ERROR_CATALOG[key].sdkClassName},`)
    }
  })

  it('is idempotent: a second run rewrites byte-identical content (no drift)', () => {
    vi.restoreAllMocks()
    const target = path.join(makeTmpDir('sdk-idem-'), 'errors.generated.ts')
    runGenerateSdkErrors({ outputPath: target, log: () => {} })
    const first = fs.readFileSync(target, 'utf-8')
    runGenerateSdkErrors({ outputPath: target, log: () => {} })
    expect(fs.readFileSync(target, 'utf-8')).toBe(first)
  })

  it('overwrites a stale artifact instead of appending to it (stale-state recovery)', () => {
    vi.restoreAllMocks()
    const target = path.join(makeTmpDir('sdk-stale-'), 'errors.generated.ts')
    fs.writeFileSync(target, 'stale: true\n' + 'x'.repeat(50_000) + '\n')

    runGenerateSdkErrors({ outputPath: target, log: () => {} })

    const written = fs.readFileSync(target, 'utf-8')
    expect(written).not.toContain('stale: true')
    expect(written).toContain('export class CredenceError extends Error {')
  })

  it('concurrent runs each leave a complete, parseable artifact', async () => {
    vi.restoreAllMocks()
    const target = path.join(makeTmpDir('sdk-concurrent-'), 'errors.generated.ts')

    await Promise.all(
      Array.from({ length: 5 }, () =>
        Promise.resolve().then(() => runGenerateSdkErrors({ outputPath: target, log: () => {} })),
      ),
    )

    expect(fs.readFileSync(target, 'utf-8')).toBe(generate())
  })

  it('retry after a transient write failure yields the canonical artifact', () => {
    vi.restoreAllMocks()
    const target = path.join(makeTmpDir('sdk-retry-'), 'errors.generated.ts')
    const realWrite = fs.writeFileSync.bind(fs)
    let attempt = 0

    vi.spyOn(fs, 'writeFileSync').mockImplementation(((...args: Parameters<typeof fs.writeFileSync>) => {
      attempt += 1
      if (attempt === 1) {
        throw Object.assign(new Error('EAGAIN: resource temporarily unavailable'), { code: 'EAGAIN' })
      }
      realWrite(...args)
    }) as unknown as typeof fs.writeFileSync)

    expect(() => runGenerateSdkErrors({ outputPath: target, log: () => {} })).toThrowError(/EAGAIN/)
    expect(fs.existsSync(target)).toBe(false)

    vi.restoreAllMocks()
    runGenerateSdkErrors({ outputPath: target, log: () => {} })
    expect(fs.readFileSync(target, 'utf-8')).toBe(generate())
  })
})