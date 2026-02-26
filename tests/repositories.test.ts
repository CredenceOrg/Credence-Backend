/**
 * Repository tests using pg-mem (in-process Postgres emulator).
 * No live database required – runs entirely in memory.
 *
 * Run:  npx jest  (or  npx vitest run  if you switch runners)
 */

import { newDb } from 'pg-mem'
import type { IMemoryDb } from 'pg-mem'
import { Pool } from 'pg'
import { IdentityRepository } from '../src/db/repositories/identityRepository'
import { BondRepository } from '../src/db/repositories/bondRepository'

// ---------------------------------------------------------------------------
// UUID injection proxy
// ---------------------------------------------------------------------------

/**
 * pg-mem caches gen_random_uuid() results (treats it as IMMUTABLE), so any
 * INSERT relying on DEFAULT gen_random_uuid() produces duplicate PKs after
 * the first row.
 *
 * This proxy wraps the pool and rewrites INSERT statements that omit the `id`
 * column, injecting a fresh crypto.randomUUID() before the query reaches
 * pg-mem. All other queries pass through unchanged.
 */
function createUuidInjectingPool(pool: Pool): Pool {
     return new Proxy(pool, {
          get(target, prop) {
               if (prop !== 'query') return (target as any)[prop]

               return (text: string, values?: unknown[]) => {
                    if (typeof text !== 'string') return (target as any).query(text, values)

                    // Rewrite: INSERT INTO identities (address) → INSERT INTO identities (id, address)
                    if (/INSERT INTO identities\s*\(\s*address\s*\)/i.test(text)) {
                         const newId = crypto.randomUUID()
                         const rewritten = text.replace(
                              /INSERT INTO identities\s*\(\s*address\s*\)/i,
                              'INSERT INTO identities (id, address)',
                         ).replace(/VALUES\s*\(\s*\$1\s*\)/i, 'VALUES ($1, $2)')
                         // shift original $1 → $2, prepend id as $1
                         const newValues = [newId, ...(values ?? [])]
                         return (target as any).query(rewritten, newValues)
                    }

                    // Rewrite: INSERT INTO bonds (identity_id, bonded_amount, bond_start, bond_duration)
                    if (/INSERT INTO bonds\s*\(\s*identity_id,\s*bonded_amount,\s*bond_start,\s*bond_duration\s*\)/i.test(text)) {
                         const newId = crypto.randomUUID()
                         const rewritten = text
                              .replace(
                                   /INSERT INTO bonds\s*\(\s*identity_id,\s*bonded_amount,\s*bond_start,\s*bond_duration\s*\)/i,
                                   'INSERT INTO bonds (id, identity_id, bonded_amount, bond_start, bond_duration)',
                              )
                              .replace(/VALUES\s*\(\s*\$1,\s*\$2,\s*\$3,\s*\$4::INTERVAL\s*\)/i, 'VALUES ($1, $2, $3, $4, $5::INTERVAL)')
                         const newValues = [newId, ...(values ?? [])]
                         return (target as any).query(rewritten, newValues)
                    }

                    return (target as any).query(text, values)
               }
          },
     })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildTestDb(): Promise<{ db: IMemoryDb; pool: Pool; proxiedPool: Pool }> {
     const db = newDb()

     db.public.registerFunction({
          name: 'gen_random_uuid',
          returns: 'uuid',
          implementation: () => crypto.randomUUID(),
     } as Parameters<typeof db.public.registerFunction>[0])

     const adapter = db.adapters.createPg()
     const pool = new adapter.Pool() as unknown as Pool

     // No DEFAULT gen_random_uuid() – proxy injects IDs instead
     await pool.query(`
    CREATE TABLE IF NOT EXISTS identities (
      id          UUID          PRIMARY KEY,
      address     VARCHAR(255)  NOT NULL UNIQUE,
      created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    );
  `)

     await pool.query(`
    CREATE TABLE IF NOT EXISTS bonds (
      id              UUID           PRIMARY KEY,
      identity_id     UUID           NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
      bonded_amount   NUMERIC(36,18) NOT NULL CHECK (bonded_amount >= 0),
      bond_start      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
      bond_duration   INTERVAL       NOT NULL,
      bond_end        TIMESTAMPTZ,
      slashed_amount  NUMERIC(36,18) NOT NULL DEFAULT 0 CHECK (slashed_amount >= 0),
      active          BOOLEAN        NOT NULL DEFAULT TRUE,
      created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW()
    );
  `)

     const proxiedPool = createUuidInjectingPool(pool)
     return { db, pool, proxiedPool }
}

/** Direct INSERT helper for tests that don't go through the repository. */
async function insertIdentity(pool: Pool, address: string): Promise<string> {
     const id = crypto.randomUUID()
     await pool.query(`INSERT INTO identities (id, address) VALUES ($1, $2)`, [id, address])
     return id
}

async function insertBond(
     pool: Pool,
     identityId: string,
     bondedAmount = '100',
     bondDuration = '30 days',
     bondStart?: Date,
     active = true,
     bondEnd?: Date,
): Promise<string> {
     const id = crypto.randomUUID()
     const start = bondStart ?? new Date()
     if (bondEnd !== undefined) {
          await pool.query(
               `INSERT INTO bonds (id, identity_id, bonded_amount, bond_start, bond_duration, bond_end, active)
       VALUES ($1, $2, $3, $4, $5::INTERVAL, $6, $7)`,
               [id, identityId, bondedAmount, start, bondDuration, bondEnd, active],
          )
     } else {
          await pool.query(
               `INSERT INTO bonds (id, identity_id, bonded_amount, bond_start, bond_duration, active)
       VALUES ($1, $2, $3, $4, $5::INTERVAL, $6)`,
               [id, identityId, bondedAmount, start, bondDuration, active],
          )
     }
     return id
}

// ---------------------------------------------------------------------------
// IdentityRepository
// ---------------------------------------------------------------------------

describe('IdentityRepository', () => {
     let pool: Pool
     let proxiedPool: Pool
     let repo: IdentityRepository

     beforeAll(async () => {
          const built = await buildTestDb()
          pool = built.pool
          proxiedPool = built.proxiedPool
          repo = new IdentityRepository(proxiedPool)
     })

     afterEach(async () => {
          await pool.query('DELETE FROM bonds')
          await pool.query('DELETE FROM identities')
     })

     // --- create ---------------------------------------------------------------

     describe('create()', () => {
          it('inserts a new identity via repo and returns it', async () => {
               const identity = await repo.create({ address: '0xABC' })
               expect(identity.id).toMatch(/^[0-9a-f-]{36}$/i)
               expect(identity.address).toBe('0xABC')
               expect(identity.createdAt).toBeInstanceOf(Date)
               expect(identity.updatedAt).toBeInstanceOf(Date)
          })

          it('throws on duplicate address', async () => {
               await repo.create({ address: '0xDUP' })
               await expect(repo.create({ address: '0xDUP' })).rejects.toThrow()
          })
     })

     // --- findById -------------------------------------------------------------

     describe('findById()', () => {
          it('returns the identity when it exists', async () => {
               const created = await repo.create({ address: '0x1' })
               const found = await repo.findById(created.id)
               expect(found).not.toBeNull()
               expect(found!.id).toBe(created.id)
          })

          it('returns null for unknown id', async () => {
               const found = await repo.findById('00000000-0000-0000-0000-000000000000')
               expect(found).toBeNull()
          })
     })

     // --- findByAddress --------------------------------------------------------

     describe('findByAddress()', () => {
          it('returns the identity for a known address', async () => {
               await repo.create({ address: '0xFOO' })
               const found = await repo.findByAddress('0xFOO')
               expect(found).not.toBeNull()
               expect(found!.address).toBe('0xFOO')
          })

          it('returns null for an unknown address', async () => {
               const found = await repo.findByAddress('0xNOPE')
               expect(found).toBeNull()
          })
     })

     // --- findAll --------------------------------------------------------------

     describe('findAll()', () => {
          it('returns all identities', async () => {
               await repo.create({ address: '0xA' })
               await repo.create({ address: '0xB' })
               await repo.create({ address: '0xC' })
               const all = await repo.findAll()
               expect(all.length).toBe(3)
          })

          it('respects limit and offset', async () => {
               await repo.create({ address: '0xA' })
               await repo.create({ address: '0xB' })
               await repo.create({ address: '0xC' })
               const page = await repo.findAll(2, 1)
               expect(page.length).toBe(2)
          })

          it('returns empty array when table is empty', async () => {
               const all = await repo.findAll()
               expect(all).toEqual([])
          })
     })

     // --- upsert ---------------------------------------------------------------

     describe('upsert()', () => {
          it('creates a new identity if address does not exist', async () => {
               const identity = await repo.upsert({ address: '0xNEW' })
               expect(identity.address).toBe('0xNEW')
          })

          it('returns existing identity without throwing on conflict', async () => {
               const first = await repo.create({ address: '0xEX' })
               const second = await repo.upsert({ address: '0xEX' })
               expect(second.id).toBe(first.id)
          })
     })

     // --- delete ---------------------------------------------------------------

     describe('delete()', () => {
          it('removes the identity and returns true', async () => {
               const identity = await repo.create({ address: '0xDEL' })
               const deleted = await repo.delete(identity.id)
               expect(deleted).toBe(true)
               expect(await repo.findById(identity.id)).toBeNull()
          })

          it('returns false for a non-existent id', async () => {
               const deleted = await repo.delete('00000000-0000-0000-0000-000000000000')
               expect(deleted).toBe(false)
          })

          it('cascades to associated bonds', async () => {
               const identity = await repo.create({ address: '0xCASC' })
               await insertBond(pool, identity.id)
               await repo.delete(identity.id)
               const bondRepo = new BondRepository(pool)
               const bonds = await bondRepo.findByIdentityId(identity.id)
               expect(bonds).toHaveLength(0)
          })
     })
})

// ---------------------------------------------------------------------------
// BondRepository
// ---------------------------------------------------------------------------

describe('BondRepository', () => {
     let pool: Pool
     let proxiedPool: Pool
     let bondRepo: BondRepository
     let identityId: string

     beforeAll(async () => {
          const built = await buildTestDb()
          pool = built.pool
          proxiedPool = built.proxiedPool
          bondRepo = new BondRepository(proxiedPool)
          identityId = await insertIdentity(pool, '0xBOND_TEST')
     })

     afterEach(async () => {
          await pool.query('DELETE FROM bonds')
     })

     // --- create ---------------------------------------------------------------

     describe('create()', () => {
          it('inserts a bond via repo and returns it with correct shape', async () => {
               const bond = await bondRepo.create({
                    identityId,
                    bondedAmount: '500.123456789012345678',
                    bondDuration: '30 days',
               })
               expect(bond.id).toBeDefined()
               expect(bond.identityId).toBe(identityId)
               expect(bond.bondedAmount).toBe(500.123456789012345678)
               expect(bond.bondDuration).toBeDefined()
               expect(bond.active).toBe(true)
               expect(bond.slashedAmount).toBe(0)
               expect(bond.bondStart).toBeInstanceOf(Date)
          })

          it('accepts an explicit bondStart', async () => {
               const bondStart = new Date('2025-01-01T00:00:00Z')
               const bond = await bondRepo.create({ identityId, bondedAmount: '10', bondDuration: '7 days', bondStart })
               expect(bond.bondStart.toISOString()).toBe(bondStart.toISOString())
          })

          it('throws on negative bonded_amount', async () => {
               await expect(
                    bondRepo.create({ identityId, bondedAmount: '-1', bondDuration: '30 days' }),
               ).rejects.toThrow()
          })

          it('throws on invalid identity_id (FK violation)', async () => {
               await expect(
                    bondRepo.create({
                         identityId: '00000000-0000-0000-0000-000000000000',
                         bondedAmount: '1',
                         bondDuration: '7 days',
                    }),
               ).rejects.toThrow()
          })
     })

     // --- findById -------------------------------------------------------------

     describe('findById()', () => {
          it('returns the bond when found', async () => {
               const bond = await bondRepo.create({ identityId, bondedAmount: '10', bondDuration: '7 days' })
               const found = await bondRepo.findById(bond.id)
               expect(found).not.toBeNull()
               expect(found!.id).toBe(bond.id)
          })

          it('returns null for unknown id', async () => {
               const found = await bondRepo.findById('00000000-0000-0000-0000-000000000000')
               expect(found).toBeNull()
          })
     })

     // --- findByIdentityId -----------------------------------------------------

     describe('findByIdentityId()', () => {
          it('returns all bonds for an identity', async () => {
               await bondRepo.create({ identityId, bondedAmount: '1', bondDuration: '1 day' })
               await bondRepo.create({ identityId, bondedAmount: '2', bondDuration: '2 days' })
               const bonds = await bondRepo.findByIdentityId(identityId)
               expect(bonds.length).toBe(2)
          })

          it('returns empty array when identity has no bonds', async () => {
               const bonds = await bondRepo.findByIdentityId('00000000-0000-0000-0000-000000000001')
               expect(bonds).toEqual([])
          })
     })

     // --- findActiveBond -------------------------------------------------------

     describe('findActiveBond()', () => {
          it('returns the active bond', async () => {
               await bondRepo.create({ identityId, bondedAmount: '50', bondDuration: '30 days' })
               const active = await bondRepo.findActiveBond(identityId)
               expect(active).not.toBeNull()
               expect(active!.active).toBe(true)
          })

          it('returns null when no active bonds exist', async () => {
               await insertBond(pool, identityId, '50', '30 days', undefined, false)
               const active = await bondRepo.findActiveBond(identityId)
               expect(active).toBeNull()
          })
     })

     // --- findExpired ----------------------------------------------------------

     describe('findExpired()', () => {
          it('returns active bonds whose bond_end is in the past', async () => {
               const pastEnd = new Date(Date.now() - 86_400_000)
               const pastStart = new Date(Date.now() - 86_400_000 * 60)
               await insertBond(pool, identityId, '10', '1 day', pastStart, true, pastEnd)
               const expired = await bondRepo.findExpired()
               expect(expired.length).toBeGreaterThanOrEqual(1)
               expired.forEach((b) => expect(b.active).toBe(true))
          })

          it('does not return inactive bonds', async () => {
               const pastEnd = new Date(Date.now() - 86_400_000)
               const pastStart = new Date(Date.now() - 86_400_000 * 60)
               await insertBond(pool, identityId, '10', '1 day', pastStart, false, pastEnd)
               const expired = await bondRepo.findExpired()
               expired.forEach((b) => expect(b.active).toBe(true))
          })
     })

     // --- update ---------------------------------------------------------------

     describe('update()', () => {
          it('updates slashedAmount', async () => {
               const bond = await bondRepo.create({ identityId, bondedAmount: '100', bondDuration: '30 days' })
               const updated = await bondRepo.update(bond.id, { slashedAmount: '25' })
               expect(updated!.slashedAmount).toBe(25)
          })

          it('updates active flag', async () => {
               const bond = await bondRepo.create({ identityId, bondedAmount: '100', bondDuration: '30 days' })
               const updated = await bondRepo.update(bond.id, { active: false })
               expect(updated!.active).toBe(false)
          })

          it('updates both slashedAmount and active together', async () => {
               const bond = await bondRepo.create({ identityId, bondedAmount: '100', bondDuration: '30 days' })
               const updated = await bondRepo.update(bond.id, { slashedAmount: '10', active: false })
               expect(updated!.slashedAmount).toBe(10)
               expect(updated!.active).toBe(false)
          })

          it('returns null for unknown bond id', async () => {
               const updated = await bondRepo.update('00000000-0000-0000-0000-000000000000', { active: false })
               expect(updated).toBeNull()
          })

          it('returns unchanged bond when update input is empty', async () => {
               const bond = await bondRepo.create({ identityId, bondedAmount: '100', bondDuration: '30 days' })
               const result = await bondRepo.update(bond.id, {})
               expect(result!.id).toBe(bond.id)
          })
     })

     // --- deactivate -----------------------------------------------------------

     describe('deactivate()', () => {
          it('sets active to false and returns true', async () => {
               const bond = await bondRepo.create({ identityId, bondedAmount: '100', bondDuration: '30 days' })
               expect(await bondRepo.deactivate(bond.id)).toBe(true)
               expect((await bondRepo.findById(bond.id))!.active).toBe(false)
          })

          it('returns false for an already-inactive bond', async () => {
               const bond = await bondRepo.create({ identityId, bondedAmount: '100', bondDuration: '30 days' })
               await bondRepo.deactivate(bond.id)
               expect(await bondRepo.deactivate(bond.id)).toBe(false)
          })
     })

     // --- delete ---------------------------------------------------------------

     describe('delete()', () => {
          it('removes the bond and returns true', async () => {
               const bond = await bondRepo.create({ identityId, bondedAmount: '10', bondDuration: '7 days' })
               expect(await bondRepo.delete(bond.id)).toBe(true)
               expect(await bondRepo.findById(bond.id)).toBeNull()
          })

          it('returns false for unknown id', async () => {
               expect(await bondRepo.delete('00000000-0000-0000-0000-000000000000')).toBe(false)
          })
     })
})

// ---------------------------------------------------------------------------
// Branch coverage: rowCount ?? 0 fallback
// These tests mock the pool to return rowCount: null, hitting the ?? 0 branch
// in deactivate(), delete() on both repositories.
// ---------------------------------------------------------------------------

describe('Branch coverage – rowCount nullish coalescing', () => {
     function makeNullRowCountPool() {
          return {
               query: async () => ({ rows: [], rowCount: null }),
          } as unknown as Pool
     }

     it('IdentityRepository.delete() returns false when rowCount is null', async () => {
          const repo = new IdentityRepository(makeNullRowCountPool())
          const result = await repo.delete('any-id')
          expect(result).toBe(false)
     })

     it('BondRepository.deactivate() returns false when rowCount is null', async () => {
          const repo = new BondRepository(makeNullRowCountPool())
          const result = await repo.deactivate('any-id')
          expect(result).toBe(false)
     })

     it('BondRepository.delete() returns false when rowCount is null', async () => {
          const repo = new BondRepository(makeNullRowCountPool())
          const result = await repo.delete('any-id')
          expect(result).toBe(false)
     })

     it('BondRepository.update() returns null when UPDATE matches no rows', async () => {
          const repo = new BondRepository({
               query: async () => ({ rows: [], rowCount: 0 }),
          } as unknown as Pool)
          const result = await repo.update('any-id', { active: false })
          expect(result).toBeNull()
     })
})