import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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

  it('records partial failure with error details and continues remaining records', async () => {
    const records = [
      encryptRecord('ev-1', 'data', oldKek),
      encryptRecord('ev-2', 'data', oldKek),
      encryptRecord('ev-3', 'data', oldKek),
    ]
    const store = makeStore(records) as EvidenceStore & { _db: Map<string, EvidenceRecord> }
    let callCount = 0
    const faultyStore: EvidenceStore = {
      ...store,
      async update(record) {
        callCount++
        if (callCount === 2) throw new Error('transient DB error')
        await store.update(record)
      },
    }

    const worker = new KeyRotationWorker(faultyStore)
    const result = await worker.run(oldKek, newKek)

    expect(result.failed).toBe(1)
    expect(result.reencrypted).toBe(2)
    // Failed record must remain on old version (no partial write)
    const db = (store as any)._db as Map<string, EvidenceRecord>
    const failed = [...db.values()].find((r) => r.evidence_id === 'ev-2')!
    expect(failed.kek_version).toBe(1)
  })

  it('recovers on retry after a transient failure (idempotent re-run)', async () => {
    const records = [
      encryptRecord('ev-1', 'data', oldKek),
      encryptRecord('ev-2', 'data', oldKek),
    ]
    const store = makeStore(records) as EvidenceStore & { _db: Map<string, EvidenceRecord> }
    let failOnce = true
    const flakyStore: EvidenceStore = {
      ...store,
      async update(record) {
        if (failOnce && record.evidence_id === 'ev-2') {
          failOnce = false
          throw new Error('transient')
        }
        await store.update(record)
      },
    }

    const worker = new KeyRotationWorker(flakyStore)
    const first = await worker.run(oldKek, newKek)
    expect(first.failed).toBe(1)
    expect(first.reencrypted).toBe(1)

    const second = await worker.run(oldKek, newKek)
    expect(second.failed).toBe(0)
    expect(second.reencrypted).toBe(1)
    expect(second.skipped).toBe(1)

    for (const [, rec] of (store as any)._db) {
      expect(rec.kek_version).toBe(2)
    }
  })

  it('does not double-rotate when run concurrently on the same store', async () => {
    const records = Array.from({ length: 6 }, (_, i) =>
      encryptRecord(`ev-${i}`, `data-${i}`, oldKek),
    )
    const store = makeStore(records) as EvidenceStore & { _db: Map<string, EvidenceRecord> }
    const worker = new KeyRotationWorker(store, { batchSize: 3 })

    const [a, b] = await Promise.all([
      worker.run(oldKek, newKek),
      worker.run(oldKek, newKek),
    ])

    // Combined reencrypted must not exceed total records
    expect(a.reencrypted + b.reencrypted).toBeLessThanOrEqual(records.length)
    // Every record ends on the new version exactly once
    for (const [, rec] of (store as any)._db) {
      expect(rec.kek_version).toBe(2)
    }
  })

  it('aborts immediately when signal is already aborted before run', async () => {
    const records = [encryptRecord('ev-1', 'data', oldKek)]
    const store = makeStore(records) as EvidenceStore & { _db: Map<string, EvidenceRecord> }
    const controller = new AbortController()
    controller.abort()

    const worker = new KeyRotationWorker(store)
    const result = await worker.run(oldKek, newKek, controller.signal)

    expect(result.interrupted).toBe(true)
    expect(result.reencrypted).toBe(0)
    const rec = [...(store as any)._db.values()][0]
    expect(rec.kek_version).toBe(1)
  })

  it('handles a single-record store at the batch boundary', async () => {
    const store = makeStore([encryptRecord('ev-only', 'data', oldKek)])
    const worker = new KeyRotationWorker(store, { batchSize: 1 })

    const result = await worker.run(oldKek, newKek)

    expect(result.total).toBe(1)
    expect(result.reencrypted).toBe(1)
    expect(result.failed).toBe(0)
    expect(result.interrupted).toBe(false)
  })

  it('handles batchSize larger than total record count', async () => {
    const records = Array.from({ length: 3 }, (_, i) =>
      encryptRecord(`ev-${i}`, `data-${i}`, oldKek),
    )
    const store = makeStore(records)
    const worker = new KeyRotationWorker(store, { batchSize: 1000 })

    const result = await worker.run(oldKek, newKek)

    expect(result.reencrypted).toBe(3)
    expect(result.failed).toBe(0)
  })

  it('does not leak plaintext or key material into logs on failure', async () => {
    const records = [encryptRecord('ev-1', 'top-secret-plaintext', oldKek)]
    const store = makeStore(records)
    const faultyStore: EvidenceStore = {
      ...store,
      async update() {
        throw new Error('write failed')
      },
    }
    const logs: string[] = []
    const worker = new KeyRotationWorker(faultyStore, { logger: (m) => logs.push(m) })

    await worker.run(oldKek, newKek)

    const joined = logs.join('\n')
    expect(joined).not.toContain('top-secret-plaintext')
    expect(joined).not.toContain(oldKek.keyMaterial.toString('hex'))
    expect(joined).not.toContain(newKek.keyMaterial.toString('hex'))
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

  it('does not re-process records that were already rotated in an earlier page', async () => {
    const records = Array.from({ length: 12 }, (_, i) =>
      encryptRecord(`ev-${i}`, `data-${i}`, oldKek),
    )
    const store = makeStore(records) as EvidenceStore & { _db: Map<string, EvidenceRecord> }
    const worker = new KeyRotationWorker(store, { batchSize: 5 })

    const result = await worker.run(oldKek, newKek)

    expect(result.reencrypted).toBe(12)
    expect(result.skipped).toBe(0)
    for (const [, rec] of (store as any)._db) {
      expect(rec.kek_version).toBe(2)
    }
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

  it('reports failure counts in logs without aborting the batch', async () => {
    const records = [
      encryptRecord('ev-1', 'data', oldKek),
      encryptRecord('ev-2', 'data', oldKek),
    ]
    const store = makeStore(records)
    const faultyStore: EvidenceStore = {
      ...store,
      async update() {
        throw new Error('boom')
      },
    }
    const logs: string[] = []
    const worker = new KeyRotationWorker(faultyStore, { logger: (m) => logs.push(m) })

    const result = await worker.run(oldKek, newKek)

    expect(result.failed).toBe(2)
    expect(logs.some((l) => l.includes('Rotation complete'))).toBe(true)
  })
})
