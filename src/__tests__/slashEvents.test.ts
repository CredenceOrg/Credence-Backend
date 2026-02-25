import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../db/migrations.js'
import { IdentitiesRepository } from '../repositories/identities.repository.js'
import { SlashEventsRepository } from '../repositories/slashEvents.repository.js'

describe('SlashEventsRepository', () => {
  let db: Database.Database
  let identities: IdentitiesRepository
  let slashEvents: SlashEventsRepository
  let identityId: number

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    identities = new IdentitiesRepository(db)
    slashEvents = new SlashEventsRepository(db)
    const identity = identities.create({ address: '0xABCDEF1234567890' })
    identityId = identity.id
  })

  afterEach(() => {
    db.close()
  })

  it('should create a slash event', () => {
    const event = slashEvents.create({
      identity_id: identityId,
      amount: '1000000000000000000',
      reason: 'Fraudulent attestation',
    })
    expect(event.id).toBe(1)
    expect(event.identity_id).toBe(identityId)
    expect(event.amount).toBe('1000000000000000000')
    expect(event.reason).toBe('Fraudulent attestation')
    expect(event.evidence_ref).toBeNull()
    expect(event.timestamp).toBeDefined()
    expect(event.created_at).toBeDefined()
  })

  it('should create a slash event with evidence_ref', () => {
    const event = slashEvents.create({
      identity_id: identityId,
      amount: '500',
      reason: 'Double signing',
      evidence_ref: 'ipfs://Qm12345',
    })
    expect(event.evidence_ref).toBe('ipfs://Qm12345')
  })

  it('should find a slash event by ID', () => {
    const created = slashEvents.create({
      identity_id: identityId,
      amount: '100',
      reason: 'Test',
    })
    const found = slashEvents.findById(created.id)
    expect(found).toBeDefined()
    expect(found!.amount).toBe('100')
    expect(found!.reason).toBe('Test')
  })

  it('should return undefined for non-existent slash event ID', () => {
    const found = slashEvents.findById(999)
    expect(found).toBeUndefined()
  })

  it('should find slash events by identity ID', () => {
    slashEvents.create({
      identity_id: identityId,
      amount: '100',
      reason: 'Reason 1',
    })
    slashEvents.create({
      identity_id: identityId,
      amount: '200',
      reason: 'Reason 2',
    })
    const results = slashEvents.findByIdentityId(identityId)
    expect(results).toHaveLength(2)
    expect(results[0].amount).toBe('100')
    expect(results[1].amount).toBe('200')
  })

  it('should return empty array for identity with no slash events', () => {
    const results = slashEvents.findByIdentityId(identityId)
    expect(results).toHaveLength(0)
  })

  it('should list all slash events', () => {
    slashEvents.create({
      identity_id: identityId,
      amount: '100',
      reason: 'R1',
    })
    slashEvents.create({
      identity_id: identityId,
      amount: '200',
      reason: 'R2',
    })
    const all = slashEvents.findAll()
    expect(all).toHaveLength(2)
  })

  it('should enforce foreign key constraint on identity_id', () => {
    expect(() =>
      slashEvents.create({
        identity_id: 9999,
        amount: '100',
        reason: 'Invalid identity',
      })
    ).toThrow()
  })

  it('should cascade delete slash events when identity is deleted', () => {
    slashEvents.create({
      identity_id: identityId,
      amount: '100',
      reason: 'Test',
    })
    expect(slashEvents.findByIdentityId(identityId)).toHaveLength(1)
    db.prepare('DELETE FROM identities WHERE id = ?').run(identityId)
    expect(slashEvents.findByIdentityId(identityId)).toHaveLength(0)
  })

  it('should handle null evidence_ref explicitly', () => {
    const event = slashEvents.create({
      identity_id: identityId,
      amount: '100',
      reason: 'No evidence',
      evidence_ref: null,
    })
    expect(event.evidence_ref).toBeNull()
  })
})
