#!/usr/bin/env tsx
/**
 * rotate-kms-key.ts — CLI for initiating and observing KEK rotation.
 *
 * Usage:
 *   tsx scripts/rotate-kms-key.ts register --key-hex <64-char hex>
 *   tsx scripts/rotate-kms-key.ts approve --version <n> --approver <id>
 *   tsx scripts/rotate-kms-key.ts activate --version <n>
 *   tsx scripts/rotate-kms-key.ts rotate [--batch-size 100] [--dry-run]
 *   tsx scripts/rotate-kms-key.ts status
 *
 * Environment:
 *   EVIDENCE_ENCRYPTION_KEY  — current 32-byte key (bootstraps version 1)
 *   NEW_KEK_HEX              — 64-char hex for the new KEK (used by `register`)
 */

import { kekManager, generateKekMaterial } from '../src/services/keyManager/index.js'
import { evidenceDB } from '../src/services/evidence/storage.js'
import { KeyRotationWorker, type EvidenceStore } from '../src/jobs/keyRotationWorker.js'
import type { EvidenceRecord } from '../src/services/evidence/storage.js'

// ── Bootstrap version 1 from env ────────────────────────────────────────────

function bootstrapV1(): void {
  const secret = process.env.EVIDENCE_ENCRYPTION_KEY
  if (!secret) {
    console.error('ERROR: EVIDENCE_ENCRYPTION_KEY is not set')
    process.exit(1)
  }
  const keyBuf = Buffer.from(secret, 'utf-8')
  if (keyBuf.length !== 32) {
    console.error('ERROR: EVIDENCE_ENCRYPTION_KEY must be exactly 32 bytes')
    process.exit(1)
  }
  if (kekManager.getAllVersions().length === 0) {
    kekManager.registerVersion(keyBuf)
    console.log('Bootstrapped KEK version 1 from EVIDENCE_ENCRYPTION_KEY')
  }
}

// ── In-memory store adapter ──────────────────────────────────────────────────

function makeInMemoryStore(): EvidenceStore {
  return {
    async listPage(offset: number, limit: number): Promise<EvidenceRecord[]> {
      return [...evidenceDB.values()].slice(offset, offset + limit)
    },
    async update(record: EvidenceRecord): Promise<void> {
      evidenceDB.set(record.evidence_id, record)
    },
    async count(): Promise<number> {
      return evidenceDB.size
    },
  }
}

// ── Commands ─────────────────────────────────────────────────────────────────

function cmdStatus(): void {
  bootstrapV1()
  const versions = kekManager.getAllVersions()
  console.log('\n=== KEK Status ===')
  if (versions.length === 0) {
    console.log('No KEK versions registered.')
    return
  }
  for (const v of versions) {
    const tag = v.state === 'active' ? ' [ACTIVE]' : ''
    const retired = v.retiredAt ? ` retired=${v.retiredAt.toISOString()}` : ''
    console.log(`  v${v.version}${tag}  created=${v.createdAt.toISOString()}${retired}`)
  }
  const auditLog = kekManager.getAuditLog()
  console.log(`\nAudit log (${auditLog.length} events):`)
  for (const e of auditLog.slice(-10)) {
    console.log(`  ${e.timestamp}  ${e.event}  v${e.version}`)
  }
}

function cmdRegister(args: string[]): void {
  bootstrapV1()
  const keyHexIdx = args.indexOf('--key-hex')
  let keyMaterial: Buffer

  if (keyHexIdx !== -1 && args[keyHexIdx + 1]) {
    const hex = args[keyHexIdx + 1]
    if (hex.length !== 64) {
      console.error('ERROR: --key-hex must be 64 hex characters (32 bytes)')
      process.exit(1)
    }
    keyMaterial = Buffer.from(hex, 'hex')
  } else if (process.env.NEW_KEK_HEX) {
    keyMaterial = Buffer.from(process.env.NEW_KEK_HEX, 'hex')
  } else {
    // Generate a new random key
    keyMaterial = generateKekMaterial()
    console.log(`Generated new KEK (hex): ${keyMaterial.toString('hex')}`)
    console.log('IMPORTANT: Store this key securely before proceeding.')
  }

  const result = kekManager.registerVersion(keyMaterial)
  console.log(`Registered KEK version ${result.version}${result.autoActivated ? ' (auto-activated)' : ''}`)
  console.log(`Next step: get ${KekManager_REQUIRED_APPROVALS} approvals, then run activate --version ${result.version}`)
}

// Re-export constant for display
const KekManager_REQUIRED_APPROVALS = 2

function cmdApprove(args: string[]): void {
  bootstrapV1()
  const versionIdx = args.indexOf('--version')
  const approverIdx = args.indexOf('--approver')

  if (versionIdx === -1 || !args[versionIdx + 1]) {
    console.error('ERROR: --version <n> is required')
    process.exit(1)
  }
  if (approverIdx === -1 || !args[approverIdx + 1]) {
    console.error('ERROR: --approver <id> is required')
    process.exit(1)
  }

  const version = parseInt(args[versionIdx + 1], 10)
  const approver = args[approverIdx + 1]

  kekManager.approveActivation(version, approver)
  const approvals = kekManager.getPendingApprovals(version)
  console.log(`Approval recorded for v${version} by ${approver} (${approvals.length}/${KekManager_REQUIRED_APPROVALS})`)
}

function cmdActivate(args: string[]): void {
  bootstrapV1()
  const versionIdx = args.indexOf('--version')
  if (versionIdx === -1 || !args[versionIdx + 1]) {
    console.error('ERROR: --version <n> is required')
    process.exit(1)
  }
  const version = parseInt(args[versionIdx + 1], 10)
  kekManager.activateVersion(version)
  console.log(`KEK version ${version} is now active`)
}

async function cmdRotate(args: string[]): Promise<void> {
  bootstrapV1()

  const batchSizeIdx = args.indexOf('--batch-size')
  const batchSize = batchSizeIdx !== -1 ? parseInt(args[batchSizeIdx + 1], 10) : 100
  const dryRun = args.includes('--dry-run')

  const current = kekManager.getCurrentKek()
  const versions = kekManager.getAllVersions()
  const oldVersions = versions.filter((v) => v.state === 'retired' && v.version < current.version)

  if (oldVersions.length === 0) {
    console.log('No retired KEK versions to rotate from. Nothing to do.')
    return
  }

  const store = makeInMemoryStore()
  const total = await store.count()
  console.log(`\nRotation plan: ${total} records, batch size ${batchSize}`)
  console.log(`Active KEK: v${current.version}`)
  console.log(`Old versions to migrate: ${oldVersions.map((v) => `v${v.version}`).join(', ')}`)

  if (dryRun) {
    console.log('\n[DRY RUN] No records will be modified.')
    return
  }

  const controller = new AbortController()
  process.on('SIGINT', () => {
    console.log('\nInterrupt received — stopping after current batch...')
    controller.abort()
  })

  for (const oldKek of oldVersions) {
    console.log(`\nRotating v${oldKek.version} → v${current.version}...`)
    const worker = new KeyRotationWorker(store, {
      batchSize,
      progressInterval: Math.max(1, Math.floor(batchSize / 2)),
      onProgress: (p) => {
        const pct = total > 0 ? Math.round((p.reencrypted / total) * 100) : 0
        process.stdout.write(`\r  Progress: ${p.reencrypted}/${total} (${pct}%) failed=${p.failed}`)
      },
      logger: (msg) => console.log(`  ${msg}`),
    })

    const result = await worker.run(oldKek, current, controller.signal)
    console.log(`\n  Done: ${result.reencrypted} re-encrypted, ${result.skipped} skipped, ${result.failed} failed`)

    if (result.interrupted) {
      console.log('  Rotation interrupted. Re-run to continue.')
      break
    }
  }

  // Zeroize retired key material after successful rotation
  if (!controller.signal.aborted) {
    const zeroized = kekManager.zeroizeRetired()
    if (zeroized.length > 0) {
      console.log(`\nZeroized key material for retired versions: ${zeroized.join(', ')}`)
    }
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv

  switch (command) {
    case 'status':
      cmdStatus()
      break
    case 'register':
      cmdRegister(args)
      break
    case 'approve':
      cmdApprove(args)
      break
    case 'activate':
      cmdActivate(args)
      break
    case 'rotate':
      await cmdRotate(args)
      break
    default:
      console.log(`
KMS Key Rotation CLI

Commands:
  status                              Show current KEK versions and audit log
  register [--key-hex <hex>]          Register a new KEK version
  approve --version <n> --approver <id>  Record dual-control approval
  activate --version <n>              Activate a registered KEK (requires 2 approvals)
  rotate [--batch-size <n>] [--dry-run]  Re-encrypt all evidence records

Environment:
  EVIDENCE_ENCRYPTION_KEY   Current 32-byte key (bootstraps v1)
  NEW_KEK_HEX               64-char hex for new KEK (used by register)
`)
      process.exit(1)
  }
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
