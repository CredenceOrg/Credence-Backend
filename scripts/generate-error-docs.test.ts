import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import type { ErrorCatalogEntry, ErrorCodeDeprecation } from '../src/lib/errorCatalog.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Imported after any per-test vi.mock/vi.spyOn setup; the module has no
// top-level side effects on import (the CLI run is gated by an
// import.meta.url === process.argv[1] guard), so it is safe to import once.
import {
  escapeMarkdown,
  formatEntryRow,
  buildActiveEntries,
  buildDeprecatedEntries,
  buildLocalizationRows,
  buildDeprecatedSection,
  buildErrorDocsContent,
  writeErrorDocs,
  runGenerateErrorDocs,
} from './generate-error-docs.ts'

const entry = (overrides: Partial<ErrorCatalogEntry> = {}): ErrorCatalogEntry => ({
  code: 'sample_code',
  httpStatus: 400,
  defaultMessage: 'Sample message',
  category: 'validation',
  kind: 'api',
  ...overrides,
})

describe('escapeMarkdown', () => {
  it('escapes pipe characters so they cannot break a table row', () => {
    expect(escapeMarkdown('a | b')).toBe('a \\| b')
  })

  it('escapes every pipe when there are several', () => {
    expect(escapeMarkdown('a|b|c')).toBe('a\\|b\\|c')
  })

  it('is a no-op on a string with no special characters', () => {
    expect(escapeMarkdown('plain text')).toBe('plain text')
  })

  it('handles the empty string (boundary)', () => {
    expect(escapeMarkdown('')).toBe('')
  })
})

describe('formatEntryRow', () => {
  it('formats a well-formed entry into a pipe-delimited row', () => {
    expect(formatEntryRow(entry())).toBe('`sample_code` | 400 | validation | Sample message')
  })

  it('falls back to an empty category cell when category is missing (boundary)', () => {
    expect(formatEntryRow(entry({ category: undefined }))).toBe(
      '`sample_code` | 400 |  | Sample message'
    )
  })

  it('renders a null httpStatus as the literal string "null" rather than throwing (boundary)', () => {
    expect(formatEntryRow(entry({ httpStatus: null }))).toBe(
      '`sample_code` | null | validation | Sample message'
    )
  })

  it('escapes pipes inside the default message', () => {
    expect(formatEntryRow(entry({ defaultMessage: 'a | b' }))).toBe(
      '`sample_code` | 400 | validation | a \\| b'
    )
  })
})

describe('buildActiveEntries', () => {
  it('keeps only kind === "api" entries, dropping everything else', () => {
    const catalog = {
      A: entry({ code: 'a', kind: 'api' }),
      B: entry({ code: 'b', kind: 'transport' }),
      C: entry({ code: 'c', kind: undefined }),
    }
    expect(buildActiveEntries(catalog).map((e) => e.code)).toEqual(['a'])
  })

  it('sorts by category, then httpStatus, then code', () => {
    const catalog = {
      A: entry({ code: 'z_code', category: 'validation', httpStatus: 400 }),
      B: entry({ code: 'a_code', category: 'validation', httpStatus: 400 }),
      C: entry({ code: 'x_code', category: 'authentication', httpStatus: 401 }),
      D: entry({ code: 'y_code', category: 'validation', httpStatus: 404 }),
    }
    expect(buildActiveEntries(catalog).map((e) => e.code)).toEqual([
      'x_code', // authentication sorts before validation
      'a_code', // validation/400, code a before z
      'z_code', // validation/400
      'y_code', // validation/404
    ])
  })

  it('treats a missing category as "" for sorting, placing it before any named category (boundary)', () => {
    const catalog = {
      A: entry({ code: 'b_code', category: 'validation' }),
      B: entry({ code: 'a_code', category: undefined }),
    }
    expect(buildActiveEntries(catalog).map((e) => e.code)).toEqual(['a_code', 'b_code'])
  })

  it('treats a null/undefined httpStatus as 0 for sorting (boundary)', () => {
    const catalog = {
      A: entry({ code: 'b_code', category: 'system', httpStatus: 500 }),
      B: entry({ code: 'a_code', category: 'system', httpStatus: null }),
    }
    expect(buildActiveEntries(catalog).map((e) => e.code)).toEqual(['a_code', 'b_code'])
  })

  it('returns an empty array for an empty catalog (boundary)', () => {
    expect(buildActiveEntries({})).toEqual([])
  })

  it('is deterministic: sorting is stable across repeated calls on the same input', () => {
    const catalog = {
      A: entry({ code: 'b', category: 'validation', httpStatus: 400 }),
      B: entry({ code: 'a', category: 'validation', httpStatus: 400 }),
    }
    const first = buildActiveEntries(catalog).map((e) => e.code)
    const second = buildActiveEntries(catalog).map((e) => e.code)
    expect(second).toEqual(first)
  })

  it('does not mutate the input catalog object', () => {
    const catalog = {
      A: entry({ code: 'b' }),
      B: entry({ code: 'a' }),
    }
    const snapshot = JSON.parse(JSON.stringify(catalog))
    buildActiveEntries(catalog)
    expect(catalog).toEqual(snapshot)
  })

  it('keeps duplicate codes as separate rows rather than silently deduping (regression guard)', () => {
    const catalog = {
      A: entry({ code: 'dup_code', category: 'validation', httpStatus: 400 }),
      B: entry({ code: 'dup_code', category: 'validation', httpStatus: 400 }),
    }
    expect(buildActiveEntries(catalog)).toHaveLength(2)
  })
})

describe('buildDeprecatedEntries', () => {
  const deprecation = (overrides: Partial<ErrorCodeDeprecation> = {}): ErrorCodeDeprecation => ({
    code: 'old_code',
    deprecatedSince: '2025-01-01',
    reason: 'Superseded',
    ...overrides,
  })

  it('sorts deprecations by code', () => {
    const deprecations = {
      A: deprecation({ code: 'z' }),
      B: deprecation({ code: 'a' }),
    }
    expect(buildDeprecatedEntries(deprecations).map((d) => d.code)).toEqual(['a', 'z'])
  })

  it('returns an empty array when there are no deprecations (boundary)', () => {
    expect(buildDeprecatedEntries({})).toEqual([])
  })
})

describe('buildLocalizationRows', () => {
  it('renders one row per locale with the correct message count', () => {
    const rows = buildLocalizationRows({
      en: { a: '1', b: '2' },
      fr: { a: '1' },
    })
    expect(rows).toEqual([
      '| `en` | 2 messages | Catalog default messages for active codes. |',
      '| `fr` | 1 messages | Catalog default messages for active codes. |',
    ])
  })

  it('renders 0 messages for a locale with an empty message map (boundary)', () => {
    expect(buildLocalizationRows({ en: {} })).toEqual([
      '| `en` | 0 messages | Catalog default messages for active codes. |',
    ])
  })

  it('returns an empty array for an empty localization catalog (boundary)', () => {
    expect(buildLocalizationRows({})).toEqual([])
  })
})

describe('buildDeprecatedSection', () => {
  it('renders the "no deprecations" fallback when the list is empty (boundary)', () => {
    expect(buildDeprecatedSection([])).toEqual(['No error codes are currently deprecated.', ''])
  })

  it('renders a table with "None" for a deprecation with no replacement code (boundary)', () => {
    const lines = buildDeprecatedSection([
      { code: 'old_code', deprecatedSince: '2025-01-01', reason: 'Removed' },
    ])
    expect(lines).toContain('| `old_code` | 2025-01-01 | None | Removed |')
  })

  it('renders the replacement code when one is present', () => {
    const lines = buildDeprecatedSection([
      {
        code: 'old_code',
        deprecatedSince: '2025-01-01',
        replacement: 'new_code',
        reason: 'Renamed',
      },
    ])
    expect(lines).toContain('| `old_code` | 2025-01-01 | `new_code` | Renamed |')
  })

  it('escapes pipes in the reason text', () => {
    const lines = buildDeprecatedSection([
      { code: 'old_code', deprecatedSince: '2025-01-01', reason: 'a | b' },
    ])
    expect(lines).toContain('| `old_code` | 2025-01-01 | None | a \\| b |')
  })
})

describe('buildErrorDocsContent (pure, no I/O)', () => {
  const validInput = {
    catalog: { A: entry() },
    deprecations: {},
    localizationCatalog: { en: { sample_code: 'Sample message' } },
  }

  it('produces a stable header and stability-contract section', () => {
    const content = buildErrorDocsContent(validInput)
    expect(content).toContain('# Credence API Error Codes')
    expect(content).toContain('## Stability contract')
    expect(content).toContain(
      'Existing codes must not be removed or renamed without adding a deprecation entry in `ERROR_CODE_DEPRECATIONS`.'
    )
  })

  it('is deterministic: identical input produces byte-identical output', () => {
    expect(buildErrorDocsContent(validInput)).toBe(buildErrorDocsContent(validInput))
  })

  it('handles a fully empty catalog/deprecations/localization set without throwing (boundary)', () => {
    const content = buildErrorDocsContent({
      catalog: {},
      deprecations: {},
      localizationCatalog: {},
    })
    expect(content).toContain('No error codes are currently deprecated.')
    expect(content).toContain('## Active codes')
  })

  it('ends with a trailing blank line after the last section (matches the committed file format)', () => {
    const content = buildErrorDocsContent(validInput)
    expect(content.endsWith('\n\n')).toBe(true)
  })
})

describe('writeErrorDocs (recovery / permission path)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('creates the parent directory and writes the file with the given content', () => {
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined)
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined)

    writeErrorDocs('/fake/dir/error-codes.md', 'content')

    expect(mkdirSpy).toHaveBeenCalledWith('/fake/dir', { recursive: true })
    expect(writeSpy).toHaveBeenCalledWith('/fake/dir/error-codes.md', 'content', 'utf-8')
  })

  it('propagates a permission error from writeFileSync rather than swallowing it (recovery path)', () => {
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined)
    const eacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw eacces
    })

    expect(() => writeErrorDocs('/readonly/error-codes.md', 'content')).toThrowError(
      /permission denied/
    )
  })

  it('propagates a mkdir failure (e.g. a read-only mount) without attempting to write (recovery path)', () => {
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {
      throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' })
    })
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined)

    expect(() => writeErrorDocs('/readonly/error-codes.md', 'content')).toThrowError(/EROFS/)
    expect(mkdirSpy).toHaveBeenCalled()
    expect(writeSpy).not.toHaveBeenCalled()
  })
})

describe('runGenerateErrorDocs (orchestration)', () => {
  beforeEach(() => {
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined)
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes the generated content to the given output path and logs the relative path', () => {
    const log = vi.fn()
    const writeSpy = vi.spyOn(fs, 'writeFileSync')

    const outputPath = runGenerateErrorDocs({
      outputPath: '/tmp/fake-repo/docs/error-codes.md',
      catalog: { A: entry() },
      deprecations: {},
      localizationCatalog: { en: {} },
      log,
    })

    expect(outputPath).toBe('/tmp/fake-repo/docs/error-codes.md')
    expect(writeSpy).toHaveBeenCalledTimes(1)
    const [, writtenContent] = writeSpy.mock.calls[0]
    expect(String(writtenContent)).toContain('sample_code')
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toMatch(/^Error-code reference generated at /)
  })

  it('surfaces a write failure to the caller instead of logging success (recovery path)', () => {
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    })
    const log = vi.fn()

    expect(() =>
      runGenerateErrorDocs({
        outputPath: '/tmp/fake-repo/docs/error-codes.md',
        catalog: { A: entry() },
        deprecations: {},
        localizationCatalog: {},
        log,
      })
    ).toThrowError(/ENOSPC/)
    expect(log).not.toHaveBeenCalled()
  })

  it('runs end to end against a real temp directory and produces a readable, well-formed file', () => {
    vi.restoreAllMocks() // use the real filesystem for this one integration-style check
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'error-docs-'))
    const outputPath = path.join(tmpDir, 'nested', 'error-codes.md')
    try {
      runGenerateErrorDocs({
        outputPath,
        catalog: { A: entry() },
        deprecations: {},
        localizationCatalog: { en: {} },
        log: () => {},
      })
      const written = fs.readFileSync(outputPath, 'utf-8')
      expect(written).toContain('# Credence API Error Codes')
      expect(written).toContain('sample_code')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('uses the real error catalog by default and produces internally consistent, well-formed output', () => {
    // Not compared byte-for-byte against the committed docs/error-codes.md:
    // that file can legitimately drift out of date whenever someone edits
    // errorCatalog.ts without re-running this script, and this test should
    // not pass or fail based on whether someone remembered to do that. It
    // instead checks the invariants the generated content must always hold
    // for whatever the current real catalog is.
    vi.restoreAllMocks()
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'error-docs-'))
    const outputPath = path.join(tmpDir, 'error-codes.md')
    try {
      runGenerateErrorDocs({ outputPath, log: () => {} })
      const generated = fs.readFileSync(outputPath, 'utf-8')
      expect(generated).toContain('# Credence API Error Codes')
      expect(generated).toContain('## Active codes')
      expect(generated).toContain('## Localization catalog')
      expect(generated).toContain('## Deprecated codes')
      const tableRows = generated
        .split('\n')
        .filter((line) => line.startsWith('| `') && line.includes('` | '))
      expect(tableRows.length).toBeGreaterThan(0)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
