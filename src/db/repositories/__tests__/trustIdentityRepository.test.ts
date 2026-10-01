/**
 * Tests for PgTrustIdentityRepository — the Postgres data source behind
 * getTrustScore (replacing the former in-memory seeded store).
 *
 * Runs against pg-mem using the schema from migration 001_initial_schema, so
 * the SQL is exercised as written rather than mocked. Covers the edge cases the
 * trust endpoint depends on: missing identity rows, null bond_start, uint256
 * bonded amounts, address normalisation, and attestation counting.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { newDb, type IMemoryDb } from 'pg-mem'
import type { Pool } from 'pg'
import { PgTrustIdentityRepository } from '../trustIdentityRepository.js'

const ADDRESS = '0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

function createDb(): { db: IMemoryDb; pool: Pool } {
  const db = newDb()

  db.public.none(`
    CREATE TABLE identities (
      id SERIAL PRIMARY KEY,
      address VARCHAR(64) NOT NULL UNIQUE,
      bonded_amount VARCHAR(78) NOT NULL DEFAULT '0',
      bond_start TIMESTAMP,
      bond_duration INTEGER,
      active BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `)

  db.public.none(`
    CREATE TABLE attestations (
      id SERIAL PRIMARY KEY,
      bond_id INTEGER NOT NULL,
      attester_address VARCHAR(64) NOT NULL,
      subject_address VARCHAR(64) NOT NULL,
      score INTEGER NOT NULL,
      note TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `)

  const adapter = db.adapters.createPg()
  const pool = new adapter.Pool() as unknown as Pool

  return { db, pool }
}

function insertIdentity(
  db: IMemoryDb,
  address: string,
  bondedAmount: string,
  bondStart: string | null
): void {
  db.public.none(`
    INSERT INTO identities (address, bonded_amount, bond_start)
    VALUES ('${address}', '${bondedAmount}', ${bondStart ? `'${bondStart}'` : 'NULL'})
  `)
}

function insertAttestation(db: IMemoryDb, subject: string, attester: string): void {
  db.public.none(`
    INSERT INTO attestations (bond_id, attester_address, subject_address, score)
    VALUES (1, '${attester}', '${subject}', 80)
  `)
}

describe('PgTrustIdentityRepository', () => {
  let db: IMemoryDb
  let repo: PgTrustIdentityRepository

  beforeEach(() => {
    const created = createDb()
    db = created.db
    repo = new PgTrustIdentityRepository(created.pool)
  })

  it('returns null when no identity row exists', async () => {
    await expect(repo.getIdentityForScoring(ADDRESS)).resolves.toBeNull()
  })

  it('reads bond data for an existing identity', async () => {
    insertIdentity(db, ADDRESS, '1000000000000000000', '2024-01-15T00:00:00.000Z')

    const identity = await repo.getIdentityForScoring(ADDRESS)

    expect(identity).toEqual({
      address: ADDRESS,
      bondedAmount: '1000000000000000000',
      bondStart: '2024-01-15T00:00:00.000Z',
      attestationCount: 0,
    })
  })

  it('returns a null bondStart for an unbonded identity', async () => {
    insertIdentity(db, ADDRESS, '0', null)

    const identity = await repo.getIdentityForScoring(ADDRESS)

    expect(identity?.bondStart).toBeNull()
    expect(identity?.bondedAmount).toBe('0')
  })

  it('preserves uint256-scale bonded amounts without precision loss', async () => {
    const maxUint256 =
      '115792089237316195423570985008687907853269984665640564039457584007913129639935'
    insertIdentity(db, ADDRESS, maxUint256, null)

    const identity = await repo.getIdentityForScoring(ADDRESS)

    // Must survive as an exact decimal string — BigInt(bondedAmount) is applied
    // downstream in computeBondScore.
    expect(identity?.bondedAmount).toBe(maxUint256)
    expect(BigInt(identity!.bondedAmount)).toBe(BigInt(maxUint256))
  })

  it('matches the identity regardless of the casing supplied by the caller', async () => {
    insertIdentity(db, ADDRESS, '500000000000000000', null)

    const lower = await repo.getIdentityForScoring(ADDRESS.toLowerCase())
    const upper = await repo.getIdentityForScoring(
      '0x' + ADDRESS.slice(2).toUpperCase()
    )

    // The stored (checksummed) form is returned, not the queried form.
    expect(lower?.address).toBe(ADDRESS)
    expect(upper?.address).toBe(ADDRESS)
  })

  it('counts attestations naming the identity as subject', async () => {
    insertIdentity(db, ADDRESS, '1000000000000000000', '2024-01-15T00:00:00.000Z')
    insertAttestation(db, ADDRESS, '0xaaa')
    insertAttestation(db, ADDRESS, '0xbbb')
    insertAttestation(db, ADDRESS, '0xccc')

    const identity = await repo.getIdentityForScoring(ADDRESS)

    expect(identity?.attestationCount).toBe(3)
  })

  it('excludes attestations about other subjects', async () => {
    const other = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
    insertIdentity(db, ADDRESS, '0', null)
    insertIdentity(db, other, '0', null)
    insertAttestation(db, other, '0xaaa')
    insertAttestation(db, other, '0xbbb')
    insertAttestation(db, ADDRESS, '0xccc')

    await expect(repo.getIdentityForScoring(ADDRESS)).resolves.toMatchObject({
      attestationCount: 1,
    })
    await expect(repo.getIdentityForScoring(other)).resolves.toMatchObject({
      attestationCount: 2,
    })
  })

  it('coerces a missing bonded amount to zero', async () => {
    // identities.bonded_amount is NOT NULL DEFAULT '0', so this is defensive
    // against a legacy or partially-migrated row rather than a reachable state.
    const nullBondedAmount: Pool = {
      query: async () =>
        ({
          rows: [
            {
              address: ADDRESS,
              bonded_amount: null,
              bond_start: null,
              attestation_count: '0',
            },
          ],
          rowCount: 1,
        }) as never,
    } as unknown as Pool

    const identity = await new PgTrustIdentityRepository(
      nullBondedAmount
    ).getIdentityForScoring(ADDRESS)

    expect(identity?.bondedAmount).toBe('0')
  })

  it('returns null when the joined row carries no address', async () => {
    const emptyAddress: Pool = {
      query: async () =>
        ({ rows: [{ address: null }], rowCount: 1 }) as never,
    } as unknown as Pool

    await expect(
      new PgTrustIdentityRepository(emptyAddress).getIdentityForScoring(ADDRESS)
    ).resolves.toBeNull()
  })

  it('does not return seeded development identities', async () => {
    // The former in-memory store seeded these hardhat addresses; a migrated
    // database must know nothing about them.
    for (const seeded of [
      '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
      '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
      '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
      '0x742d35cc6634c0532925a3b844bc454e4438f44e',
    ]) {
      await expect(repo.getIdentityForScoring(seeded)).resolves.toBeNull()
    }
  })

  it('propagates a transient query failure and recovers on a later read', async () => {
    const error = new Error('database connection reset')
    const query = vi
      .fn<Pool['query']>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({
        rows: [
          {
            address: ADDRESS,
            bonded_amount: '250',
            bond_start: null,
            attestation_count: '1',
          },
        ],
        rowCount: 1,
      } as never)
    const recoveringRepo = new PgTrustIdentityRepository({ query } as unknown as Pool)

    await expect(recoveringRepo.getIdentityForScoring(ADDRESS)).rejects.toBe(error)
    await expect(recoveringRepo.getIdentityForScoring(ADDRESS)).resolves.toEqual({
      address: ADDRESS,
      bondedAmount: '250',
      bondStart: null,
      attestationCount: 1,
    })
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('keeps concurrent lookups isolated while normalising each address', async () => {
    const other = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
    insertIdentity(db, ADDRESS, '100', null)
    insertIdentity(db, other, '200', null)

    const query = vi.fn(async (_text: string, params?: readonly unknown[]) => {
      const requested = params?.[0]
      const row = requested === ADDRESS.toLowerCase()
        ? { address: ADDRESS, bonded_amount: '100', bond_start: null, attestation_count: '1' }
        : { address: other, bonded_amount: '200', bond_start: null, attestation_count: '2' }
      return { rows: [row], rowCount: 1 } as never
    })
    const concurrentRepo = new PgTrustIdentityRepository({ query } as unknown as Pool)

    const [first, second] = await Promise.all([
      concurrentRepo.getIdentityForScoring(ADDRESS.toLowerCase()),
      concurrentRepo.getIdentityForScoring(other.toUpperCase()),
    ])

    expect(first).toEqual({
      address: ADDRESS,
      bondedAmount: '100',
      bondStart: null,
      attestationCount: 1,
    })
    expect(second).toEqual({
      address: other,
      bondedAmount: '200',
      bondStart: null,
      attestationCount: 2,
    })
    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls.map((call) => call[1])).toEqual([
      [ADDRESS.toLowerCase()],
      [other.toLowerCase()],
    ])
  })
})
