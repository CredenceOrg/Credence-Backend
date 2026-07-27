import { describe, it, expect } from 'vitest'
import {
  analyzeMigrationContent,
  lintCiBlockingPatterns,
  isNumberedMigrationFile,
} from '../guardrails.js'

/**
 * Negative tests for issue #681: these fixtures fail the CI gate today when the
 * blocking pattern is present, and pass once the migration uses a safe form.
 */
describe('migration CI blocking patterns (issue #681)', () => {
  it('fails with ADD_COLUMN_NOT_NULL for SQL ADD COLUMN … NOT NULL', () => {
    const content = `
export async function up(pgm) {
  await pgm.sql(\`ALTER TABLE identities ADD COLUMN slug TEXT NOT NULL\`)
}
export async function down(pgm) {}
`
    const result = lintCiBlockingPatterns(content, '999_bad_not_null.ts')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('ADD_COLUMN_NOT_NULL')
      expect(result.message).toContain('ADD_COLUMN_NOT_NULL')
      expect(result.issues.some((i) => i.code === 'ADD_COLUMN_NOT_NULL')).toBe(true)
    }
  })

  it('fails with CREATE_UNIQUE_INDEX for non-concurrent unique index SQL', () => {
    const content = `
export async function up(pgm) {
  await pgm.sql(\`CREATE UNIQUE INDEX idx_identities_slug ON identities (slug)\`)
}
export async function down(pgm) {}
`
    const result = lintCiBlockingPatterns(content, '999_bad_unique.ts')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('CREATE_UNIQUE_INDEX')
      expect(result.issues.some((i) => i.code === 'CREATE_UNIQUE_INDEX')).toBe(true)
    }
  })

  it('fails with ADD_COLUMN_NOT_NULL for pgm.addColumn with notNull: true', () => {
    const content = `
/** docs */
export async function up(pgm) {
  pgm.addColumn('identities', 'slug', { type: 'text', notNull: true })
}
export async function down(pgm) {}
`
    const result = lintCiBlockingPatterns(content, '999_bad_pgm_not_null.ts')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('ADD_COLUMN_NOT_NULL')
    }
  })

  it('fails with CREATE_UNIQUE_INDEX for pgm.createIndex with unique: true', () => {
    const content = `
/** docs */
export async function up(pgm) {
  pgm.createIndex('identities', 'slug', { unique: true })
}
export async function down(pgm) {}
`
    const result = lintCiBlockingPatterns(content, '999_bad_pgm_unique.ts')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('CREATE_UNIQUE_INDEX')
    }
  })

  it('passes when ADD COLUMN is nullable', () => {
    const content = `
/**
 * Safe: nullable column first.
 */
export async function up(pgm) {
  await pgm.sql(\`ALTER TABLE identities ADD COLUMN slug TEXT NULL\`)
}
export async function down(pgm) {
  await pgm.sql(\`ALTER TABLE identities DROP COLUMN slug\`)
}
`
    const result = lintCiBlockingPatterns(content, '999_safe_null.ts')
    expect(result.ok).toBe(true)
  })

  it('passes when CREATE UNIQUE INDEX uses CONCURRENTLY', () => {
    const content = `
/**
 * Safe: concurrent unique index.
 */
export async function up(pgm) {
  await pgm.sql(\`CREATE UNIQUE INDEX CONCURRENTLY idx_identities_slug ON identities (slug)\`)
}
export async function down(pgm) {
  await pgm.sql(\`DROP INDEX CONCURRENTLY IF EXISTS idx_identities_slug\`)
}
`
    const result = lintCiBlockingPatterns(content, '999_safe_concurrent.ts')
    expect(result.ok).toBe(true)
  })

  it('passes when pgm.createIndex sets unique with concurrently: true', () => {
    const content = `
/**
 * Safe online unique index via pgm API.
 */
export async function up(pgm) {
  pgm.createIndex('identities', 'slug', { unique: true, concurrently: true })
}
export async function down(pgm) {
  pgm.dropIndex('identities', 'slug', { concurrently: true })
}
`
    const result = lintCiBlockingPatterns(content, '999_safe_pgm_concurrent.ts')
    expect(result.ok).toBe(true)
  })
})

describe('analyzeMigrationContent', () => {
  it('attaches typed codes on blocking SQL matches', () => {
    const result = analyzeMigrationContent(
      'ALTER TABLE t ADD COLUMN c TEXT NOT NULL;\n',
      'fixture.ts',
    )
    expect(result.passed).toBe(false)
    expect(result.issues[0]?.code).toBe('ADD_COLUMN_NOT_NULL')
  })

  it('ignores comment-only lines that mention blocked patterns', () => {
    const result = analyzeMigrationContent(
      `// CREATE UNIQUE INDEX bad ON t (c)\n/** ADD COLUMN x NOT NULL */\nexport async function up() {}\nexport async function down() {}\n`,
      'fixture.ts',
    )
    const ci = lintCiBlockingPatterns(
      `// CREATE UNIQUE INDEX bad ON t (c)\n/** ADD COLUMN x NOT NULL */\nexport async function up() {}\nexport async function down() {}\n`,
      'fixture.ts',
    )
    expect(ci.ok).toBe(true)
    expect(result.issues.filter((i) => i.code === 'CREATE_UNIQUE_INDEX')).toHaveLength(0)
  })
})

describe('isNumberedMigrationFile', () => {
  it('accepts numbered migrations only', () => {
    expect(isNumberedMigrationFile('001_initial_schema.ts')).toBe(true)
    expect(isNumberedMigrationFile('guardrails.ts')).toBe(false)
    expect(isNumberedMigrationFile('example-guardrails-migration.ts')).toBe(false)
    expect(isNumberedMigrationFile('001_foo.test.ts')).toBe(false)
  })
})
