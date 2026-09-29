import { createHash, randomUUID } from 'node:crypto'
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
import { recordImportRows } from './metrics.js'

/** Persists validated import rows. */
export interface ImportCommitter {
  upsertRow(address: string, fields: Record<string, string>): Promise<void>
}

export type ImportRowStatus = 'accepted' | 'rejected' | 'retryable'

export interface ImportRowOutcome {
  row: number
  rowKey: string
  status: ImportRowStatus
  code: string
  message: string
}

export interface ImportCheckpoint {
  operationId: string
  fingerprint: string
  outcomes: Map<string, ImportRowOutcome>
  completed: boolean
}

export interface ImportCheckpointStore {
  get(key: string): ImportCheckpoint | undefined
  create(key: string, checkpoint: ImportCheckpoint): ImportCheckpoint
  withLock?<T>(key: string, work: () => Promise<T>): Promise<T>
}

/** Process-local checkpoint store; production can replace it with a DB/Redis adapter. */
export class InMemoryImportCheckpointStore implements ImportCheckpointStore {
  private checkpoints = new Map<string, ImportCheckpoint>()
  private locks = new Map<string, Promise<void>>()

  get(key: string): ImportCheckpoint | undefined {
    return this.checkpoints.get(key)
  }

  create(key: string, checkpoint: ImportCheckpoint): ImportCheckpoint {
    this.checkpoints.set(key, checkpoint)
    return checkpoint
  }

  clear(): void {
    this.checkpoints.clear()
    this.locks.clear()
  }

  async withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    let release!: () => void
    const turn = new Promise<void>((resolve) => { release = resolve })
    const queued = previous.then(() => turn)
    this.locks.set(key, queued)
    await previous
    try {
      return await work()
    } finally {
      release()
      if (this.locks.get(key) === queued) this.locks.delete(key)
    }
  }
}

export const importCheckpointStore = new InMemoryImportCheckpointStore()

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
  committed: boolean
  totalRows: number
  imported: number
  operationId: string
  partial: boolean
  accepted: number
  rejected: number
  retried: number
  rowOutcomes: ImportRowOutcome[]
}

export type ImportCommitValidationFailure = ImportDryRunSuccessBody & {
  success: true
  valid: false
  rowOutcomes?: ImportRowOutcome[]
}

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

interface ValidatedImportRow {
  row: number
  fields: Record<string, string>
}

/** Parse the already dry-run-validated file into write-ready rows. */
async function collectValidatedImportRows(
  buffer: Buffer,
  columnMappings: ColumnMapping,
): Promise<ValidatedImportRow[]> {
  const parser = parse({ skip_empty_lines: true, bom: true, trim: true, relax_column_count: false })
  const rows: ValidatedImportRow[] = []
  const readable = Readable.from(buffer)
  let isFirstRow = true
  let mapper: ((row: string[]) => Record<string, string>) | null = null
  let rowNumber = 0

  for await (const row of readable.pipe(parser)) {
    if (isFirstRow) {
      isFirstRow = false
      mapper = buildColumnMapper(
        (row as unknown[]).map((cell) => String(cell).trim()),
        columnMappings,
      )
      continue
    }
    rowNumber++
    rows.push({ row: rowNumber + 1, fields: mapper!((row as string[])) })
  }
  return rows
}

function importFingerprint(buffer: Buffer, columnMappings: ColumnMapping): string {
  return createHash('sha256')
    .update(buffer)
    .update(JSON.stringify(columnMappings))
    .digest('hex')
}

function stableRowKey(fingerprint: string, row: ValidatedImportRow): string {
  return createHash('sha256')
    .update(`${fingerprint}:${row.row}:${JSON.stringify(row.fields)}`)
    .digest('hex')
}

function validationOutcomes(result: ImportDryRunSuccessBody): ImportRowOutcome[] {
  return result.errors.map((error) => ({
    row: error.row,
    rowKey: `rejected:${error.row}`,
    status: 'rejected',
    code: error.code,
    message: error.message,
  }))
}

export interface ImportCommitOptions {
  /** Stable client key for retries of one logical import. */
  idempotencyKey?: string
  /** Trusted tenant identity used to prevent cross-tenant key reuse. */
  tenantId?: string
  checkpointStore?: ImportCheckpointStore
}

/**
 * Validate then persist a CSV import file.
 * Callers should run {@link dryRunImportFile} with `?dryRun=true` first for a non-destructive check.
 */
export async function commitImportFile(
  buffer: Buffer,
  committer: ImportCommitter,
  columnMappings: ColumnMapping = DEFAULT_COLUMN_MAPPING,
  options: ImportCommitOptions = {},
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
    // Row-level validation failed: surface the dry-run report as a commit
    // validation failure (no rows are persisted).
    recordImportRows('rejected', dryRun.errors.length)
    return { ...dryRun, valid: false, rowOutcomes: validationOutcomes(dryRun) }
  }

  try {
    const rows = await collectValidatedImportRows(buffer, columnMappings)
    const fingerprint = importFingerprint(buffer, columnMappings)
    const idempotencyKey = options.idempotencyKey?.trim()
    const scopedKey = idempotencyKey
      ? `${options.tenantId ?? 'anonymous'}:${idempotencyKey}`
      : `operation:${randomUUID()}`
    const checkpoints = options.checkpointStore ?? importCheckpointStore
    const execute = async (): Promise<ImportCommitResult> => {
      let checkpoint = checkpoints.get(scopedKey)
      if (checkpoint && checkpoint.fingerprint !== fingerprint) {
        return {
          success: false,
          status: 409,
          error: 'Conflict',
          code: 'IdempotencyConflict',
          message: 'Idempotency key was reused with a different import file or mapping.',
        }
      }
      if (!checkpoint) {
        checkpoint = checkpoints.create(scopedKey, {
          operationId: `import_${randomUUID()}`,
          fingerprint,
          outcomes: new Map(),
          completed: false,
        })
      }

      const rowOutcomes: ImportRowOutcome[] = []
      let accepted = 0
      let retried = 0
      for (const row of rows) {
        const key = stableRowKey(fingerprint, row)
        const previous = checkpoint.outcomes.get(key)
        if (previous?.status === 'accepted') {
          rowOutcomes.push(previous)
          accepted++
          continue
        }
        if (previous?.status === 'retryable') retried++

        try {
          await committer.upsertRow(row.fields.address, row.fields)
          const outcome: ImportRowOutcome = {
            row: row.row,
            rowKey: key,
            status: 'accepted',
            code: 'IMPORTED',
            message: 'Row imported successfully.',
          }
          checkpoint.outcomes.set(key, outcome)
          rowOutcomes.push(outcome)
          accepted++
          recordImportRows('accepted')
        } catch {
          const outcome: ImportRowOutcome = {
            row: row.row,
            rowKey: key,
            status: 'retryable',
            code: 'CommitFailed',
            message: 'Row could not be imported; retry the operation.',
          }
          checkpoint.outcomes.set(key, outcome)
          rowOutcomes.push(outcome)
          recordImportRows('rejected')
        }
      }

      const retryable = rowOutcomes.filter((outcome) => outcome.status === 'retryable').length
      checkpoint.completed = retryable === 0
      recordImportRows('retried', retried)
      return {
        success: true,
        committed: retryable === 0,
        totalRows: rows.length,
        imported: accepted,
        operationId: checkpoint.operationId,
        partial: retryable > 0,
        accepted,
        rejected: 0,
        retried,
        rowOutcomes,
      }
    }
    return checkpoints.withLock ? checkpoints.withLock(scopedKey, execute) : execute()
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
