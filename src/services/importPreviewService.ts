import { parse, CsvError } from 'csv-parse/sync'
import { isValidStellarAddress } from '../lib/stellarAddress.js'

export const IMPORT_PREVIEW_MAX_FILE_BYTES = 512 * 1024
export const IMPORT_PREVIEW_MAX_ROWS = 10_000
export const IMPORT_PREVIEW_MAX_PARSE_MS = 5_000
export const IMPORT_PREVIEW_MAX_ROW_ERRORS = 100
export const IMPORT_PREVIEW_VALID_SAMPLE = 20
export const IMPORT_PREVIEW_INVALID_SAMPLE = 20

export interface ImportPreviewSummary {
  totalRowsScanned: number
  validRows: number
  invalidRows: number
  truncated: boolean
  truncatedReason: 'row_limit' | null
  totalDataRowsInFile?: number
}

export interface ImportPreviewRowError {
  line: number
  column?: 'address'
  code: string
  message: string
}

export interface ImportPreviewSuccessBody {
  success: true
  summary: ImportPreviewSummary
  preview: {
    validSample: Array<{ line: number; data: { address: string } }>
    invalidSample: Array<{ line: number; data: { address: string }; errors: string[] }>
  }
  rowErrors: ImportPreviewRowError[]
}

export interface ImportPreviewErrorBody {
  success: false
  status: number
  error: string
  code: string
  message: string
  line?: number
}

export type ImportPreviewResult = ImportPreviewSuccessBody | ImportPreviewErrorBody

function sanitizeCsvError(_err: unknown): string {
  return 'The file could not be parsed as CSV.'
}

export function previewImportFile(buffer: Buffer, startedAtMs: number = Date.now()): ImportPreviewResult {
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

  let rowsRaw: string[][]
  try {
    rowsRaw = parse(buffer, {
      skip_empty_lines: true,
      bom: true,
      trim: true,
      relax_column_count: false,
    }) as string[][]
  } catch (err) {
    if (err instanceof CsvError) {
      return {
        success: false,
        status: 400,
        error: 'InvalidRequest',
        code: 'MalformedCsv',
        message: sanitizeCsvError(err),
      }
    }
    return {
      success: false,
      status: 400,
      error: 'InvalidRequest',
      code: 'MalformedCsv',
      message: sanitizeCsvError(err),
    }
  }

  if (rowsRaw.length === 0) {
    return {
      success: true,
      summary: {
        totalRowsScanned: 0,
        validRows: 0,
        invalidRows: 0,
        truncated: false,
        truncatedReason: null,
      },
      preview: { validSample: [], invalidSample: [] },
      rowErrors: [],
    }
  }

  const header = rowsRaw[0].map((c) => String(c).trim())
  const addressColIndex = header.findIndex((c) => c.toLowerCase() === 'address')
  if (addressColIndex === -1) {
    return {
      success: false,
      status: 400,
      error: 'InvalidRequest',
      code: 'SchemaError',
      message: 'CSV header must include an "address" column.',
      line: 1,
    }
  }

  const dataRowCount = rowsRaw.length - 1
  const validSample: Array<{ line: number; data: { address: string } }> = []
  const invalidSample: Array<{ line: number; data: { address: string }; errors: string[] }> = []
  const rowErrors: ImportPreviewRowError[] = []

  let validRows = 0
  let invalidRows = 0
  let scanned = 0
  let truncated = false

  for (let i = 1; i < rowsRaw.length; i++) {
    if (Date.now() - startedAtMs > IMPORT_PREVIEW_MAX_PARSE_MS) {
      return {
        success: false,
        status: 408,
        error: 'RequestTimeout',
        code: 'ParseTimeout',
        message: 'Parsing the import file took too long.',
      }
    }

    if (scanned >= IMPORT_PREVIEW_MAX_ROWS) {
      truncated = true
      break
    }

    scanned++
    const lineNum = i + 1
    const row = rowsRaw[i]
    const raw = row[addressColIndex] !== undefined ? String(row[addressColIndex]).trim() : ''
    const messages: string[] = []
    const rowErrs: ImportPreviewRowError[] = []

    if (raw === '') {
      messages.push('Missing address')
      rowErrs.push({
        line: lineNum,
        column: 'address',
        code: 'MISSING_ADDRESS',
        message: 'Missing address',
      })
    } else if (!isValidStellarAddress(raw)) {
      messages.push('Invalid Stellar address')
      rowErrs.push({
        line: lineNum,
        column: 'address',
        code: 'INVALID_ADDRESS',
        message: 'Invalid Stellar address',
      })
    }

    if (rowErrs.length > 0) {
      invalidRows++
      if (rowErrors.length < IMPORT_PREVIEW_MAX_ROW_ERRORS) {
        rowErrors.push(...rowErrs)
      }
      if (invalidSample.length < IMPORT_PREVIEW_INVALID_SAMPLE) {
        invalidSample.push({ line: lineNum, data: { address: raw }, errors: messages })
      }
    } else {
      validRows++
      if (validSample.length < IMPORT_PREVIEW_VALID_SAMPLE) {
        validSample.push({ line: lineNum, data: { address: raw } })
      }
    }
  }

  const summary: ImportPreviewSummary = {
    totalRowsScanned: scanned,
    validRows,
    invalidRows,
    truncated,
    truncatedReason: truncated ? 'row_limit' : null,
  }
  if (truncated) {
    summary.totalDataRowsInFile = dataRowCount
  }

  return {
    success: true,
    summary,
    preview: { validSample, invalidSample },
    rowErrors,
  }
}
