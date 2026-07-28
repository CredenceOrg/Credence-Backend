#!/usr/bin/env tsx
/**
 * invalidateTenantCache.ts — Support CLI for clearing a single tenant's
 * cached data without restarting the service.
 *
 * Usage:
 *   tsx src/cli/invalidateTenantCache.ts --tenant <uuid>
 *   npm run cache:invalidate-tenant -- --tenant <uuid>
 *
 * Exit codes:
 *   0  Invalidation ran (including the case where the tenant had no cached entries)
 *   1  Invalid input, or the cache backend could not be reached
 */

import { pathToFileURL } from 'node:url'
import { invalidateTenantCache } from '../cache/invalidation.js'
import { ValidationError, ServiceUnavailableError } from '../lib/errors.js'
import { logger } from '../utils/logger.js'

function printUsage(): void {
  console.log(`
Tenant Cache Invalidation CLI

Clears every cache entry for a tenant (Redis + in-process cache) so support
engineers can resolve stale-data reports without restarting the service.

Usage:
  tsx src/cli/invalidateTenantCache.ts --tenant <uuid>

Options:
  --tenant <uuid>   Required. Tenant ID to invalidate cache entries for.
  -h, --help        Show this help message.
`)
}

function parseTenantId(argv: string[]): string | undefined {
  const idx = argv.indexOf('--tenant')
  if (idx === -1) return undefined
  return argv[idx + 1]
}

/**
 * Runs the command and returns a process exit code. Kept separate from the
 * process.exit() call below so this is testable without killing the test runner.
 */
export async function run(argv: string[]): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    printUsage()
    return 0
  }

  const tenantId = parseTenantId(argv)
  if (!tenantId) {
    console.error('ERROR: --tenant <uuid> is required')
    printUsage()
    return 1
  }

  try {
    const result = await invalidateTenantCache(tenantId)

    if (result.keysCleared === 0) {
      console.log(`No cached entries found for tenant ${result.tenantId}. Nothing to do.`)
    } else {
      console.log(`Invalidated cache for tenant ${result.tenantId}: ${result.keysCleared} key(s) cleared.`)
    }

    return 0
  } catch (error) {
    if (error instanceof ValidationError) {
      console.error(`ERROR: ${error.message}`)
      return 1
    }

    if (error instanceof ServiceUnavailableError) {
      console.error(`ERROR: ${error.message}`)
      return 1
    }

    // Unexpected errors can originate from the Redis/Postgres client and may
    // carry connection strings or other sensitive detail in their message or
    // stack (the logger only redacts by field name, not by content). Log the
    // error's type only — never its message/stack — to keep secrets out of
    // logs and terminal output.
    const errorType = error instanceof Error ? error.constructor.name : typeof error
    logger.error(`Unexpected error during tenant cache invalidation (${errorType})`)
    console.error('ERROR: Failed to invalidate tenant cache. See logs for details.')
    return 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  run(process.argv.slice(2)).then((code) => process.exit(code))
}
