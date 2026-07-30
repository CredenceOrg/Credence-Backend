#!/usr/bin/env tsx
/**
 * Migration lint CI gate (issue #681).
 *
 * Threat mitigated: a merge that introduces locking DDL —
 * `ADD COLUMN … NOT NULL` or non-concurrent `CREATE UNIQUE INDEX` —
 * can take production tables offline under write load (AccessExclusiveLock /
 * table rewrite). Without a PR-scoped gate, that risk ships unnoticed even when
 * historical migrations already contain similar patterns.
 *
 * This script only lints numbered migration files changed relative to the PR
 * base ref, so existing history does not block every PR.
 */
import { execSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  isNumberedMigrationFile,
  lintCiBlockingPatterns,
  type MigrationLintResult,
} from '../src/migrations/guardrails.js'

function changedMigrationFiles(baseRef: string): string[] {
  // Accept a full SHA or a ref name. Prefer three-dot diff from merge-base → HEAD.
  const raw = execSync(`git diff --name-only --diff-filter=ACMR ${baseRef}...HEAD -- src/migrations`, {
    encoding: 'utf8',
  })
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((path) => isNumberedMigrationFile(basename(path)))
}

export function lintChangedMigrations(paths: string[]): MigrationLintResult[] {
  const failures: MigrationLintResult[] = []
  for (const path of paths) {
    if (!existsSync(path)) continue
    const content = readFileSync(path, 'utf8')
    const result = lintCiBlockingPatterns(content, path)
    if (!result.ok) {
      failures.push(result)
    }
  }
  return failures
}

export function runCli(argv = process.argv.slice(2)): number {
  const baseArg = argv[0] ?? process.env.MIGRATION_LINT_BASE_SHA ?? process.env.GITHUB_BASE_REF
  if (!baseArg) {
    console.log(
      'migration-lint-ci: no base ref provided; skipping PR-scoped check (pass a git SHA/ref or MIGRATION_LINT_BASE_SHA).',
    )
    return 0
  }

  // Full SHAs are used as-is; short branch names are resolved via origin/.
  const looksLikeSha = /^[0-9a-f]{7,40}$/i.test(baseArg)
  const resolvedBase = looksLikeSha || baseArg.includes('/') ? baseArg : `origin/${baseArg}`

  let paths: string[]
  try {
    paths = changedMigrationFiles(resolvedBase)
  } catch (error) {
    console.error(
      `migration-lint-ci: failed to diff against ${resolvedBase}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return 1
  }

  if (paths.length === 0) {
    console.log('migration-lint-ci: no numbered migration files changed; OK')
    return 0
  }

  console.log(`migration-lint-ci: checking ${paths.length} changed migration(s):`)
  paths.forEach((p) => console.log(`  - ${p}`))

  const failures = lintChangedMigrations(paths)
  if (failures.length === 0) {
    console.log('migration-lint-ci: OK — no ADD COLUMN NOT NULL / CREATE UNIQUE INDEX blockers')
    return 0
  }

  for (const failure of failures) {
    if (failure.ok) continue
    console.error(`migration-lint-ci: [${failure.code}] ${failure.message}`)
    for (const issue of failure.issues) {
      console.error(`  suggestion: ${issue.suggestion}`)
    }
  }
  return 1
}

const entry = process.argv[1]
const isDirectRun = Boolean(entry && import.meta.url === pathToFileURL(entry).href)

if (isDirectRun) {
  process.exit(runCli())
}
