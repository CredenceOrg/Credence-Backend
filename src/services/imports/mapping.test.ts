import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  InMemoryMappingPresetRepository,
  MappingPresetRepository,
  buildColumnMapper,
  stripBom,
  applyPresetToPreview,
  validateMappedRow,
  zodIssueToImportError,
  headersSatisfyMapping,
  dryRunImportFile,
  columnMappingSchema,
  importMappedRowSchema,
  DEFAULT_COLUMN_MAPPING,
  IMPORT_DRY_RUN_MAX_ERRORS,
  type ColumnMapping,
  type CreateMappingPresetInput,
} from './mapping.js'
import {
  IMPORT_PREVIEW_MAX_FILE_BYTES,
  IMPORT_PREVIEW_MAX_CELL_BYTES,
  IMPORT_PREVIEW_MAX_ROWS,
} from '../importPreviewService.js'
import { z } from 'zod'

describe('MappingPresetRepository', () => {
  const presetRow = {
    id: 'preset-1',
    org_id: 'org-1',
    name: 'Standard',
    version: 1,
    column_mappings: { Wallet: 'address' },
    created_at: new Date('2025-01-01'),
    updated_at: new Date('2025-01-01'),
  }

  it('findByOrg returns mapped presets', async () => {
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [presetRow] }),
    }
    const repo = new MappingPresetRepository(db as any)
    const presets = await repo.findByOrg('org-1')
    expect(presets).toHaveLength(1)
    expect(presets[0].columnMappings).toEqual({ Wallet: 'address' })
  })

  it('findById returns null when missing', async () => {
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    }
    const repo = new MappingPresetRepository(db as any)
    await expect(repo.findById('missing')).resolves.toBeNull()
  })

  it('findById returns a mapped preset', async () => {
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [presetRow] }),
    }
    const repo = new MappingPresetRepository(db as any)
    const preset = await repo.findById('preset-1')
    expect(preset?.name).toBe('Standard')
  })

  it('create assigns the next version and returns the preset', async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ max_version: 2 }] })
        .mockResolvedValueOnce({ rows: [presetRow] }),
    }
    const repo = new MappingPresetRepository(db as any)
    const preset = await repo.create({
      orgId: 'org-1',
      name: 'Standard',
      columnMappings: { Wallet: 'address' },
    })
    expect(preset.name).toBe('Standard')
    expect(db.query).toHaveBeenCalledTimes(2)
  })

  it('update returns null when the preset does not exist', async () => {
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    }
    const repo = new MappingPresetRepository(db as any)
    await expect(repo.update('missing', { name: 'New' })).resolves.toBeNull()
  })

  it('update with no fields delegates to findById', async () => {
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [presetRow] }),
    }
    const repo = new MappingPresetRepository(db as any)
    const preset = await repo.update('preset-1', {})
    expect(preset?.id).toBe('preset-1')
    expect(db.query).toHaveBeenCalledTimes(1)
  })

  it('update applies name and column mapping changes', async () => {
    const updatedRow = {
      ...presetRow,
      name: 'Updated',
      version: 2,
      column_mappings: { Wallet: 'address', Email: 'email' },
    }
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [updatedRow] }),
    }
    const repo = new MappingPresetRepository(db as any)
    const preset = await repo.update('preset-1', {
      name: 'Updated',
      columnMappings: { Wallet: 'address', Email: 'email' },
    })
    expect(preset?.name).toBe('Updated')
    expect(preset?.version).toBe(2)
  })

  it('delete returns true when a row is removed', async () => {
    const db = {
      query: vi.fn().mockResolvedValue({ rowCount: 1 }),
    }
    const repo = new MappingPresetRepository(db as any)
    await expect(repo.delete('preset-id')).resolves.toBe(true)
  })

  it('delete returns false when no row is removed', async () => {
    const db = {
      query: vi.fn().mockResolvedValue({ rowCount: 0 }),
    }
    const repo = new MappingPresetRepository(db as any)
    await expect(repo.delete('missing-id')).resolves.toBe(false)
  })
})

// ===========================================================================
// InMemoryMappingPresetRepository
// ===========================================================================

describe('InMemoryMappingPresetRepository', () => {
  let repo: InMemoryMappingPresetRepository

  beforeEach(() => {
    repo = new InMemoryMappingPresetRepository()
  })

  const orgA = 'org-a-uuid'
  const orgB = 'org-b-uuid'

  describe('create', () => {
    it('creates a preset and assigns version 1', async () => {
      const preset = await repo.create({
        orgId: orgA,
        name: 'Standard',
        columnMappings: { 'Wallet Address': 'address' },
      })

      expect(preset.id).toBeDefined()
      expect(preset.orgId).toBe(orgA)
      expect(preset.name).toBe('Standard')
      expect(preset.version).toBe(1)
      expect(preset.columnMappings).toEqual({ 'Wallet Address': 'address' })
      expect(preset.createdAt).toBeInstanceOf(Date)
      expect(preset.updatedAt).toBeInstanceOf(Date)
    })

    it('increments version when a preset with the same org+name exists', async () => {
      await repo.create({
        orgId: orgA,
        name: 'Standard',
        columnMappings: { 'Wallet': 'address' },
      })
      const v2 = await repo.create({
        orgId: orgA,
        name: 'Standard',
        columnMappings: { 'Wallet': 'address', 'Email': 'email' },
      })

      expect(v2.version).toBe(2)
    })

    it('does not increment version across different orgs', async () => {
      await repo.create({
        orgId: orgA,
        name: 'Standard',
        columnMappings: { 'Wallet': 'address' },
      })
      const other = await repo.create({
        orgId: orgB,
        name: 'Standard',
        columnMappings: { 'Wallet': 'address' },
      })

      expect(other.version).toBe(1)
    })

    it('does not increment version across different names in same org', async () => {
      await repo.create({
        orgId: orgA,
        name: 'Standard',
        columnMappings: { 'Wallet': 'address' },
      })
      const other = await repo.create({
        orgId: orgA,
        name: 'Advanced',
        columnMappings: { 'Wallet': 'address' },
      })

      expect(other.version).toBe(1)
    })
  })

  describe('findByOrg', () => {
    it('returns empty array for org with no presets', async () => {
      const presets = await repo.findByOrg('nonexistent-org')
      expect(presets).toEqual([])
    })

    it('returns all presets for a given org', async () => {
      await repo.create({
        orgId: orgA,
        name: 'Alpha',
        columnMappings: { 'A': 'address' },
      })
      await repo.create({
        orgId: orgA,
        name: 'Beta',
        columnMappings: { 'B': 'address' },
      })
      await repo.create({
        orgId: orgB,
        name: 'Gamma',
        columnMappings: { 'C': 'address' },
      })

      const orgAPresets = await repo.findByOrg(orgA)
      expect(orgAPresets).toHaveLength(2)
      expect(orgAPresets.map((p) => p.name).sort()).toEqual(['Alpha', 'Beta'])
    })

    it('returns multiple versions sorted by version DESC', async () => {
      await repo.create({
        orgId: orgA,
        name: 'Standard',
        columnMappings: { 'W': 'address' },
      })
      await repo.create({
        orgId: orgA,
        name: 'Standard',
        columnMappings: { 'W': 'address', 'E': 'email' },
      })

      const presets = await repo.findByOrg(orgA)
      const stdPresets = presets.filter((p) => p.name === 'Standard')
      expect(stdPresets).toHaveLength(2)
      expect(stdPresets[0].version).toBe(2)
      expect(stdPresets[1].version).toBe(1)
    })
  })

  describe('findById', () => {
    it('returns null for nonexistent id', async () => {
      const preset = await repo.findById('nonexistent')
      expect(preset).toBeNull()
    })

    it('returns the preset by id', async () => {
      const created = await repo.create({
        orgId: orgA,
        name: 'Test',
        columnMappings: { 'X': 'address' },
      })

      const found = await repo.findById(created.id)
      expect(found).not.toBeNull()
      expect(found!.id).toBe(created.id)
      expect(found!.name).toBe('Test')
    })
  })

  describe('update', () => {
    it('updates name and bumps version', async () => {
      const created = await repo.create({
        orgId: orgA,
        name: 'Original',
        columnMappings: { 'W': 'address' },
      })

      const updated = await repo.update(created.id, { name: 'Renamed' })
      expect(updated).not.toBeNull()
      expect(updated!.name).toBe('Renamed')
      expect(updated!.version).toBe(2)
    })

    it('updates columnMappings and bumps version', async () => {
      const created = await repo.create({
        orgId: orgA,
        name: 'Test',
        columnMappings: { 'W': 'address' },
      })

      const updated = await repo.update(created.id, {
        columnMappings: { 'W': 'address', 'E': 'email' },
      })
      expect(updated!.columnMappings).toEqual({ 'W': 'address', 'E': 'email' })
      expect(updated!.version).toBe(2)
    })

    it('returns null for nonexistent id', async () => {
      const result = await repo.update('nonexistent', { name: 'Nope' })
      expect(result).toBeNull()
    })

    it('returns the preset unchanged when no fields provided', async () => {
      const created = await repo.create({
        orgId: orgA,
        name: 'Test',
        columnMappings: { 'W': 'address' },
      })
      const updated = await repo.update(created.id, {})
      expect(updated!.name).toBe('Test')
      expect(updated!.version).toBe(1)
    })
  })

  describe('delete', () => {
    it('returns true when a preset is deleted', async () => {
      const created = await repo.create({
        orgId: orgA,
        name: 'ToDelete',
        columnMappings: { 'W': 'address' },
      })

      const deleted = await repo.delete(created.id)
      expect(deleted).toBe(true)

      const found = await repo.findById(created.id)
      expect(found).toBeNull()
    })

    it('returns false for nonexistent id', async () => {
      const result = await repo.delete('nonexistent')
      expect(result).toBe(false)
    })
  })

  describe('clear', () => {
    it('removes all presets', async () => {
      await repo.create({
        orgId: orgA,
        name: 'A',
        columnMappings: {},
      })
      await repo.create({
        orgId: orgA,
        name: 'B',
        columnMappings: {},
      })

      repo.clear()
      const presets = await repo.findByOrg(orgA)
      expect(presets).toHaveLength(0)
    })
  })
})

// ===========================================================================
// stripBom
// ===========================================================================

describe('stripBom', () => {
  it('removes BOM from the start of a string', () => {
    const result = stripBom('\uFEFFaddress,name')
    expect(result).toBe('address,name')
  })

  it('returns the string unchanged when no BOM is present', () => {
    const result = stripBom('address,name')
    expect(result).toBe('address,name')
  })

  it('handles empty string', () => {
    expect(stripBom('')).toBe('')
  })

  it('does not strip non-BOM characters', () => {
    const result = stripBom('\uFEFF')
    expect(result).toBe('')
  })
})

// ===========================================================================
// buildColumnMapper
// ===========================================================================

describe('buildColumnMapper', () => {
  it('maps CSV columns to canonical columns using the mapping', () => {
    const mapper = buildColumnMapper(
      ['Wallet Address', 'Full Name', 'Email Address'],
      { 'Wallet Address': 'address', 'Full Name': 'name', 'Email Address': 'email' },
    )

    const result = mapper(['GB1234...', 'Alice', 'alice@example.com'])
    expect(result).toEqual({
      address: 'GB1234...',
      name: 'Alice',
      email: 'alice@example.com',
    })
  })

  it('matches headers case-insensitively', () => {
    const mapper = buildColumnMapper(
      ['WALLET ADDRESS', 'full name'],
      { 'wallet address': 'address', 'Full Name': 'name' },
    )

    const result = mapper(['GB1234...', 'Alice'])
    expect(result).toEqual({
      address: 'GB1234...',
      name: 'Alice',
    })
  })

  it('strips BOM from the first header', () => {
    const mapper = buildColumnMapper(
      ['\uFEFFWallet Address', 'Full Name'],
      { 'Wallet Address': 'address', 'Full Name': 'name' },
    )

    const result = mapper(['GB1234...', 'Alice'])
    expect(result).toEqual({
      address: 'GB1234...',
      name: 'Alice',
    })
  })

  it('maps only columns present in the mapping', () => {
    const mapper = buildColumnMapper(
      ['Wallet Address', 'Full Name', 'Phone'],
      { 'Wallet Address': 'address' },
    )

    const result = mapper(['GB1234...', 'Alice', '555-0100'])
    expect(result).toEqual({
      address: 'GB1234...',
    })
    expect(Object.keys(result)).toHaveLength(1)
  })

  it('handles empty mapping gracefully', () => {
    const mapper = buildColumnMapper(
      ['Wallet Address', 'Full Name'],
      {},
    )

    const result = mapper(['GB1234...', 'Alice'])
    expect(result).toEqual({})
  })

  it('when multiple mappings target the same canonical column the last CSV header wins', () => {
    const mapper = buildColumnMapper(
      ['Primary Wallet', 'Secondary Wallet'],
      { 'Primary Wallet': 'address', 'Secondary Wallet': 'address' },
    )

    const result = mapper(['GB1111...', 'GB2222...'])
    expect(result).toEqual({
      address: 'GB2222...',
    })
  })

  it('returns empty string for CSV columns that are missing in a row', () => {
    const mapper = buildColumnMapper(
      ['Wallet Address', 'Full Name'],
      { 'Wallet Address': 'address', 'Full Name': 'name' },
    )

    const result = mapper(['GB1234...'])
    expect(result).toEqual({
      address: 'GB1234...',
      name: '',
    })
  })

  it('sanitizes formula-injection prefixes in cell values', () => {
    const mapper = buildColumnMapper(
      ['Wallet Address'],
      { 'Wallet Address': 'address' },
    )

    const result = mapper(['=SUM(A1:A10)'])
    expect(result.address).toBe('\t=SUM(A1:A10)')
  })

  it('sanitizes multiple formula-injection prefixes', () => {
    const mapper = buildColumnMapper(
      ['Wallet Address', 'Notes'],
      { 'Wallet Address': 'address', 'Notes': 'notes' },
    )

    const result = mapper(['=cmd', '+expression'])
    expect(result.address).toBe('\t=cmd')
    expect(result.notes).toBe('\t+expression')
  })

  it('does not sanitize normal values', () => {
    const mapper = buildColumnMapper(
      ['Wallet Address'],
      { 'Wallet Address': 'address' },
    )

    const result = mapper(['GB1234...'])
    expect(result.address).toBe('GB1234...')
  })

  it('trims whitespace from cell values', () => {
    const mapper = buildColumnMapper(
      ['Wallet Address'],
      { 'Wallet Address': 'address' },
    )

    const result = mapper(['  GB1234...  '])
    expect(result.address).toBe('GB1234...')
  })

  it('handles CSV headers that are not in the mapping', () => {
    const mapper = buildColumnMapper(
      ['Wallet Address', 'Extra Column'],
      { 'Wallet Address': 'address' },
    )

    const result = mapper(['GB1234...', 'extra'])
    expect(result).toEqual({ address: 'GB1234...' })
  })

  it('returns empty result when no CSV headers match the mapping', () => {
    const mapper = buildColumnMapper(
      ['Col A', 'Col B'],
      { 'Wallet': 'address', 'Email': 'email' },
    )

    const result = mapper(['val1', 'val2'])
    expect(result).toEqual({})
  })
})

// ===========================================================================
// applyPresetToPreview
// ===========================================================================

describe('applyPresetToPreview', () => {
  it('remaps raw rows according to column mappings', () => {
    const csvHeaders = ['Wallet', 'Email']
    const columnMappings: ColumnMapping = { 'Wallet': 'address', 'Email': 'email' }
    const rawRows = [
      ['GB1111...', 'alice@test.com'],
      ['GB2222...', 'bob@test.com'],
    ]

    const result = applyPresetToPreview(rawRows, csvHeaders, columnMappings)

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      remapped: { address: 'GB1111...', email: 'alice@test.com' },
      line: 2,
    })
    expect(result[1]).toEqual({
      remapped: { address: 'GB2222...', email: 'bob@test.com' },
      line: 3,
    })
  })

  it('handles empty rows array', () => {
    const result = applyPresetToPreview([], ['Wallet'], { 'Wallet': 'address' })
    expect(result).toEqual([])
  })

  it('sanitizes formula injection in applyPresetToPreview', () => {
    const csvHeaders = ['Wallet']
    const columnMappings: ColumnMapping = { 'Wallet': 'address' }
    const rawRows = [['=EVIL']]

    const result = applyPresetToPreview(rawRows, csvHeaders, columnMappings)
    expect(result[0].remapped.address).toBe('\t=EVIL')
  })

  it('assigns correct line numbers (2-indexed)', () => {
    const rawRows = [['a'], ['b'], ['c']]
    const result = applyPresetToPreview(rawRows, ['H1'], { 'H1': 'col1' })
    expect(result.map((r) => r.line)).toEqual([2, 3, 4])
  })
})

// ===========================================================================
// columnMappingSchema
// ===========================================================================

describe('columnMappingSchema', () => {
  it('accepts a mapping that includes address', () => {
    const result = columnMappingSchema.safeParse({ Wallet: 'address', Email: 'email' })
    expect(result.success).toBe(true)
  })

  it('rejects a mapping without address', () => {
    const result = columnMappingSchema.safeParse({ Email: 'email' })
    expect(result.success).toBe(false)
  })

  it('rejects unknown canonical columns', () => {
    const result = columnMappingSchema.safeParse({ Wallet: 'unknown' })
    expect(result.success).toBe(false)
  })
})

// ===========================================================================
// validateMappedRow
// ===========================================================================

const VALID_ADDRESS = 'G' + 'A'.repeat(55)

describe('validateMappedRow', () => {
  it('returns no errors for a valid row', () => {
    expect(validateMappedRow({ address: VALID_ADDRESS }, 2)).toEqual([])
  })

  it('returns MISSING_ADDRESS for an empty address', () => {
    const errors = validateMappedRow({ address: '' }, 3)
    expect(errors).toEqual([
      { row: 3, column: 'address', code: 'MISSING_ADDRESS', message: 'Missing address' },
    ])
  })

  it('returns INVALID_ADDRESS for a bad Stellar address', () => {
    const errors = validateMappedRow({ address: 'not-valid' }, 4)
    expect(errors).toEqual([
      { row: 4, column: 'address', code: 'INVALID_ADDRESS', message: 'Invalid Stellar address' },
    ])
  })

  it('returns INVALID_EMAIL when email is present but malformed', () => {
    const errors = validateMappedRow({ address: VALID_ADDRESS, email: 'not-an-email' }, 5)
    expect(errors).toEqual([
      { row: 5, column: 'email', code: 'INVALID_EMAIL', message: 'Invalid email address' },
    ])
  })

  it('allows empty email', () => {
    expect(validateMappedRow({ address: VALID_ADDRESS, email: '' }, 6)).toEqual([])
  })

  it('allows a valid email', () => {
    expect(
      validateMappedRow({ address: VALID_ADDRESS, email: 'user@example.com' }, 7),
    ).toEqual([])
  })
})

describe('zodIssueToImportError', () => {
  it('maps zod issues with custom error codes', () => {
    const parsed = importMappedRowSchema.safeParse({ address: '' })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      const mapped = zodIssueToImportError(parsed.error.issues[0], 10)
      expect(mapped.code).toBe('MISSING_ADDRESS')
      expect(mapped.row).toBe(10)
    }
  })

  it('falls back to VALIDATION_ERROR when no custom code is set', () => {
    const issue: z.ZodIssue = {
      code: z.ZodIssueCode.custom,
      path: ['field'],
      message: 'Something went wrong',
    }
    expect(zodIssueToImportError(issue, 1).code).toBe('VALIDATION_ERROR')
  })
})

describe('headersSatisfyMapping', () => {
  it('returns true when a header maps to address', () => {
    expect(headersSatisfyMapping(['Wallet', 'Email'], { Wallet: 'address' })).toBe(true)
  })

  it('returns false when no header maps to address', () => {
    expect(headersSatisfyMapping(['name', 'email'], { name: 'name' })).toBe(false)
  })

  it('matches headers case-insensitively', () => {
    expect(headersSatisfyMapping(['WALLET'], { wallet: 'address' })).toBe(true)
  })
})

// ===========================================================================
// dryRunImportFile
// ===========================================================================

function csvBuffer(headers: string, ...rows: string[]): Buffer {
  return Buffer.from([headers, ...rows].join('\n'), 'utf8')
}

describe('dryRunImportFile', () => {
  it('returns valid=true for a clean file', async () => {
    const buf = csvBuffer('address', VALID_ADDRESS)
    const result = await dryRunImportFile(buf)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.valid).toBe(true)
      expect(result.totalRows).toBe(1)
      expect(result.errors).toEqual([])
      expect(result.errorsTruncated).toBe(false)
    }
  })

  it('returns per-row errors for invalid rows', async () => {
    const buf = csvBuffer('address', 'bad-address', VALID_ADDRESS)
    const result = await dryRunImportFile(buf)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.valid).toBe(false)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toMatchObject({
        row: 2,
        column: 'address',
        code: 'INVALID_ADDRESS',
      })
    }
  })

  it('uses column mapping preset headers', async () => {
    const buf = csvBuffer(`Wallet,Email`, `${VALID_ADDRESS},user@example.com`)
    const result = await dryRunImportFile(buf, { Wallet: 'address', Email: 'email' })

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.valid).toBe(true)
      expect(result.totalRows).toBe(1)
    }
  })

  it('returns SchemaError when mapped address header is missing', async () => {
    const buf = csvBuffer('name,email', 'Alice,alice@example.com')
    const result = await dryRunImportFile(buf, DEFAULT_COLUMN_MAPPING)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('SchemaError')
      expect(result.row).toBe(1)
    }
  })

  it('returns valid=true with zero rows for header-only file', async () => {
    const result = await dryRunImportFile(Buffer.from('address\n', 'utf8'))
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.valid).toBe(true)
      expect(result.totalRows).toBe(0)
      expect(result.errors).toEqual([])
    }
  })

  it('returns valid=true with zero rows for empty file', async () => {
    const result = await dryRunImportFile(Buffer.from('', 'utf8'))
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.valid).toBe(true)
      expect(result.totalRows).toBe(0)
    }
  })

  it('detects duplicate addresses', async () => {
    const buf = csvBuffer('address', VALID_ADDRESS, VALID_ADDRESS)
    const result = await dryRunImportFile(buf)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.valid).toBe(false)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0].code).toBe('DUPLICATE_KEY')
      expect(result.errors[0].row).toBe(3)
    }
  })

  it('returns FileTooLarge for oversized buffer', async () => {
    const buf = Buffer.alloc(IMPORT_PREVIEW_MAX_FILE_BYTES + 1, 'a')
    const result = await dryRunImportFile(buf)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('FileTooLarge')
    }
  })

  it('returns InvalidEncoding for non-UTF-8 content', async () => {
    const buf = Buffer.from([0x61, 0x64, 0x64, 0x72, 0x65, 0x73, 0x73, 0x0a, 0x80])
    const result = await dryRunImportFile(buf)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('InvalidEncoding')
    }
  })

  it('returns CellTooLarge for oversized cell values', async () => {
    const huge = 'x'.repeat(IMPORT_PREVIEW_MAX_CELL_BYTES + 1)
    const buf = csvBuffer('address', huge)
    const result = await dryRunImportFile(buf)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('CellTooLarge')
      expect(result.row).toBe(2)
    }
  })

  it('returns ParseTimeout when startedAtMs is expired', async () => {
    const buf = csvBuffer('address', VALID_ADDRESS)
    const result = await dryRunImportFile(buf, DEFAULT_COLUMN_MAPPING, Date.now() - 60_000)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('ParseTimeout')
    }
  })

  it('caps reported errors and sets errorsTruncated', async () => {
    const rows = Array.from({ length: IMPORT_DRY_RUN_MAX_ERRORS + 5 }, () => 'bad')
    const buf = csvBuffer('address', ...rows)
    const result = await dryRunImportFile(buf)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.errors.length).toBe(IMPORT_DRY_RUN_MAX_ERRORS)
      expect(result.errorsTruncated).toBe(true)
      expect(result.valid).toBe(false)
    }
  })

  it('sets errorsTruncated when row limit is exceeded', async () => {
    const rows = Array.from({ length: IMPORT_PREVIEW_MAX_ROWS + 2 }, (_, i) => `bad${i}`)
    const content = ['address', ...rows].join('\n')
    const buf = Buffer.from(content, 'utf8')

    if (buf.length <= IMPORT_PREVIEW_MAX_FILE_BYTES) {
      const result = await dryRunImportFile(buf)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.errorsTruncated).toBe(true)
        expect(result.totalRows).toBe(IMPORT_PREVIEW_MAX_ROWS)
      }
    }
  })

  it('sets valid=false when row scan is truncated with no reported errors', async () => {
    const alphabet = 'ABCDEFGHIJKLM'
    const rows = Array.from(
      { length: 12 },
      (_, i) => 'G' + 'A'.repeat(54) + alphabet[i],
    )
    const buf = csvBuffer('address', ...rows)
    const result = await dryRunImportFile(buf, DEFAULT_COLUMN_MAPPING, Date.now(), 100, 10)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.valid).toBe(false)
      expect(result.errorsTruncated).toBe(true)
      expect(result.errors).toHaveLength(0)
      expect(result.totalRows).toBe(10)
    }
  })

  it('rejects invalid column mapping schema', async () => {
    const buf = csvBuffer('address', VALID_ADDRESS)
    const result = await dryRunImportFile(buf, { Email: 'email' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('SchemaError')
    }
  })

  it('handles mixed valid and invalid rows', async () => {
    const buf = Buffer.from(
      ['address', VALID_ADDRESS, '""', 'bad', VALID_ADDRESS].join('\n'),
      'utf8',
    )
    const result = await dryRunImportFile(buf)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.valid).toBe(false)
      expect(result.totalRows).toBe(4)
      expect(result.errors.length).toBeGreaterThanOrEqual(2)
    }
  })

  it('returns MalformedCsv when the parser throws', async () => {
    const buf = Buffer.from('address\n"unclosed quote row\n', 'utf8')
    const result = await dryRunImportFile(buf)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('MalformedCsv')
    }
  })

  it('truncates duplicate-key errors when the error cap is reached', async () => {
    const rows = Array.from({ length: IMPORT_DRY_RUN_MAX_ERRORS }, () => 'bad')
    rows.push(VALID_ADDRESS, VALID_ADDRESS)
    const buf = csvBuffer('address', ...rows)
    const result = await dryRunImportFile(buf, DEFAULT_COLUMN_MAPPING, Date.now(), 2)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.errors.length).toBe(2)
      expect(result.errorsTruncated).toBe(true)
    }
  })
})
