import { randomUUID } from 'node:crypto'
import { parse } from 'csv-parse'
import { Readable } from 'stream'
import { z } from 'zod'
import type { Queryable } from '../../db/repositories/queryable.js'
import { isValidStellarAddress } from '../../lib/stellarAddress.js'
import {
  IMPORT_PREVIEW_MAX_CELL_BYTES,
  IMPORT_PREVIEW_MAX_FILE_BYTES,
  IMPORT_PREVIEW_MAX_PARSE_MS,
  IMPORT_PREVIEW_MAX_ROW_ERRORS,
  IMPORT_PREVIEW_MAX_ROWS,
} from '../importPreviewService.js'

export type ColumnMapping = Record<string, string>

export interface ImportMappingPreset {
  id: string
  orgId: string
  name: string
  version: number
  columnMappings: ColumnMapping
  createdAt: Date
  updatedAt: Date
}

export interface CreateMappingPresetInput {
  orgId: string
  name: string
  columnMappings: ColumnMapping
}

export interface UpdateMappingPresetInput {
  name?: string
  columnMappings?: ColumnMapping
}

interface PresetRow {
  id: string
  org_id: string
  name: string
  version: number
  column_mappings: ColumnMapping
  created_at: Date
  updated_at: Date
}

function mapRow(row: PresetRow): ImportMappingPreset {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    version: row.version,
    columnMappings: row.column_mappings,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class MappingPresetRepository {
  constructor(private readonly db: Queryable) {}

  async findByOrg(orgId: string): Promise<ImportMappingPreset[]> {
    const result = await this.db.query<PresetRow>(
      `SELECT id, org_id, name, version, column_mappings, created_at, updated_at
       FROM import_mapping_presets
       WHERE org_id = $1
       ORDER BY name, version DESC`,
      [orgId],
    )
    return result.rows.map(mapRow)
  }

  async findById(id: string): Promise<ImportMappingPreset | null> {
    const result = await this.db.query<PresetRow>(
      `SELECT id, org_id, name, version, column_mappings, created_at, updated_at
       FROM import_mapping_presets
       WHERE id = $1`,
      [id],
    )
    return result.rows[0] ? mapRow(result.rows[0]) : null
  }

  async create(input: CreateMappingPresetInput): Promise<ImportMappingPreset> {
    const id = randomUUID()
    const existing = await this.db.query<{ max_version: number | null }>(
      `SELECT MAX(version) AS max_version
       FROM import_mapping_presets
       WHERE org_id = $1 AND name = $2`,
      [input.orgId, input.name],
    )
    const nextVersion = (existing.rows[0]?.max_version ?? 0) + 1

    const result = await this.db.query<PresetRow>(
      `INSERT INTO import_mapping_presets (id, org_id, name, version, column_mappings)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, org_id, name, version, column_mappings, created_at, updated_at`,
      [id, input.orgId, input.name, nextVersion, JSON.stringify(input.columnMappings)],
    )
    return mapRow(result.rows[0])
  }

  async update(id: string, input: UpdateMappingPresetInput): Promise<ImportMappingPreset | null> {
    const sets: string[] = []
    const params: unknown[] = []
    let paramIdx = 1

    if (input.name !== undefined) {
      sets.push(`name = $${paramIdx++}`)
      params.push(input.name)
    }
    if (input.columnMappings !== undefined) {
      sets.push(`column_mappings = $${paramIdx++}`)
      params.push(JSON.stringify(input.columnMappings))
    }

    if (sets.length === 0) {
      return this.findById(id)
    }

    sets.push(`version = version + 1`)
    sets.push(`updated_at = NOW()`)

    params.push(id)
    const result = await this.db.query<PresetRow>(
      `UPDATE import_mapping_presets
       SET ${sets.join(', ')}
       WHERE id = $${paramIdx}
       RETURNING id, org_id, name, version, column_mappings, created_at, updated_at`,
      params,
    )
    return result.rows[0] ? mapRow(result.rows[0]) : null
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM import_mapping_presets WHERE id = $1`,
      [id],
    )
    return (result.rowCount ?? 0) > 0
  }
}

export class InMemoryMappingPresetRepository {
  private presets: ImportMappingPreset[] = []

  async findByOrg(orgId: string): Promise<ImportMappingPreset[]> {
    return this.presets
      .filter((p) => p.orgId === orgId)
      .sort((a, b) => a.name.localeCompare(b.name) || b.version - a.version)
  }

  async findById(id: string): Promise<ImportMappingPreset | null> {
    return this.presets.find((p) => p.id === id) ?? null
  }

  async create(input: CreateMappingPresetInput): Promise<ImportMappingPreset> {
    const existing = this.presets
      .filter((p) => p.orgId === input.orgId && p.name === input.name)
      .reduce((max, p) => Math.max(max, p.version), 0)
    const nextVersion = existing + 1

    const preset: ImportMappingPreset = {
      id: randomUUID(),
      orgId: input.orgId,
      name: input.name,
      version: nextVersion,
      columnMappings: { ...input.columnMappings },
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    this.presets.push(preset)
    return { ...preset, columnMappings: { ...preset.columnMappings } }
  }

  async update(id: string, input: UpdateMappingPresetInput): Promise<ImportMappingPreset | null> {
    const idx = this.presets.findIndex((p) => p.id === id)
    if (idx === -1) return null

    const preset = this.presets[idx]
    let changed = false
    if (input.name !== undefined) { preset.name = input.name; changed = true }
    if (input.columnMappings !== undefined) { preset.columnMappings = { ...input.columnMappings }; changed = true }

    if (!changed) {
      return { ...preset, columnMappings: { ...preset.columnMappings } }
    }

    preset.version += 1
    preset.updatedAt = new Date()
    this.presets[idx] = { ...preset, columnMappings: { ...preset.columnMappings } }
    return { ...preset, columnMappings: { ...preset.columnMappings } }
  }

  async delete(id: string): Promise<boolean> {
    const idx = this.presets.findIndex((p) => p.id === id)
    if (idx === -1) return false
    this.presets.splice(idx, 1)
    return true
  }

  clear(): void {
    this.presets = []
  }
}

const FORMULA_INJECTION_PREFIXES = new Set(['=', '+', '-', '@', '\t', '\r'])

function sanitizeCellValue(value: string): string {
  if (value.length > 0 && FORMULA_INJECTION_PREFIXES.has(value[0])) {
    return `\t${value}`
  }
  return value
}

export function stripBom(text: string): string {
  if (text.charCodeAt(0) === 0xfeff) {
    return text.slice(1)
  }
  return text
}

export function buildColumnMapper(
  csvHeaders: string[],
  columnMappings: ColumnMapping,
): (row: string[]) => Record<string, string> {
  const normalizedHeaders = csvHeaders.map((h) => stripBom(h).toLowerCase())

  const canonicalToCsvIndex = new Map<string, number>()

  for (const [csvHeader, canonicalColumn] of Object.entries(columnMappings)) {
    const normalizedCsv = csvHeader.toLowerCase()
    const idx = normalizedHeaders.indexOf(normalizedCsv)
    if (idx !== -1) {
      canonicalToCsvIndex.set(canonicalColumn, idx)
    }
  }

  return (row: string[]): Record<string, string> => {
    const result: Record<string, string> = {}
    for (const [canonical, csvIdx] of canonicalToCsvIndex) {
      const raw = csvIdx < row.length ? row[csvIdx] : ''
      result[canonical] = sanitizeCellValue(raw !== undefined ? String(raw).trim() : '')
    }
    return result
  }
}

export function applyPresetToPreview(
  rawRows: string[][],
  csvHeaders: string[],
  columnMappings: ColumnMapping,
): Array<{ remapped: Record<string, string>; line: number }> {
  const mapper = buildColumnMapper(csvHeaders, columnMappings)
  return rawRows.map((row, idx) => ({
    remapped: mapper(row),
    line: idx + 2,
  }))
}

/** Default column mapping when no preset is supplied (CSV header `address` → canonical `address`). */
export const DEFAULT_COLUMN_MAPPING: ColumnMapping = { address: 'address' }

/** Maximum row-level errors returned in a dry-run response before truncation. */
export const IMPORT_DRY_RUN_MAX_ERRORS = IMPORT_PREVIEW_MAX_ROW_ERRORS

/** Canonical columns supported by the import mapping schema. */
export const CANONICAL_IMPORT_COLUMNS = ['address', 'email', 'name'] as const

export type CanonicalImportColumn = (typeof CANONICAL_IMPORT_COLUMNS)[number]

/** Per-row validation error returned by the dry-run endpoint. */
export interface ImportDryRunRowError {
  row: number
  column: string
  code: string
  message: string
}

export interface ImportDryRunSuccessBody {
  success: true
  valid: boolean
  totalRows: number
  errors: ImportDryRunRowError[]
  errorsTruncated: boolean
}

export interface ImportDryRunErrorBody {
  success: false
  status: number
  error: string
  code: string
  message: string
  row?: number
}

export type ImportDryRunResult = ImportDryRunSuccessBody | ImportDryRunErrorBody

/**
 * Zod schema for column-mapping preset values.
 * Every mapping must target a known canonical column and include `address`.
 */
export const columnMappingSchema = z
  .record(z.string().min(1), z.enum(CANONICAL_IMPORT_COLUMNS))
  .refine(
    (mappings) => Object.values(mappings).includes('address'),
    { message: 'Column mapping must include the address canonical column' },
  )

/**
 * Zod schema for a mapped import row after column remapping.
 * Validates required `address` and optional `email`/`name` fields.
 */
export const importMappedRowSchema = z
  .object({
    address: z.string(),
    email: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough()
  .superRefine((data, ctx) => {
    if (!data.address || data.address.trim() === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['address'],
        message: 'Missing address',
      })
    } else if (!isValidStellarAddress(data.address)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['address'],
        message: 'Invalid Stellar address',
      })
    }

    if (data.email !== undefined && data.email !== '') {
      const emailResult = z.string().email().safeParse(data.email)
      if (!emailResult.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['email'],
          message: 'Invalid email address',
        })
      }
    }
  })

/**
 * Convert a Zod issue from {@link importMappedRowSchema} into a row-level import error.
 */
export function zodIssueToImportError(issue: z.ZodIssue, row: number): ImportDryRunRowError {
  const column = String(issue.path[0] ?? 'unknown')
  let code = 'VALIDATION_ERROR'

  if (column === 'address') {
    if (issue.message === 'Missing address') {
      code = 'MISSING_ADDRESS'
    } else if (issue.message === 'Invalid Stellar address') {
      code = 'INVALID_ADDRESS'
    }
  } else if (column === 'email' && issue.message === 'Invalid email address') {
    code = 'INVALID_EMAIL'
  }

  return {
    row,
    column,
    code,
    message: issue.message,
  }
}

/**
 * Validate a single remapped CSV row against the import mapping schema.
 * Returns an empty array when the row is valid.
 */
export function validateMappedRow(
  remapped: Record<string, string>,
  row: number,
): ImportDryRunRowError[] {
  const parsed = importMappedRowSchema.safeParse(remapped)
  if (parsed.success) {
    return []
  }
  return parsed.error.issues.map((issue) => zodIssueToImportError(issue, row))
}

/**
 * Verify that the CSV headers can satisfy the active column-mapping schema
 * (at least one header must map to the required `address` canonical column).
 */
export function headersSatisfyMapping(
  csvHeaders: string[],
  columnMappings: ColumnMapping,
): boolean {
  const normalizedHeaders = csvHeaders.map((h) => stripBom(h).toLowerCase())
  return Object.entries(columnMappings).some(
    ([csvHeader, canonical]) =>
      canonical === 'address' && normalizedHeaders.includes(csvHeader.toLowerCase()),
  )
}

function sanitizeCsvError(_err: unknown): string {
  return 'The file could not be parsed as CSV.'
}

function pushRowErrors(
  errors: ImportDryRunRowError[],
  newErrors: ImportDryRunRowError[],
  maxErrors: number,
): boolean {
  let truncated = false
  for (const err of newErrors) {
    if (errors.length >= maxErrors) {
      truncated = true
      break
    }
    errors.push(err)
  }
  return truncated
}

/**
 * Parse and validate a CSV import file in dry-run mode.
 *
 * Streams the file with csv-parse (no full-file materialisation beyond the upload
 * buffer), applies the active column mapping, and returns a per-row validation report
 * without persisting any data.
 *
 * @param buffer - Raw CSV bytes (must be within {@link IMPORT_PREVIEW_MAX_FILE_BYTES}).
 * @param columnMappings - Active column-mapping schema (defaults to {@link DEFAULT_COLUMN_MAPPING}).
 * @param startedAtMs - Parse start timestamp for timeout enforcement.
 * @param maxErrors - Maximum row errors returned before {@link ImportDryRunSuccessBody.errorsTruncated}.
 */
export async function dryRunImportFile(
  buffer: Buffer,
  columnMappings: ColumnMapping = DEFAULT_COLUMN_MAPPING,
  startedAtMs: number = Date.now(),
  maxErrors: number = IMPORT_DRY_RUN_MAX_ERRORS,
  maxRowsScan: number = IMPORT_PREVIEW_MAX_ROWS,
): Promise<ImportDryRunResult> {
  if (buffer.length > IMPORT_PREVIEW_MAX_FILE_BYTES) {
    return {
      success: false,
      status: 413,
      error: 'PayloadTooLarge',
      code: 'FileTooLarge',
      message: 'Import file exceeds the maximum allowed size.',
    }
  }

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return {
      success: false,
      status: 400,
      error: 'InvalidRequest',
      code: 'InvalidEncoding',
      message: 'File must be valid UTF-8 text.',
    }
  }

  const mappingParse = columnMappingSchema.safeParse(columnMappings)
  if (!mappingParse.success) {
    return {
      success: false,
      status: 400,
      error: 'InvalidRequest',
      code: 'SchemaError',
      message: mappingParse.error.issues[0]?.message ?? 'Invalid column mapping schema.',
      row: 1,
    }
  }

  const parser = parse({
    skip_empty_lines: true,
    bom: true,
    trim: true,
    relax_column_count: false,
  })

  const readable = Readable.from(buffer)

  let isFirstRow = true
  let csvHeaders: string[] = []
  let mapper: ((row: string[]) => Record<string, string>) | null = null

  const errors: ImportDryRunRowError[] = []
  let errorsTruncated = false
  let totalRows = 0
  let scanned = 0
  const seenAddresses = new Map<string, number>()

  try {
    for await (const row of readable.pipe(parser)) {
      if (isFirstRow) {
        isFirstRow = false
        csvHeaders = row.map((c: unknown) => String(c).trim())

        if (!headersSatisfyMapping(csvHeaders, columnMappings)) {
          return {
            success: false,
            status: 400,
            error: 'InvalidRequest',
            code: 'SchemaError',
            message: 'CSV header must include a column mapped to "address".',
            row: 1,
          }
        }

        mapper = buildColumnMapper(csvHeaders, columnMappings)
        continue
      }

      totalRows++

      if (Date.now() - startedAtMs > IMPORT_PREVIEW_MAX_PARSE_MS) {
        return {
          success: false,
          status: 408,
          error: 'RequestTimeout',
          code: 'ParseTimeout',
          message: 'Parsing the import file took too long.',
        }
      }

      if (scanned >= maxRowsScan) {
        continue
      }

      scanned++
      const rowNum = totalRows + 1
      const cells = row as string[]

      for (const cell of cells) {
        const value = cell !== undefined ? String(cell).trim() : ''
        if (Buffer.byteLength(value, 'utf8') > IMPORT_PREVIEW_MAX_CELL_BYTES) {
          return {
            success: false,
            status: 400,
            error: 'InvalidRequest',
            code: 'CellTooLarge',
            message: `Cell value on row ${rowNum} exceeds the maximum allowed size of ${IMPORT_PREVIEW_MAX_CELL_BYTES} bytes.`,
            row: rowNum,
          }
        }
      }

      const remapped = mapper!(cells)
      const rowErrors = validateMappedRow(remapped, rowNum)

      if (rowErrors.length === 0) {
        const address = remapped.address
        if (seenAddresses.has(address)) {
          const duplicateError: ImportDryRunRowError = {
            row: rowNum,
            column: 'address',
            code: 'DUPLICATE_KEY',
            message: `Duplicate address (first seen on row ${seenAddresses.get(address)})`,
          }
          if (pushRowErrors(errors, [duplicateError], maxErrors)) {
            errorsTruncated = true
          }
        } else {
          seenAddresses.set(address, rowNum)
        }
      } else if (pushRowErrors(errors, rowErrors, maxErrors)) {
        errorsTruncated = true
      }

      if (errors.length >= maxErrors) {
        errorsTruncated = true
      }
    }
  } catch {
    return {
      success: false,
      status: 400,
      error: 'InvalidRequest',
      code: 'MalformedCsv',
      message: sanitizeCsvError(undefined),
    }
  }

  if (isFirstRow) {
    return {
      success: true,
      valid: true,
      totalRows: 0,
      errors: [],
      errorsTruncated: false,
    }
  }

  const rowScanTruncated = scanned < totalRows
  if (rowScanTruncated) {
    errorsTruncated = true
  }

  return {
    success: true,
    valid: errors.length === 0 && !rowScanTruncated,
    totalRows: scanned,
    errors,
    errorsTruncated,
  }
}
