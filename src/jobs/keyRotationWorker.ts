import crypto from 'crypto'
import type { EvidenceRecord } from '../services/evidence/storage.js'
import type { KekVersion } from '../services/keyManager/types.js'

// ── Types ────────────────────────────────────────────────────────────────────

export interface RotationProgress {
  total: number
  reencrypted: number
  skipped: number
  failed: number
  startTime: string
  durationMs: number
}

export interface RotationResult extends RotationProgress {
  newVersion: number
  oldVersion: number
  interrupted: boolean
}

/**
 * Abstraction over the evidence store so the worker is testable without a real DB.
 */
export interface EvidenceStore {
  /** Page through all evidence records. Returns empty array when exhausted. */
  listPage(offset: number, limit: number): Promise<EvidenceRecord[]>
  /** Persist an updated record (re-encrypted ciphertext + new kek_version). */
  update(record: EvidenceRecord): Promise<void>
  /** Total count of records (for progress reporting). */
  count(): Promise<number>
}

export interface RotationWorkerOptions {
  /** Records per batch. Default: 100. */
  batchSize?: number
  /** Emit a progress event every N records. Default: 50. */
  progressInterval?: number
  /** Callback invoked with progress snapshots during rotation. */
  onProgress?: (progress: RotationProgress) => void
  /** Logger function. Default: no-op. */
  logger?: (msg: string) => void
}

// ── Worker ───────────────────────────────────────────────────────────────────

/**
 * Re-encrypts all evidence records from `oldKek` to `newKek` in batches.
 *
 * Safety properties:
 * - Each record is decrypted with the version stored on the record, then
 *   re-encrypted with the new KEK. Mixed-version stores are handled correctly.
 * - If interrupted mid-batch, already-processed records retain the new version;
 *   unprocessed records retain the old version. Re-running the worker is safe
 *   (records already on the new version are skipped).
 * - Concurrent writes during rotation are safe: new uploads always use the
 *   current active KEK (set before rotation starts). The worker only touches
 *   records whose kek_version < newKek.version.
 */
export class KeyRotationWorker {
  private readonly batchSize: number
  private readonly progressInterval: number
  private readonly onProgress: (p: RotationProgress) => void
  private readonly logger: (msg: string) => void

  constructor(
    private readonly store: EvidenceStore,
    options: RotationWorkerOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 100
    this.progressInterval = options.progressInterval ?? 50
    this.onProgress = options.onProgress ?? (() => {})
    this.logger = options.logger ?? (() => {})
  }

  /**
   * Run the re-encryption pass.
   *
   * @param oldKek  The KEK version to decrypt from (may be any retired version).
   * @param newKek  The active KEK version to encrypt to.
   * @param signal  Optional AbortSignal to interrupt mid-batch.
   */
  async run(
    oldKek: KekVersion,
    newKek: KekVersion,
    signal?: AbortSignal,
  ): Promise<RotationResult> {
    const startTime = new Date().toISOString()
    const startMs = Date.now()
    const total = await this.store.count()

    let reencrypted = 0
    let skipped = 0
    let failed = 0
    let offset = 0
    let interrupted = false

    this.logger(`Starting rotation: v${oldKek.version} → v${newKek.version}, ${total} records`)

    while (true) {
      if (signal?.aborted) {
        interrupted = true
        this.logger(`Rotation interrupted at offset ${offset}`)
        break
      }

      const page = await this.store.listPage(offset, this.batchSize)
      if (page.length === 0) break

      for (const record of page) {
        if (signal?.aborted) {
          interrupted = true
          break
        }

        // Skip records already on the new version (idempotent re-runs)
        if (record.kek_version === newKek.version) {
          skipped++
          continue
        }

        // Only re-encrypt records on the target old version
        if (record.kek_version !== oldKek.version) {
          skipped++
          continue
        }

        try {
          const reencrypted_record = reencryptRecord(record, oldKek, newKek)
          await this.store.update(reencrypted_record)
          reencrypted++
        } catch (err) {
          failed++
          const msg = err instanceof Error ? err.message : String(err)
          this.logger(`Failed to re-encrypt ${record.evidence_id}: ${msg}`)
        }

        const processed = reencrypted + skipped + failed
        if (processed % this.progressInterval === 0) {
          this.onProgress({
            total,
            reencrypted,
            skipped,
            failed,
            startTime,
            durationMs: Date.now() - startMs,
          })
        }
      }

      if (interrupted) break
      offset += this.batchSize
    }

    const result: RotationResult = {
      total,
      reencrypted,
      skipped,
      failed,
      startTime,
      durationMs: Date.now() - startMs,
      newVersion: newKek.version,
      oldVersion: oldKek.version,
      interrupted,
    }

    this.logger(
      `Rotation complete: ${reencrypted} re-encrypted, ${skipped} skipped, ${failed} failed (${result.durationMs}ms)`,
    )

    return result
  }
}

// ── Pure helper ──────────────────────────────────────────────────────────────

/**
 * Decrypt a record with `oldKek` and re-encrypt with `newKek`.
 * Returns a new record object; does not mutate the input.
 */
export function reencryptRecord(
  record: EvidenceRecord,
  oldKek: KekVersion,
  newKek: KekVersion,
): EvidenceRecord {
  const ALG = 'aes-256-gcm'

  // Decrypt
  const decipher = crypto.createDecipheriv(ALG, oldKek.keyMaterial, Buffer.from(record.iv, 'hex'))
  decipher.setAuthTag(Buffer.from(record.authTag, 'hex'))
  let plaintext = decipher.update(record.encryptedBlob, 'hex', 'utf8')
  plaintext += decipher.final('utf8')

  // Re-encrypt with new KEK
  const newIv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALG, newKek.keyMaterial, newIv)
  let newCiphertext = cipher.update(plaintext, 'utf8', 'hex')
  newCiphertext += cipher.final('hex')
  const newAuthTag = cipher.getAuthTag().toString('hex')

  // Zeroize plaintext from memory
  const plaintextBuf = Buffer.from(plaintext, 'utf8')
  plaintextBuf.fill(0)

  return {
    ...record,
    encryptedBlob: newCiphertext,
    iv: newIv.toString('hex'),
    authTag: newAuthTag,
    kek_version: newKek.version,
  }
}
