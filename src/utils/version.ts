import { execSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export interface VersionMetadata {
  gitSha: string
  buildTimestamp: string
  nodeVersion: string
}

let cachedVersion: VersionMetadata | null = null

export function getVersionMetadata(): VersionMetadata {
  if (cachedVersion) {
    return cachedVersion
  }

  // 1. Resolve Git SHA
  let gitSha = process.env.GIT_SHA || process.env.COMMIT_SHA
  if (!gitSha && process.env.NODE_ENV !== 'production') {
    try {
      gitSha = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    } catch {
      gitSha = 'unknown'
    }
  }
  gitSha = gitSha || 'unknown'

  // 2. Resolve Build Timestamp
  let buildTimestamp = process.env.BUILD_TIMESTAMP
  if (!buildTimestamp) {
    try {
      const __filename = fileURLToPath(import.meta.url)
      const __dirname = dirname(__filename)
      const pkgPath = join(__dirname, '../../package.json')
      const stat = statSync(pkgPath)
      buildTimestamp = stat.mtime.toISOString()
    } catch {
      buildTimestamp = new Date(Date.now() - process.uptime() * 1000).toISOString()
    }
  }

  cachedVersion = {
    gitSha,
    buildTimestamp,
    nodeVersion: process.version,
  }

  return cachedVersion
}
