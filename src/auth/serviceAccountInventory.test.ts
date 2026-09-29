import { describe, expect, it } from 'vitest'
import {
  getServiceAccountInventory,
  getServiceAccountInventoryById,
  listServiceAccountOwners,
  validateServiceAccountInventory,
} from './serviceAccountInventory.js'

describe('service account inventory', () => {
  it('documents the core backend service accounts and their ownership', () => {
    const inventory = getServiceAccountInventory()

    expect(inventory.map((account) => account.id)).toEqual(
      expect.arrayContaining([
        'horizon-listener',
        'outbox-publisher',
        'settlement-reconciler',
        'impersonation-service',
      ]),
    )

    expect(listServiceAccountOwners(inventory)).toEqual(
      expect.arrayContaining(['platform', 'settlement', 'admin', 'security']),
    )
  })

  it('maps each service account to explicit backend endpoints and scopes', () => {
    const inventory = getServiceAccountInventory()

    for (const account of inventory) {
      expect(account.endpoints.length).toBeGreaterThan(0)

      for (const endpoint of account.endpoints) {
        expect(endpoint.path).toMatch(/^\/api\//)
        expect(endpoint.requiredScope).toBeTruthy()
      }
    }
  })

  it('validates the inventory and rejects accounts missing owners or endpoints', () => {
    const result = validateServiceAccountInventory(getServiceAccountInventory())

    expect(result.valid).toBe(true)
    expect(result.issues).toEqual([])
  })

  it('returns a single service account by id', () => {
    const account = getServiceAccountInventoryById('settlement-reconciler')

    expect(account?.owner).toBe('settlement')
    expect(account?.purpose).toContain('settlement')
  })
})
