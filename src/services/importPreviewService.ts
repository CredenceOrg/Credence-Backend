import { parse } from 'csv-parse'
import { Readable } from 'stream'
import { isValidStellarAddress } from '../lib/stellarAddress.js'

export const IMPORT_PREVIEW_MAX_FILE_BYTES = 512 * 1024
export const IMPORT_PREVIEW_MAX_ROWS = 10_000
export const IMPORT_PREVIEW_MAX_PARSE_MS = 5_000
export const IMPORT_PREVIEW_MAX_ROW_ERRORS = 100
export const IMPORT_PREVIEW_VALID_SAMPLE = 20
export const IMPORT_PREVIEW_INVALID_SAMPLE = 20
/** Maximum byte length of any single cell value. Cells exceeding this are rejected with a 400. */
export const IMPORT_PREVIEW_MAX_CELL_BYTES = 1_024

/**
 * Characters that begin spreadsheet formula-injection sequences.
 * Cells starting with these are sanitized in preview output by prefixing a tab
 * so they render as plain text if the response is opened in a spreadsheet app.
 */
const FORMULA_INJECTION_PREFIXES = new Set(['=', '+', '-', '@', '\t', '\r'])

/**
 * Sanitize a cell value for safe inclusion in preview output.
 * Cells that start with a formula-injection character are prefixed with a tab.
 */
function sanitizeCellValue(value: string): string {
  if (value.length > 0 && FORMULA_INJECTION_PREFIXES.has(value[0])) {
    return `\t${value}`
  }
  return value
}

function sanitizeCsvError(_err: unknown): string {
  return 'The file could not be parsed as CSV.'
}

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
    invalidSample: Array<{
      line: number
      data: { address: string }
      errors: string[]
    }>
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

export type ImportPreviewResult =
  | ImportPreviewSuccessBody
  | ImportPreviewErrorBody

export async function previewImportFile(
  buffer: Buffer,
  startedAtMs: number = Date.now()
): Promise<ImportPreviewResult> {
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

  const parser = parse({
    skip_empty_lines: true,
    bom: true,
    trim: true,
    relax_column_count: false,
  })

  const readable = Readable.from(buffer)

  let isFirstRow = true
  let addressColIndex = -1

  const validSample: Array<{ line: number; data: { address: string } }> = []
  const invalidSample: Array<{
    line: number
    data: { address: string }
    errors: string[]
  }> = []
  const rowErrors: ImportPreviewRowError[] = []

  let validRows = 0
  let invalidRows = 0
  let scanned = 0
  let truncated = false
  let dataRowCount = 0

  try {
    // Streaming async iterator prevents event-loop blocking
    for await (const row of readable.pipe(parser)) {
      if (isFirstRow) {
        isFirstRow = false
        const header = row.map((c: any) => String(c).trim())
        addressColIndex = header.findIndex(
          (c: string) => c.toLowerCase() === 'address'
        )
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
        continue
      }

      dataRowCount++

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
        continue // keep consuming the stream to get accurate totalDataRowsInFile
      }

      scanned++
      const lineNum = dataRowCount + 1
      const rawCell =
        row[addressColIndex] !== undefined
          ? String(row[addressColIndex]).trim()
          : ''

      // Reject oversized cells before any further processing
      if (Buffer.byteLength(rawCell, 'utf8') > IMPORT_PREVIEW_MAX_CELL_BYTES) {
        return {
          success: false,
          status: 400,
          error: 'InvalidRequest',
          code: 'CellTooLarge',
          message: `Cell value on line ${lineNum} exceeds the maximum allowed size of ${IMPORT_PREVIEW_MAX_CELL_BYTES} bytes.`,
          line: lineNum,
        }
      }

      const raw = rawCell
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
          invalidSample.push({
            line: lineNum,
            data: { address: sanitizeCellValue(raw) },
            errors: messages,
          })
        }
      } else {
        validRows++
        if (validSample.length < IMPORT_PREVIEW_VALID_SAMPLE) {
          validSample.push({
            line: lineNum,
            data: { address: sanitizeCellValue(raw) },
          })
        }
      }
    }
  } catch (err) {
    return {
      success: false,
      status: 400,
      error: 'InvalidRequest',
      code: 'MalformedCsv',
      message: sanitizeCsvError(err),
    }
  }

  if (isFirstRow) {
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
