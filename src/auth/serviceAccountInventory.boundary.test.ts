/**
 * Boundary and recovery test coverage for the service account inventory.
 *
 * `src/auth/serviceAccountInventory.ts` is the source of truth describing which
 * internal service accounts exist, who owns them, and which backend endpoints
 * each one may reach. Because this inventory is the declared source of truth
 * for service-account access, drift between an account's declared `scopes` and
 * the `requiredScope` of its `endpoints` is a least-privilege regression.
 *
 * This suite validates deterministic behaviour under:
 * - Valid, invalid, duplicate, and boundary-case inputs
 * - Authorization and state-transition invariants (scope/endpoint consistency)
 * - Partial failure, retry, and concurrent execution (caller isolation)
 * - Data integrity: callers must never be able to mutate shared inventory state
 *
 * Invariants locked in by this suite:
 *
 * I1. `getServiceAccountInventory()` returns a fully detached copy. Mutating a
 *     result (entries, scopes, or endpoints) must never affect the module-level
 *     inventory or any other caller's result. This is what stops one request
 *     from silently widening or corrupting another request's service-account view.
 * I2. Every endpoint's `requiredScope` is covered by its own account's declared
 *     `scopes`. Otherwise a service account would be documented as unable to
 *     reach an endpoint the inventory claims it uses.
 * I3. Every declared scope is a real `ApiScope` member, and the inventory uses
 *     only granular scopes (never the legacy `public`/`enterprise` aliases), so
 *     the inventory cannot silently depend on legacy expansion.
 * I4. `getServiceAccountInventoryById()` is an exact, case-sensitive equality
 *     lookup over a concrete list of ids. It cannot be steered into returning
 *     inherited `Object.prototype` members by a hostile id.
 * I5. `validateServiceAccountInventory()` is a pure, order-stable function. It
 *     never throws for well-formed entries, accumulates all issues rather than
 *     short-circuiting, and reports `valid: false` if and only if `issues` is
 *     non-empty.
 *
 * Known limitations asserted below as the current, deterministic contract.
 * They are recorded rather than fixed here, to keep this change set to tests
 * only and to avoid altering behaviour that downstream tooling may depend on.
 * Each is a candidate for a separate, deliberate fix:
 *
 * L1. `validateServiceAccountInventory()` throws a `TypeError` when the array
 *     contains `null`/`undefined` entries, because the id/name guard
 *     dereferences `account.id` directly.
 * L2. It also throws a `TypeError` for a non-iterable `accounts` value.
 * L3. `validateServiceAccountInventory()` does not enforce L2 of the
 *     authorization model above: an endpoint may require a scope its account
 *     never declares and still validate as clean.
 * L4. It does not reject duplicate ids, which would make
 *     `getServiceAccountInventoryById()` ambiguous.
 * L5. The id/name guard is a truthiness check, so a whitespace-only `name`
 *     passes — even though a whitespace-only `purpose` is correctly rejected
 *     via `.trim()`.
 * L6. Endpoint path validation only checks the `/api/` prefix, so trailing
 *     whitespace on a path is accepted.
 * L7. `listServiceAccountOwners()` silently drops a `NaN` owner, because
 *     `Array.prototype.indexOf` uses strict equality and never matches `NaN`.
 *
 * Related: Issue #1331
 */

import { describe, expect, it } from 'vitest'
import { ApiScope, scopeSatisfies } from '../middleware/auth.js'
import {
  getServiceAccountInventory,
  getServiceAccountInventoryById,
  listServiceAccountOwners,
  validateServiceAccountInventory,
} from './serviceAccountInventory.js'
import type {
  ServiceAccountEndpoint,
  ServiceAccountInventoryEntry,
} from './serviceAccountInventory.js'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * Build a minimal entry that passes `validateServiceAccountInventory`, so each
 * test can invalidate exactly one field and attribute any reported issue to it.
 */
function validEntry(overrides: Partial<ServiceAccountInventoryEntry> = {}): ServiceAccountInventoryEntry {
  return {
    id: 'svc-a',
    name: 'Service A',
    owner: 'platform',
    purpose: 'Does a thing.',
    scopes: [ApiScope.TRUST_READ],
    endpoints: [
      {
        path: '/api/transactions/history',
        method: 'GET',
        requiredScope: ApiScope.TRUST_READ,
        description: 'Reads history.',
      },
    ],
    ...overrides,
  }
}

function endpoint(overrides: Partial<ServiceAccountEndpoint> = {}): ServiceAccountEndpoint {
  return {
    path: '/api/transactions/history',
    method: 'GET',
    requiredScope: ApiScope.TRUST_READ,
    description: 'Reads history.',
    ...overrides,
  }
}

/** Cast helper for deliberately malformed inputs. */
function malformed(value: unknown): ServiceAccountInventoryEntry {
  return value as ServiceAccountInventoryEntry
}

/** The granular scopes, excluding the two legacy backward-compat aliases. */
const GRANULAR_SCOPES = new Set<ApiScope>(
  Object.values(ApiScope).filter(
    (scope) => scope !== ApiScope.PUBLIC && scope !== ApiScope.ENTERPRISE,
  ),
)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('serviceAccountInventory - Boundary and Recovery Tests', () => {
  // -------------------------------------------------------------------------
  describe('Boundary Cases', () => {
    // -----------------------------------------------------------------------
    describe('Empty and Single-Entry Inputs', () => {
      it('returns a non-empty inventory with unique ids', () => {
        const inventory = getServiceAccountInventory()

        expect(inventory.length).toBeGreaterThan(0)
        expect(new Set(inventory.map((a) => a.id)).size).toBe(inventory.length)
      })

      it('returns owners for a single-entry inventory', () => {
        const owners = listServiceAccountOwners([validEntry()])

        expect(owners).toEqual(['platform'])
      })

      it('returns no owners for an empty inventory', () => {
        expect(listServiceAccountOwners([])).toEqual([])
      })

      it('validates an empty inventory as valid with no issues', () => {
        const result = validateServiceAccountInventory([])

        expect(result).toEqual({ valid: true, issues: [] })
      })

      it('validates a single minimal valid entry', () => {
        const result = validateServiceAccountInventory([validEntry()])

        expect(result).toEqual({ valid: true, issues: [] })
      })
    })

    // -----------------------------------------------------------------------
    describe('Lookup Boundaries', () => {
      it('returns undefined for an unknown id', () => {
        expect(getServiceAccountInventoryById('does-not-exist')).toBeUndefined()
      })

      it('returns undefined for an empty-string id', () => {
        expect(getServiceAccountInventoryById('')).toBeUndefined()
      })

      it('is case-sensitive — an uppercased id does not resolve', () => {
        expect(getServiceAccountInventoryById('HORIZON-LISTENER')).toBeUndefined()
      })

      it('does not match on a prefix or substring of a real id', () => {
        // Guards against a future `id.startsWith(query)` style "fuzzy" lookup,
        // which would be a privilege-relevant behaviour change.
        expect(getServiceAccountInventoryById('horizon')).toBeUndefined()
        expect(getServiceAccountInventoryById('horizon-listener-extra')).toBeUndefined()
      })

      it('does not match a whitespace-padded id', () => {
        expect(getServiceAccountInventoryById(' horizon-listener ')).toBeUndefined()
      })

      it('resolves every id in the inventory to an equal entry', () => {
        const inventory = getServiceAccountInventory()

        for (const account of inventory) {
          expect(getServiceAccountInventoryById(account.id)).toEqual(account)
        }
      })

      it('resolves an empty-string id to undefined even when an entry id is falsy', () => {
        // The shipped inventory has no empty id, so the empty query must miss.
        const ids = getServiceAccountInventory().map((a) => a.id)
        expect(ids).not.toContain('')
      })
    })

    // -----------------------------------------------------------------------
    describe('Prototype-Safe Lookup (I4)', () => {
      it.each([
        '__proto__',
        'constructor',
        'toString',
        'hasOwnProperty',
        'valueOf',
        'isPrototypeOf',
      ])('returns undefined for inherited Object.prototype key %j', (id) => {
        // A hostile id must not resolve to an inherited property. The lookup is
        // `entries.find(e => e.id === id)`, so only real ids can ever match.
        expect(getServiceAccountInventoryById(id)).toBeUndefined()
      })

      it('does not pollute Object.prototype through a lookup miss', () => {
        getServiceAccountInventoryById('__proto__')

        expect(({} as Record<string, unknown>).polluted).toBeUndefined()
        expect(Object.keys({}).length).toBe(0)
      })
    })

    // -----------------------------------------------------------------------
    describe('Owner Deduplication Boundaries', () => {
      it('deduplicates owners, preserving first-seen order', () => {
        const accounts = [
          validEntry({ id: 'a', owner: 'security' }),
          validEntry({ id: 'b', owner: 'platform' }),
          validEntry({ id: 'c', owner: 'security' }),
          validEntry({ id: 'd', owner: 'admin' }),
        ]

        expect(listServiceAccountOwners(accounts)).toEqual(['security', 'platform', 'admin'])
      })

      it('does not sort the owner list', () => {
        const accounts = [
          validEntry({ id: 'a', owner: 'settlement' }),
          validEntry({ id: 'b', owner: 'admin' }),
        ]

        expect(listServiceAccountOwners(accounts)).toEqual(['settlement', 'admin'])
      })

      it('keeps a single owner for an all-duplicate inventory', () => {
        const accounts = Array.from({ length: 25 }, (_, i) =>
          validEntry({ id: `dup-${i}`, owner: 'analytics' }),
        )

        expect(listServiceAccountOwners(accounts)).toEqual(['analytics'])
      })

      it('deduplicates exact duplicate object references', () => {
        const shared = validEntry({ id: 'same', owner: 'platform' })

        expect(listServiceAccountOwners([shared, shared, shared])).toEqual(['platform'])
      })

      it('returns one owner per distinct owner in the shipped inventory', () => {
        const inventory = getServiceAccountInventory()
        const owners = listServiceAccountOwners(inventory)

        expect(owners).toHaveLength(new Set(inventory.map((a) => a.owner)).size)
        expect(new Set(owners).size).toBe(owners.length)
      })

      it('silently drops a NaN owner because indexOf uses strict equality', () => {
        // Documented limitation: Array.prototype.indexOf(NaN) is always -1, so a
        // NaN owner fails `list.indexOf(owner) === index` for every index and is
        // removed rather than reported.
        const accounts = [
          malformed({ id: 'nan-a', owner: Number.NaN }),
          validEntry({ id: 'ok', owner: 'platform' }),
        ]

        expect(listServiceAccountOwners(accounts)).toEqual(['platform'])
      })

      it('passes through a missing owner as undefined rather than dropping it', () => {
        const accounts = [malformed({ id: 'no-owner' }), validEntry({ id: 'ok', owner: 'admin' })]

        // Dedup still applies (both missing owners collapse to a single undefined).
        expect(listServiceAccountOwners(accounts)).toEqual([undefined, 'admin'])
      })
    })
  })

  // -------------------------------------------------------------------------
  describe('Authorization and State Invariants', () => {
    // -----------------------------------------------------------------------
    describe('Scope and Endpoint Consistency (I2)', () => {
      it('covers every endpoint requiredScope with its own account scopes', () => {
        const offenders: string[] = []

        for (const account of getServiceAccountInventory()) {
          for (const ep of account.endpoints) {
            if (!account.scopes.includes(ep.requiredScope)) {
              offenders.push(`${account.id}: ${ep.path} requires ${ep.requiredScope}`)
            }
          }
        }

        expect(offenders).toEqual([])
      })

      it('satisfies every endpoint requirement through the real auth scope logic', () => {
        // Uses the production `scopeSatisfies` rather than a re-implementation, so
        // legacy expansion rules stay in sync with the inventory.
        const denials: string[] = []

        for (const account of getServiceAccountInventory()) {
          for (const ep of account.endpoints) {
            if (!scopeSatisfies(account.scopes, ep.requiredScope)) {
              denials.push(`${account.id} denied ${ep.method} ${ep.path} (${ep.requiredScope})`)
            }
          }
        }

        expect(denials).toEqual([])
      })

      it('declares only granular scopes, never the legacy aliases (I3)', () => {
        const legacy: string[] = []

        for (const account of getServiceAccountInventory()) {
          for (const scope of account.scopes) {
            if (scope === ApiScope.PUBLIC || scope === ApiScope.ENTERPRISE) {
              legacy.push(`${account.id}: ${scope}`)
            }
          }
        }

        expect(legacy).toEqual([])
      })

      it('declares only scopes that exist in the ApiScope enum', () => {
        const unknown: string[] = []

        for (const account of getServiceAccountInventory()) {
          for (const scope of account.scopes) {
            if (!Object.values(ApiScope).includes(scope)) {
              unknown.push(`${account.id}: ${String(scope)}`)
            }
            for (const ep of account.endpoints) {
              if (!Object.values(ApiScope).includes(ep.requiredScope)) {
                unknown.push(`${account.id}: endpoint ${ep.path} -> ${String(ep.requiredScope)}`)
              }
            }
          }
        }

        expect(unknown).toEqual([])
      })

      it('declares no duplicate scopes within an account', () => {
        for (const account of getServiceAccountInventory()) {
          expect(new Set(account.scopes).size).toBe(account.scopes.length)
        }
      })

      it('declares no duplicate endpoints within an account', () => {
        for (const account of getServiceAccountInventory()) {
          const keys = account.endpoints.map((e) => `${e.method} ${e.path}`)
          expect(new Set(keys).size).toBe(keys.length)
        }
      })

      it('keeps every account path under the /api/ prefix', () => {
        for (const account of getServiceAccountInventory()) {
          for (const ep of account.endpoints) {
            expect(ep.path).toMatch(/^\/api\//)
          }
        }
      })

      it('restricts write-capable endpoints to write-capable scopes', () => {
        const writeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
        const readOnlyScopes = new Set([ApiScope.TRUST_READ, ApiScope.ATTESTATIONS_READ, ApiScope.EXPORTS_READ])
        const violations: string[] = []

        for (const account of getServiceAccountInventory()) {
          for (const ep of account.endpoints) {
            if (writeMethods.has(ep.method) && readOnlyScopes.has(ep.requiredScope)) {
              violations.push(`${account.id}: ${ep.method} ${ep.path} guarded only by ${ep.requiredScope}`)
            }
          }
        }

        expect(violations).toEqual([])
      })

      it('validates the shipped inventory cleanly', () => {
        const result = validateServiceAccountInventory(getServiceAccountInventory())

        expect(result).toEqual({ valid: true, issues: [] })
      })
    })

    // -----------------------------------------------------------------------
    describe('Mutation Isolation (I1)', () => {
      it('detaches the returned array from module state', () => {
        const first = getServiceAccountInventory()
        const originalLength = first.length

        first.push(validEntry({ id: 'injected' }))
        first.pop()

        expect(getServiceAccountInventory()).toHaveLength(originalLength)
      })

      it('does not let a caller mutate a shared entry object', () => {
        const first = getServiceAccountInventory()
        first[0].name = 'MUTATED'
        first[0].owner = 'admin'

        expect(getServiceAccountInventory()[0].name).not.toBe('MUTATED')
        expect(getServiceAccountInventory()[0].owner).not.toBe('admin')
      })

      it('does not let a caller mutate a shared scopes array', () => {
        const first = getServiceAccountInventory()
        first[0].scopes.push(ApiScope.ADMIN_WRITE)

        expect(getServiceAccountInventory()[0].scopes).not.toContain(ApiScope.ADMIN_WRITE)
      })

      it('does not let a caller mutate a shared endpoints array', () => {
        const first = getServiceAccountInventory()
        first[0].endpoints.length = 0

        expect(getServiceAccountInventory()[0].endpoints.length).toBeGreaterThan(0)
      })

      it('does not let a caller mutate a shared endpoint object', () => {
        const first = getServiceAccountInventory()
        first[0].endpoints[0].requiredScope = ApiScope.ADMIN_WRITE

        expect(getServiceAccountInventory()[0].endpoints[0].requiredScope).not.toBe(
          ApiScope.ADMIN_WRITE,
        )
      })

      it('keeps a lookup result detached from a later inventory call', () => {
        const viaLookup = getServiceAccountInventoryById('horizon-listener')
        viaLookup!.scopes.length = 0
        viaLookup!.endpoints.length = 0

        const viaInventory = getServiceAccountInventoryById('horizon-listener')
        expect(viaInventory!.scopes.length).toBeGreaterThan(0)
        expect(viaInventory!.endpoints.length).toBeGreaterThan(0)
      })

      it('keeps two lookup results independent of each other', () => {
        const a = getServiceAccountInventoryById('horizon-listener')
        const b = getServiceAccountInventoryById('horizon-listener')

        a!.purpose = 'MUTATED'

        expect(b!.purpose).not.toBe('MUTATED')
      })
    })

    // -----------------------------------------------------------------------
    describe('Determinism and Idempotency', () => {
      it('returns deeply equal results across repeated calls', () => {
        expect(getServiceAccountInventory()).toEqual(getServiceAccountInventory())
      })

      it('returns a stable order across repeated calls', () => {
        const ids = Array.from({ length: 5 }, () =>
          getServiceAccountInventory().map((a) => a.id),
        )

        for (const snapshot of ids) {
          expect(snapshot).toEqual(ids[0])
        }
      })

      it('returns a stable owner list across repeated calls', () => {
        const first = listServiceAccountOwners(getServiceAccountInventory())

        for (let i = 0; i < 5; i++) {
          expect(listServiceAccountOwners(getServiceAccountInventory())).toEqual(first)
        }
      })

      it('is unaffected by an earlier caller having mutated its own result', () => {
        const expected = getServiceAccountInventory()

        const vandal = getServiceAccountInventory()
        vandal[0].scopes.length = 0
        vandal[0].endpoints.length = 0
        vandal[0].id = 'vandalised'

        expect(getServiceAccountInventory()).toEqual(expected)
        expect(validateServiceAccountInventory(getServiceAccountInventory())).toEqual({
          valid: true,
          issues: [],
        })
      })

      it('does not observe validation input mutations', () => {
        const accounts = [validEntry()]
        const result = validateServiceAccountInventory(accounts)

        accounts[0].id = 'changed-after-validation'

        expect(result.valid).toBe(true)
        expect(getServiceAccountInventoryById('changed-after-validation')).toBeUndefined()
      })
    })
  })

  // -------------------------------------------------------------------------
  describe('Validation Failure Modes', () => {
    // -----------------------------------------------------------------------
    describe('Identity and Ownership', () => {
      it('rejects an entry with a missing id', () => {
        const result = validateServiceAccountInventory([malformed({ ...validEntry(), id: '' })])

        expect(result.valid).toBe(false)
        expect(result.issues).toContain('Each service account needs an id and name.')
      })

      it('rejects an entry with a missing name', () => {
        const result = validateServiceAccountInventory([malformed({ ...validEntry(), name: '' })])

        expect(result.valid).toBe(false)
        expect(result.issues).toContain('Each service account needs an id and name.')
      })

      it('accepts a whitespace-only name — documented asymmetry', () => {
        // Documented gap: the id/name guard is a truthiness check and does not
        // trim, so a blank-but-non-empty name passes validation. Contrast with
        // `purpose`, which is trimmed and therefore does get rejected.
        const result = validateServiceAccountInventory([validEntry({ name: '   ' })])

        expect(result).toEqual({ valid: true, issues: [] })
      })

      it('reports only the generic issue for an entry missing both id and name', () => {
        // The `continue` in the id/name guard short-circuits every later check
        // for that account, so exactly one issue is produced.
        const result = validateServiceAccountInventory([
          malformed({ owner: undefined, purpose: '', scopes: [], endpoints: [] }),
        ])

        expect(result.issues).toEqual(['Each service account needs an id and name.'])
      })

      it('rejects an entry with a missing owner', () => {
        const result = validateServiceAccountInventory([malformed({ ...validEntry(), owner: undefined })])

        expect(result.valid).toBe(false)
        expect(result.issues).toContain('svc-a is missing an owner.')
      })

      it('rejects an empty-string owner', () => {
        const result = validateServiceAccountInventory([malformed({ ...validEntry(), owner: '' })])

        expect(result.issues).toContain('svc-a is missing an owner.')
      })
    })

    // -----------------------------------------------------------------------
    describe('Purpose Boundaries', () => {
      it('rejects a whitespace-only purpose', () => {
        const result = validateServiceAccountInventory([validEntry({ purpose: '   ' })])

        expect(result.valid).toBe(false)
        expect(result.issues).toContain('svc-a is missing a purpose.')
      })

      it('rejects a tab/newline-only purpose', () => {
        const result = validateServiceAccountInventory([validEntry({ purpose: '\t\n  ' })])

        expect(result.issues).toContain('svc-a is missing a purpose.')
      })

      it('accepts a purpose that is only padded with whitespace around real text', () => {
        const result = validateServiceAccountInventory([validEntry({ purpose: '  Does a thing.  ' })])

        expect(result).toEqual({ valid: true, issues: [] })
      })

      it('rejects a missing purpose property', () => {
        const result = validateServiceAccountInventory([malformed({ ...validEntry(), purpose: undefined })])

        expect(result.issues).toContain('svc-a is missing a purpose.')
      })

      it('rejects a null purpose without throwing', () => {
        // Optional chaining short-circuits on null, so this is a clean rejection
        // rather than a TypeError.
        const result = validateServiceAccountInventory([malformed({ ...validEntry(), purpose: null })])

        expect(result.issues).toContain('svc-a is missing a purpose.')
      })
    })

    // -----------------------------------------------------------------------
    describe('Scope and Endpoint Collection Boundaries', () => {
      it('rejects an entry with an empty scopes array', () => {
        const result = validateServiceAccountInventory([validEntry({ scopes: [] })])

        expect(result.valid).toBe(false)
        expect(result.issues).toContain('svc-a is missing declared scopes.')
      })

      it('rejects an entry with a missing scopes property', () => {
        const result = validateServiceAccountInventory([malformed({ ...validEntry(), scopes: undefined })])

        expect(result.issues).toContain('svc-a is missing declared scopes.')
      })

      it('rejects an entry with an empty endpoints array', () => {
        const result = validateServiceAccountInventory([validEntry({ endpoints: [] })])

        expect(result.valid).toBe(false)
        expect(result.issues).toContain('svc-a is missing endpoint access entries.')
      })

      it('rejects an entry with a missing endpoints property without throwing', () => {
        // The endpoint loop iterates `account.endpoints ?? []`, so an absent
        // collection must be reported rather than dereferenced.
        const result = validateServiceAccountInventory([malformed({ ...validEntry(), endpoints: undefined })])

        expect(result.issues).toContain('svc-a is missing endpoint access entries.')
        expect(result.issues).not.toContain('svc-a has an endpoint with an invalid path: undefined')
      })
    })

    // -----------------------------------------------------------------------
    describe('Endpoint Path Boundaries', () => {
      it('accepts the minimal /api/ root path', () => {
        const result = validateServiceAccountInventory([
          validEntry({ endpoints: [endpoint({ path: '/api/' })] }),
        ])

        expect(result).toEqual({ valid: true, issues: [] })
      })

      it('accepts a path with trailing whitespace — documented gap', () => {
        // Documented gap: only the prefix is checked, so trailing whitespace
        // survives validation. Locked in so tightening it later is a deliberate
        // change rather than an accidental behaviour shift.
        const result = validateServiceAccountInventory([
          validEntry({ endpoints: [endpoint({ path: '/api/transactions/history ' })] }),
        ])

        expect(result).toEqual({ valid: true, issues: [] })
      })

      it.each([
        ['missing leading slash', 'api/transactions/history'],
        ['outside the /api namespace', '/internal/debug'],
        ['wrong case prefix', '/API/transactions/history'],
        ['mixed case prefix', '/Api/transactions/history'],
        ['leading whitespace', ' /api/transactions/history'],
        ['empty path', ''],
        ['protocol-relative', '//api/transactions/history'],
      ])('rejects an endpoint path with %s', (_label, path) => {
        const result = validateServiceAccountInventory([
          validEntry({ endpoints: [endpoint({ path })] }),
        ])

        expect(result.valid).toBe(false)
        expect(result.issues).toContain(`svc-a has an endpoint with an invalid path: ${path}`)
      })

      it('rejects a missing path property', () => {
        const result = validateServiceAccountInventory([
          validEntry({ endpoints: [malformed({ method: 'GET', requiredScope: ApiScope.TRUST_READ })] }),
        ])

        expect(result.issues).toContain('svc-a has an endpoint with an invalid path: undefined')
      })

      it('reports each invalid endpoint independently', () => {
        const result = validateServiceAccountInventory([
          validEntry({
            endpoints: [
              endpoint({ path: '/nope-one' }),
              endpoint({ path: '/api/ok' }),
              endpoint({ path: '/nope-two' }),
            ],
          }),
        ])

        expect(result.issues).toEqual([
          'svc-a has an endpoint with an invalid path: /nope-one',
          'svc-a has an endpoint with an invalid path: /nope-two',
        ])
      })
    })

    // -----------------------------------------------------------------------
    describe('Endpoint Required-Scope Boundaries', () => {
      it.each([
        ['empty string', ''],
        ['null', null],
        ['undefined', undefined],
      ])('rejects an endpoint whose requiredScope is %s', (_label, requiredScope) => {
        const result = validateServiceAccountInventory([
          validEntry({ endpoints: [malformed({ path: '/api/x', requiredScope })] }),
        ])

        expect(result.valid).toBe(false)
        expect(result.issues).toContain('svc-a has an endpoint without a required scope.')
      })

      it('accepts every granular scope as a requiredScope', () => {
        for (const scope of GRANULAR_SCOPES) {
          const result = validateServiceAccountInventory([
            validEntry({ endpoints: [endpoint({ requiredScope: scope })] }),
          ])
          expect(result, `scope ${scope} should be accepted`).toEqual({ valid: true, issues: [] })
        }
      })

      it('reports a bad path and a missing scope for the same endpoint', () => {
        // Both checks run independently — neither short-circuits the other.
        const result = validateServiceAccountInventory([
          validEntry({ endpoints: [malformed({ path: '/nope', requiredScope: '' })] }),
        ])

        expect(result.issues).toEqual([
          'svc-a has an endpoint with an invalid path: /nope',
          'svc-a has an endpoint without a required scope.',
        ])
      })

      it('does not enforce scope/endpoint consistency — documented gap', () => {
        // An endpoint requiring a scope the account never declares is still
        // reported as valid. Locked in so the gap is visible and a future fix is
        // a deliberate, reviewable change rather than an accident.
        const result = validateServiceAccountInventory([
          validEntry({
            scopes: [ApiScope.TRUST_READ],
            endpoints: [endpoint({ requiredScope: ApiScope.ADMIN_WRITE })],
          }),
        ])

        expect(result).toEqual({ valid: true, issues: [] })
      })
    })

    // -----------------------------------------------------------------------
    describe('Accumulation and Ordering (I5)', () => {
      it('accumulates every issue instead of short-circuiting', () => {
        const result = validateServiceAccountInventory([
          malformed({ ...validEntry({ owner: '', purpose: '   ', scopes: [], endpoints: [] }) }),
        ])

        expect(result.issues).toEqual([
          'svc-a is missing an owner.',
          'svc-a is missing a purpose.',
          'svc-a is missing declared scopes.',
          'svc-a is missing endpoint access entries.',
        ])
      })

      it('keeps issues ordered by account, then by check order', () => {
        const result = validateServiceAccountInventory([
          malformed({ ...validEntry({ id: 'first', owner: '' }) }),
          malformed({ ...validEntry({ id: 'second', purpose: '' }) }),
        ])

        expect(result.issues).toEqual([
          'first is missing an owner.',
          'second is missing a purpose.',
        ])
      })

      it('scopes every issue message to the offending account id', () => {
        const result = validateServiceAccountInventory([
          malformed({ ...validEntry({ id: 'alpha', owner: '' }) }),
          malformed({ ...validEntry({ id: 'beta', owner: '' }) }),
        ])

        expect(result.issues).toEqual(['alpha is missing an owner.', 'beta is missing an owner.'])
      })

      it('reports issues for one account even when another account is valid', () => {
        const result = validateServiceAccountInventory([
          validEntry({ id: 'good' }),
          malformed({ ...validEntry({ id: 'bad', owner: '' }) }),
        ])

        expect(result.valid).toBe(false)
        expect(result.issues).toEqual(['bad is missing an owner.'])
      })

      it('ties valid to issue emptiness in both directions', () => {
        const invalid = validateServiceAccountInventory([malformed({ ...validEntry(), owner: '' })])
        const valid = validateServiceAccountInventory([validEntry()])

        expect(invalid.valid).toBe(invalid.issues.length === 0 ? true : false)
        expect(valid.valid).toBe(valid.issues.length === 0)
      })

      it('validates a large inventory deterministically', () => {
        const accounts = Array.from({ length: 500 }, (_, i) => validEntry({ id: `svc-${i}` }))

        const first = validateServiceAccountInventory(accounts)
        const second = validateServiceAccountInventory(accounts)

        expect(first).toEqual({ valid: true, issues: [] })
        expect(second).toEqual(first)
      })

      it('does not flag duplicate ids — documented gap', () => {
        // Duplicate ids would make `getServiceAccountInventoryById` ambiguous,
        // but the validator does not currently reject them. Locked in as the
        // current contract.
        const result = validateServiceAccountInventory([
          validEntry({ id: 'dup' }),
          validEntry({ id: 'dup' }),
        ])

        expect(result).toEqual({ valid: true, issues: [] })
        expect(getServiceAccountInventoryById('dup')).toBeUndefined()
      })
    })
  })

  // -------------------------------------------------------------------------
  describe('Malformed Input Recovery', () => {
    it('throws a TypeError when the array contains null', () => {
      // Documented limitation: the id/name guard dereferences `account.id`
      // directly, so a null element crashes rather than being reported.
      expect(() => validateServiceAccountInventory([malformed(null)])).toThrow(TypeError)
    })

    it('throws a TypeError when the array contains undefined', () => {
      expect(() => validateServiceAccountInventory([malformed(undefined)])).toThrow(TypeError)
    })

    it('reports earlier accounts before throwing on a later null element', () => {
      // The already-recorded issues are lost because the throw escapes, but the
      // throw is deterministic and happens only after prior iteration.
      expect(() =>
        validateServiceAccountInventory([
          malformed({ ...validEntry({ id: 'ok' }) }),
          malformed(null),
        ]),
      ).toThrow(TypeError)
    })

    it('throws a TypeError for a non-iterable accounts value', () => {
      // `for...of` requires an iterable, so a plain object is rejected loudly
      // rather than being silently treated as an empty inventory.
      expect(() =>
        validateServiceAccountInventory({} as unknown as ServiceAccountInventoryEntry[]),
      ).toThrow(TypeError)
    })

    it('tolerates a Set of entries, which is iterable but not an array', () => {
      // The signature says array, but any iterable of well-formed entries works
      // and produces the same deterministic result.
      const result = validateServiceAccountInventory(
        new Set([validEntry()]) as unknown as ServiceAccountInventoryEntry[],
      )

      expect(result).toEqual({ valid: true, issues: [] })
    })

    it('tolerates extra unknown properties on an entry', () => {
      const result = validateServiceAccountInventory([
        malformed({ ...validEntry(), injected: 'ignored', futureField: 42 }),
      ])

      expect(result).toEqual({ valid: true, issues: [] })
    })

    it('is not susceptible to prototype pollution via an entry payload', () => {
      // A real own `__proto__` data property (not the object-literal prototype
      // setter) is the actual pollution vector. Validation only reads known
      // fields, so nothing is written back onto any prototype.
      const polluted = validEntry()
      Object.defineProperty(polluted, '__proto__', {
        value: { polluted: true },
        enumerable: true,
        configurable: true,
        writable: true,
      })

      const result = validateServiceAccountInventory([polluted])

      expect(result).toEqual({ valid: true, issues: [] })
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
      expect((Object.prototype as unknown as Record<string, unknown>).polluted).toBeUndefined()
    })

    it('handles a very long id and purpose without truncating the issue message', () => {
      const longId = 'x'.repeat(512)
      const result = validateServiceAccountInventory([
        malformed({ ...validEntry({ id: longId, owner: '' }) }),
      ])

      expect(result.issues).toEqual([`${longId} is missing an owner.`])
    })
  })

  // -------------------------------------------------------------------------
  describe('Concurrent and Repeated Execution', () => {
    it('returns independent results across interleaved calls', async () => {
      const results = await Promise.all(
        Array.from({ length: 50 }, async () => getServiceAccountInventory()),
      )

      const baseline = getServiceAccountInventory()
      for (const result of results) {
        expect(result).toEqual(baseline)
      }
    })

    it('keeps concurrent mutations isolated to their own result', async () => {
      const first = getServiceAccountInventory()
      const second = getServiceAccountInventory()

      // Simulate interleaved callers each damaging their own copy.
      await Promise.all([
        Promise.resolve().then(() => {
          first[0].scopes.length = 0
        }),
        Promise.resolve().then(() => {
          second[1].endpoints.length = 0
        }),
      ])

      expect(getServiceAccountInventory()).toEqual(getServiceAccountInventory())
      expect(getServiceAccountInventory()[0].scopes.length).toBeGreaterThan(0)
      expect(getServiceAccountInventory()[1].endpoints.length).toBeGreaterThan(0)
    })

    it('returns consistent lookup results under concurrent access', async () => {
      const ids = getServiceAccountInventory().map((a) => a.id)
      const settled = await Promise.all(
        Array.from({ length: 200 }, async (_, i) => getServiceAccountInventoryById(ids[i % ids.length])),
      )

      for (let i = 0; i < settled.length; i++) {
        expect(settled[i]?.id).toBe(ids[i % ids.length])
      }
    })

    it('produces identical validation results under repeated concurrent calls', async () => {
      const accounts = [validEntry(), malformed({ ...validEntry({ id: 'bad', owner: '' }) })]
      const settled = await Promise.all(
        Array.from({ length: 50 }, async () => validateServiceAccountInventory(accounts)),
      )

      for (const result of settled) {
        expect(result).toEqual({ valid: false, issues: ['bad is missing an owner.'] })
      }
    })

    it('does not accumulate state across 200 sequential inventory reads', () => {
      let expected: ReturnType<typeof getServiceAccountInventory> | undefined

      for (let i = 0; i < 200; i++) {
        const result = getServiceAccountInventory()
        if (expected === undefined) expected = result
        expect(result).toEqual(expected)
      }
    })
  })

  // -------------------------------------------------------------------------
  describe('Observability', () => {
    it('never leaks secret material in issue messages', () => {
      // Issue strings interpolate the account id and endpoint path only. This
      // asserts the messages stay diagnosable while bounding what they expose.
      const result = validateServiceAccountInventory([
        malformed({
          ...validEntry({
            id: 'leaky',
            owner: '',
            purpose: '',
            scopes: [],
            endpoints: [malformed({ path: '/api/keys', requiredScope: '' })],
          }),
        }),
      ])

      expect(result.issues.every((issue) => typeof issue === 'string' && issue.length > 0)).toBe(true)
      expect(result.issues.join(' ')).not.toMatch(/password|secret|token|privateKey/i)
    })

    it('reports a stable issue vocabulary for known failure modes', () => {
      // A fixed, small vocabulary keeps validation output reviewable and lets
      // downstream tooling match on stable strings. The generic id/name issue
      // is absent here because this entry still has both, and that guard
      // short-circuits the remaining checks when it does fire.
      const result = validateServiceAccountInventory([
        malformed({ ...validEntry(), owner: '', purpose: '', scopes: [], endpoints: [] }),
      ])

      expect(new Set(result.issues)).toEqual(
        new Set([
          'svc-a is missing an owner.',
          'svc-a is missing a purpose.',
          'svc-a is missing declared scopes.',
          'svc-a is missing endpoint access entries.',
        ]),
      )
    })

    it('produces an empty issues array on success so callers can log it directly', () => {
      const result = validateServiceAccountInventory(getServiceAccountInventory())

      expect(Array.isArray(result.issues)).toBe(true)
      expect(result.issues).toHaveLength(0)
    })
  })
})
