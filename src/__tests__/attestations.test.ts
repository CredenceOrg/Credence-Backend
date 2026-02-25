import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../db/migrations.js'
import { IdentitiesRepository } from '../repositories/identities.repository.js'
import { AttestationsRepository } from '../repositories/attestations.repository.js'

describe('AttestationsRepository', () => {
  let db: Database.Database
  let identities: IdentitiesRepository
  let attestations: AttestationsRepository
  let identityId: number

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    identities = new IdentitiesRepository(db)
    attestations = new AttestationsRepository(db)
    const identity = identities.create({ address: '0xABCDEF1234567890' })
    identityId = identity.id
  })

  afterEach(() => {
    db.close()
  })

  it('should create an attestation with default weight', () => {
    const att = attestations.create({
      verifier: '0xVERIFIER1',
      identity_id: identityId,
    })
    expect(att.id).toBe(1)
    expect(att.verifier).toBe('0xVERIFIER1')
    expect(att.identity_id).toBe(identityId)
    expect(att.weight).toBe(1.0)
    expect(att.revoked).toBe(0)
    expect(att.timestamp).toBeDefined()
    expect(att.created_at).toBeDefined()
  })

  it('should create an attestation with custom weight', () => {
    const att = attestations.create({
      verifier: '0xVERIFIER2',
      identity_id: identityId,
      weight: 2.5,
    })
    expect(att.weight).toBe(2.5)
  })

  it('should find an attestation by ID', () => {
    const created = attestations.create({
      verifier: '0xVERIFIER3',
      identity_id: identityId,
    })
    const found = attestations.findById(created.id)
    expect(found).toBeDefined()
    expect(found!.verifier).toBe('0xVERIFIER3')
  })

  it('should return undefined for non-existent attestation ID', () => {
    const found = attestations.findById(999)
    expect(found).toBeUndefined()
  })

  it('should find attestations by identity ID', () => {
    attestations.create({ verifier: '0xV1', identity_id: identityId })
    attestations.create({ verifier: '0xV2', identity_id: identityId })
    const results = attestations.findByIdentityId(identityId)
    expect(results).toHaveLength(2)
    expect(results[0].verifier).toBe('0xV1')
    expect(results[1].verifier).toBe('0xV2')
  })

  it('should return empty array for identity with no attestations', () => {
    const results = attestations.findByIdentityId(identityId)
    expect(results).toHaveLength(0)
  })

  it('should revoke an attestation', () => {
    const att = attestations.create({
      verifier: '0xVERIFIER4',
      identity_id: identityId,
    })
    expect(att.revoked).toBe(0)
    const revoked = attestations.revoke(att.id)
    expect(revoked).toBe(true)
    const updated = attestations.findById(att.id)
    expect(updated!.revoked).toBe(1)
  })

  it('should return false when revoking non-existent attestation', () => {
    const revoked = attestations.revoke(999)
    expect(revoked).toBe(false)
  })

  it('should list all attestations', () => {
    attestations.create({ verifier: '0xV1', identity_id: identityId })
    attestations.create({ verifier: '0xV2', identity_id: identityId })
    const all = attestations.findAll()
    expect(all).toHaveLength(2)
  })

  it('should enforce foreign key constraint on identity_id', () => {
    expect(() =>
      attestations.create({
        verifier: '0xVERIFIER_BAD',
        identity_id: 9999,
      })
    ).toThrow()
  })

  it('should cascade delete attestations when identity is deleted', () => {
    attestations.create({ verifier: '0xV1', identity_id: identityId })
    expect(attestations.findByIdentityId(identityId)).toHaveLength(1)
    db.prepare('DELETE FROM identities WHERE id = ?').run(identityId)
    expect(attestations.findByIdentityId(identityId)).toHaveLength(0)
  })

  it('should allow multiple attestations from same verifier for same identity', () => {
    attestations.create({ verifier: '0xV1', identity_id: identityId })
    attestations.create({ verifier: '0xV1', identity_id: identityId })
    const results = attestations.findByIdentityId(identityId)
    expect(results).toHaveLength(2)
  })
})
