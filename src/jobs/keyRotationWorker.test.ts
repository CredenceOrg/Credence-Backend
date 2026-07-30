import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'crypto'
import { KeyRotationWorker, reencryptRecord, type EvidenceStore } from './keyRotationWorker.js'
import type { EvidenceRecord } from '../services/evidence/storage.js'
import type { KekVersion } from '../services/keyManager/types.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeKek(version: number, keyMaterial?: Buffer): KekVersion {
  return {
    version,
    keyMaterial: keyMaterial ?? crypto.randomBytes(32),
    state: version === 1 ? 'retired' : 'active',
    createdAt: new Date(),
    retiredAt: version === 1 ? new Date() : null,
  }
}

function encryptRecord(
  evidenceId: string,
  plaintext: string,
  kek: KekVersion,
  uploaderId = 'user-1',
): EvidenceRecord {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', kek.keyMaterial, iv)
  let blob = cipher.update(plaintext, 'utf8', 'hex')
  blob += cipher.final('hex')
  return {
    evidence_id: evidenceId,
    encryptedBlob: blob,
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
    uploaderId,
    createdAt: new Date(),
    kek_version: kek.version,
  }
}

function makeStore(records: EvidenceRecord[]): EvidenceStore {
  const db = new Map(records.map((r) => [r.evidence_id, { ...r }]))
  return {
    async listPage(offset, limit) {
      return [...db.values()].slice(offset, offset + limit)
    },
    async update(record) {
      db.set(record.evidence_id, { ...record })
    },
    async count() {
      return db.size
    },
    // expose for assertions
    _db: db,
  } as EvidenceStore & { _db: Map<string, EvidenceRecord> }
}

// ── reencryptRecord ──────────────────────────────────────────────────────────

describe('reencryptRecord', () => {
  it('decrypts with old KEK and re-encrypts with new KEK', () => {
    const oldKek = makeKek(1)
    const newKek = makeKek(2)
    const record = encryptRecord('ev-1', 'sensitive data', oldKek)

    const result = reencryptRecord(record, oldKek, newKek)

    expect(result.kek_version).toBe(2)
    expect(result.evidence_id).toBe('ev-1')
    expect(result.encryptedBlob).not.toBe(record.encryptedBlob)

    // Verify the new ciphertext decrypts correctly
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      newKek.keyMaterial,
      Buffer.from(result.iv, 'hex'),
    )
    decipher.setAuthTag(Buffer.from(result.authTag, 'hex'))
    let plain = decipher.update(result.encryptedBlob, 'hex', 'utf8')
    plain += decipher.final('utf8')
    expect(plain).toBe('sensitive data')
  })

  it('uses a fresh IV for each re-encryption', () => {
    const oldKek = makeKek(1)
    const newKek = makeKek(2)
    const record = encryptRecord('ev-1', 'data', oldKek)

    const r1 = reencryptRecord(record, oldKek, newKek)
    const r2 = reencryptRecord(record, oldKek, newKek)

    expect(r1.iv).not.toBe(r2.iv)
  })

  it('throws on tampered authTag', () => {
    const oldKek = makeKek(1)
    const newKek = makeKek(2)
    const record = encryptRecord('ev-1', 'data', oldKek)
    const tampered = { ...record, authTag: 'deadbeef'.repeat(4) }

    expect(() => reencryptRecord(tampered, oldKek, newKek)).toThrow()
  })

  it('throws when wrong KEK is used for decryption', () => {
    const oldKek = makeKek(1)
    const wrongKek = makeKek(99)
    const newKek = makeKek(2)
    const record = encryptRecord('ev-1', 'data', oldKek)

    expect(() => reencryptRecord(record, wrongKek, newKek)).toThrow()
  })
})

// ── KeyRotationWorker ────────────────────────────────────────────────────────

describe('KeyRotationWorker', () => {
  let oldKek: KekVersion
  let newKek: KekVersion

  beforeEach(() => {
    oldKek = makeKek(1)
    newKek = makeKek(2)
  })

  it('re-encrypts all records from old to new version', async () => {
    const records = [
      encryptRecord('ev-1', 'data-1', oldKek),
      encryptRecord('ev-2', 'data-2', oldKek),
      encryptRecord('ev-3', 'data-3', oldKek),
    ]
    const store = makeStore(records) as EvidenceStore & { _db: Map<string, EvidenceRecord> }
    const worker = new KeyRotationWorker(store)

    const result = await worker.run(oldKek, newKek)

    expect(result.reencrypted).toBe(3)
    expect(result.skipped).toBe(0)
    expect(result.failed).toBe(0)
    expect(result.interrupted).toBe(false)
    expect(result.newVersion).toBe(2)
    expect(result.oldVersion).toBe(1)

    // All records should now be on version 2
    for (const [, rec] of (store as any)._db) {
      expect(rec.kek_version).toBe(2)
    }
  })

  it('skips records already on the new version (idempotent re-runs)', async () => {
    const alreadyNew = encryptRecord('ev-new', 'data', newKek)
    alreadyNew.kek_version = 2
    const needsRotation = encryptRecord('ev-old', 'data', oldKek)

    const store = makeStore([alreadyNew, needsRotation])
    const worker = new KeyRotationWorker(store)

    const result = await worker.run(oldKek, newKek)

    expect(result.reencrypted).toBe(1)
    expect(result.skipped).toBe(1)
  })

  it('skips records on a different old version (mixed-version store)', async () => {
    const v1Record = encryptRecord('ev-v1', 'data', oldKek)
    const v3Kek = makeKek(3)
    const v3Record = encryptRecord('ev-v3', 'data', v3Kek)
    v3Record.kek_version = 3

    const store = makeStore([v1Record, v3Record])
    const worker = new KeyRotationWorker(store)

    // Rotating v1 → v2 should not touch v3 records
    const result = await worker.run(oldKek, newKek)

    expect(result.reencrypted).toBe(1)
    expect(result.skipped).toBe(1)
  })

  it('counts failed records without aborting the batch', async () => {
    const records = [
      encryptRecord('ev-1', 'data', oldKek),
      encryptRecord('ev-2', 'data', oldKek),
    ]
    const store = makeStore(records)
    let callCount = 0
    const faultyStore: EvidenceStore = {
      ...store,
      async update() {
        callCount++
        if (callCount === 1) throw new Error('DB write failed')
      },
    }

    const worker = new KeyRotationWorker(faultyStore)
    const result = await worker.run(oldKek, newKek)

    expect(result.failed).toBe(1)
    expect(result.reencrypted).toBe(1)
  })

  it('respects AbortSignal and marks result as interrupted', async () => {
    const records = Array.from({ length: 10 }, (_, i) =>
      encryptRecord(`ev-${i}`, `data-${i}`, oldKek),
    )
    const controller = new AbortController()
    let updateCount = 0

    const store: EvidenceStore = {
      async listPage(offset, limit) {
        return records.slice(offset, offset + limit)
      },
      async update(record) {
        updateCount++
        if (updateCount >= 3) controller.abort()
      },
      async count() {
        return records.length
      },
    }

    const worker = new KeyRotationWorker(store, { batchSize: 10 })
    const result = await worker.run(oldKek, newKek, controller.signal)

    expect(result.interrupted).toBe(true)
    expect(result.reencrypted).toBeLessThan(10)
  })

  it('emits progress callbacks at the configured interval', async () => {
    const records = Array.from({ length: 5 }, (_, i) =>
      encryptRecord(`ev-${i}`, `data-${i}`, oldKek),
    )
    const store = makeStore(records)
    const progressEvents: number[] = []

    const worker = new KeyRotationWorker(store, {
      progressInterval: 2,
      onProgress: (p) => progressEvents.push(p.reencrypted),
    })

    await worker.run(oldKek, newKek)

    // Should have fired at least once (at 2 and 4 records)
    expect(progressEvents.length).toBeGreaterThanOrEqual(1)
  })

  it('handles empty store gracefully', async () => {
    const store = makeStore([])
    const worker = new KeyRotationWorker(store)

    const result = await worker.run(oldKek, newKek)

    expect(result.total).toBe(0)
    expect(result.reencrypted).toBe(0)
    expect(result.interrupted).toBe(false)
  })

  it('processes records in batches (pagination)', async () => {
    const records = Array.from({ length: 25 }, (_, i) =>
      encryptRecord(`ev-${i}`, `data-${i}`, oldKek),
    )
    const store = makeStore(records)
    const listPageSpy = vi.spyOn(store, 'listPage')

    const worker = new KeyRotationWorker(store, { batchSize: 10 })
    const result = await worker.run(oldKek, newKek)

    expect(result.reencrypted).toBe(25)
    // 25 records / 10 per page = 3 pages + 1 empty terminator
    expect(listPageSpy).toHaveBeenCalledTimes(4)
  })

  it('logs progress via logger option', async () => {
    const records = [encryptRecord('ev-1', 'data', oldKek)]
    const store = makeStore(records)
    const logs: string[] = []

    const worker = new KeyRotationWorker(store, { logger: (msg) => logs.push(msg) })
    await worker.run(oldKek, newKek)

    expect(logs.some((l) => l.includes('Starting rotation'))).toBe(true)
    expect(logs.some((l) => l.includes('Rotation complete'))).toBe(true)
  })
})
