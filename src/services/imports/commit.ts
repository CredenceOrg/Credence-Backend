import { parse } from 'csv-parse'
import { Readable } from 'stream'
import type { Queryable } from '../../db/repositories/queryable.js'
import {
  DEFAULT_COLUMN_MAPPING,
  buildColumnMapper,
  columnMappingSchema,
  dryRunImportFile,
  validateMappedRow,
  type ColumnMapping,
  type ImportDryRunErrorBody,
  type ImportDryRunResult,
  type ImportDryRunSuccessBody,
} from './mapping.js'
import {
  IMPORT_PREVIEW_MAX_CELL_BYTES,
  IMPORT_PREVIEW_MAX_FILE_BYTES,
  IMPORT_PREVIEW_MAX_PARSE_MS,
  IMPORT_PREVIEW_MAX_ROWS,
} from '../importPreviewService.js'

/** Persists validated import rows. */
export interface ImportCommitter {
  upsertRow(address: string, fields: Record<string, string>): Promise<void>
}

/** In-memory committer for tests — records upserted rows without touching the database. */
export class InMemoryImportCommitter implements ImportCommitter {
  readonly rows: Array<{ address: string; fields: Record<string, string> }> = []

  async upsertRow(address: string, fields: Record<string, string>): Promise<void> {
    this.rows.push({ address, fields: { ...fields } })
  }

  clear(): void {
    this.rows.length = 0
  }
}

/** PostgreSQL committer — upserts identities by Stellar address. */
export class PoolImportCommitter implements ImportCommitter {
  constructor(private readonly db: Queryable) {}

  async upsertRow(address: string, _fields: Record<string, string>): Promise<void> {
    await this.db.query(
      `INSERT INTO identities (address)
       VALUES ($1)
       ON CONFLICT (address) DO UPDATE SET updated_at = NOW()`,
      [address],
    )
  }
}

export interface ImportCommitSuccessBody {
  success: true
  committed: true
  totalRows: number
  imported: number
}

export type ImportCommitValidationFailure = ImportDryRunSuccessBody & { success: true; valid: false }

export type ImportCommitResult =
  | ImportCommitSuccessBody
  | ImportDryRunErrorBody
  | ImportCommitValidationFailure

async function persistValidatedImportRows(
  buffer: Buffer,
  columnMappings: ColumnMapping,
  committer: ImportCommitter,
  startedAtMs: number = Date.now(),
  maxRowsScan: number = IMPORT_PREVIEW_MAX_ROWS,
): Promise<number> {
  const parser = parse({
    skip_empty_lines: true,
    bom: true,
    trim: true,
    relax_column_count: false,
  })

  const readable = Readable.from(buffer)
  let isFirstRow = true
  let mapper: ((row: string[]) => Record<string, string>) | null = null
  let scanned = 0
  let imported = 0
  const seenAddresses = new Set<string>()

  for await (const row of readable.pipe(parser)) {
    if (isFirstRow) {
      isFirstRow = false
      const csvHeaders = row.map((c: unknown) => String(c).trim())
      mapper = buildColumnMapper(csvHeaders, columnMappings)
      continue
    }

    if (Date.now() - startedAtMs > IMPORT_PREVIEW_MAX_PARSE_MS) {
      throw new Error('ParseTimeout')
    }

    if (scanned >= maxRowsScan) {
      break
    }

    scanned++
    const cells = row as string[]

    for (const cell of cells) {
      const value = cell !== undefined ? String(cell).trim() : ''
      if (Buffer.byteLength(value, 'utf8') > IMPORT_PREVIEW_MAX_CELL_BYTES) {
        throw new Error('CellTooLarge')
      }
    }

    const remapped = mapper!(cells)
    const rowErrors = validateMappedRow(remapped, scanned + 1)
    if (rowErrors.length > 0) {
      throw new Error('ValidationFailed')
    }

    const address = remapped.address
    if (seenAddresses.has(address)) {
      throw new Error('DuplicateKey')
    }
    seenAddresses.add(address)

    await committer.upsertRow(address, remapped)
    imported++
  }

  return imported
}

/**
 * Validate then persist a CSV import file.
 * Callers should run {@link dryRunImportFile} with `?dryRun=true` first for a non-destructive check.
 */
export async function commitImportFile(
  buffer: Buffer,
  committer: ImportCommitter,
  columnMappings: ColumnMapping = DEFAULT_COLUMN_MAPPING,
): Promise<ImportCommitResult> {
  if (buffer.length > IMPORT_PREVIEW_MAX_FILE_BYTES) {
    return {
      success: false,
      status: 413,
      error: 'PayloadTooLarge',
      code: 'FileTooLarge',
      message: 'Import file exceeds the maximum allowed size.',
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

  const dryRun: ImportDryRunResult = await dryRunImportFile(buffer, columnMappings)
  if (!dryRun.success) {
    return dryRun
  }

  if (!dryRun.valid) {
    return dryRun
  }

  try {
    const imported = await persistValidatedImportRows(buffer, columnMappings, committer)
    return {
      success: true,
      committed: true,
      totalRows: dryRun.totalRows,
      imported,
    }
  } catch {
    return {
      success: false,
      status: 500,
      error: 'InternalServerError',
      code: 'CommitFailed',
      message: 'Import commit failed during persistence.',
    }
  }
}

/**
 * Returns true when the request query requests dry-run mode (`?dryRun=true`).
 */
export function isDryRunQuery(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true'
  }
  if (Array.isArray(value) && value.length > 0) {
    return isDryRunQuery(value[0])
  }
  return false
}
