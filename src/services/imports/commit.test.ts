import { describe, it, expect, beforeEach } from 'vitest'
import {
  commitImportFile,
  isDryRunQuery,
  InMemoryImportCommitter,
} from './commit.js'
import { IMPORT_PREVIEW_MAX_FILE_BYTES } from '../importPreviewService.js'

const VALID_ADDRESS = 'G' + 'A'.repeat(55)
const VALID_ADDRESS_2 = 'G' + 'B'.repeat(55)

function csvBuffer(...rows: string[]): Buffer {
  return Buffer.from(['address', ...rows].join('\n'), 'utf8')
}

describe('isDryRunQuery', () => {
  it('returns true for dryRun=true', () => {
    expect(isDryRunQuery('true')).toBe(true)
    expect(isDryRunQuery('TRUE')).toBe(true)
  })

  it('returns false for other values', () => {
    expect(isDryRunQuery('false')).toBe(false)
    expect(isDryRunQuery(undefined)).toBe(false)
    expect(isDryRunQuery(['true'])).toBe(true)
    expect(isDryRunQuery(['false'])).toBe(false)
  })
})

describe('commitImportFile', () => {
  let committer: InMemoryImportCommitter

  beforeEach(() => {
    committer = new InMemoryImportCommitter()
  })

  it('persists valid rows when the file passes validation', async () => {
    const buf = csvBuffer(VALID_ADDRESS, VALID_ADDRESS_2)
    const result = await commitImportFile(buf, committer)

    expect(result.success).toBe(true)
    if (result.success && 'committed' in result) {
      expect(result.committed).toBe(true)
      expect(result.imported).toBe(2)
      expect(result.totalRows).toBe(2)
    }
    expect(committer.rows).toHaveLength(2)
  })

  it('does not persist when validation fails', async () => {
    const buf = csvBuffer('not-valid')
    const result = await commitImportFile(buf, committer)

    expect(result.success).toBe(true)
    if (result.success && 'valid' in result) {
      expect(result.valid).toBe(false)
    }
    expect(committer.rows).toHaveLength(0)
  })

  it('returns FileTooLarge for oversized buffers', async () => {
    const buf = Buffer.alloc(IMPORT_PREVIEW_MAX_FILE_BYTES + 1, 'a')
    const result = await commitImportFile(buf, committer)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('FileTooLarge')
    }
  })
})
