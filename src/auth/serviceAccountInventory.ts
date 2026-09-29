import { ApiScope } from '../middleware/auth.js'

export interface ServiceAccountEndpoint {
  path: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  requiredScope: ApiScope
  description: string
}

export interface ServiceAccountInventoryEntry {
  id: string
  name: string
  owner: 'platform' | 'settlement' | 'admin' | 'security' | 'analytics'
  purpose: string
  scopes: ApiScope[]
  endpoints: ServiceAccountEndpoint[]
  notes?: string
}

export interface ServiceAccountInventoryValidationResult {
  valid: boolean
  issues: string[]
}

const inventory: ServiceAccountInventoryEntry[] = [
  {
    id: 'horizon-listener',
    name: 'Horizon listener',
    owner: 'platform',
    purpose: 'Consumes Stellar Horizon events and writes attestation and trust updates into the backend.',
    scopes: [ApiScope.TRUST_READ, ApiScope.ATTESTATIONS_READ],
    endpoints: [
      {
        path: '/api/transactions/history',
        method: 'GET',
        requiredScope: ApiScope.TRUST_READ,
        description: 'Reads trust and settlement history for downstream processing.',
      },
      {
        path: '/api/attestations/:address',
        method: 'GET',
        requiredScope: ApiScope.ATTESTATIONS_READ,
        description: 'Reads attestations for a subject address.',
      },
    ],
  },
  {
    id: 'outbox-publisher',
    name: 'Outbox publisher',
    owner: 'platform',
    purpose: 'Re-injects quarantined outbox events to external subscribers with idempotency protections.',
    scopes: [ApiScope.OUTBOX_REINJECT],
    endpoints: [
      {
        path: '/api/admin/outbox/quarantine/:id/reinject',
        method: 'POST',
        requiredScope: ApiScope.OUTBOX_REINJECT,
        description: 'Re-injects quarantined outbox events.',
      },
    ],
  },
  {
    id: 'analytics-refresher',
    name: 'Analytics refresher',
    owner: 'analytics',
    purpose: 'Refreshes analytics and export datasets for reporting jobs.',
    scopes: [ApiScope.TRUST_READ, ApiScope.ATTESTATIONS_READ, ApiScope.EXPORTS_READ],
    endpoints: [
      {
        path: '/api/transactions/history',
        method: 'GET',
        requiredScope: ApiScope.TRUST_READ,
        description: 'Reads transaction history for reporting refreshes.',
      },
      {
        path: '/api/attestations/:address',
        method: 'GET',
        requiredScope: ApiScope.ATTESTATIONS_READ,
        description: 'Reads attestation history for analytics aggregation.',
      },
    ],
  },
  {
    id: 'data-retention',
    name: 'Data retention worker',
    owner: 'security',
    purpose: 'Runs retention tasks that inspect background metadata and audit data.',
    scopes: [ApiScope.ADMIN_READ],
    endpoints: [
      {
        path: '/api/admin/audit-logs',
        method: 'GET',
        requiredScope: ApiScope.ADMIN_READ,
        description: 'Reads audit log metadata for retention decisions.',
      },
    ],
  },
  {
    id: 'key-rotation-worker',
    name: 'Key rotation worker',
    owner: 'security',
    purpose: 'Coordinates signing-key and API-key rotation maintenance.',
    scopes: [ApiScope.ADMIN_READ],
    endpoints: [
      {
        path: '/api/admin/audit-logs',
        method: 'GET',
        requiredScope: ApiScope.ADMIN_READ,
        description: 'Reads admin metadata while rotating credentials.',
      },
    ],
  },
  {
    id: 'settlement-reconciler',
    name: 'Settlement reconciler',
    owner: 'settlement',
    purpose: 'Reconciles on-chain settlement state and posts payout updates.',
    scopes: [ApiScope.PAYOUTS_WRITE, ApiScope.TRUST_READ, ApiScope.BOND_READ],
    endpoints: [
      {
        path: '/api/payouts',
        method: 'POST',
        requiredScope: ApiScope.PAYOUTS_WRITE,
        description: 'Creates or updates payout settlement state.',
      },
      {
        path: '/api/transactions/history',
        method: 'GET',
        requiredScope: ApiScope.TRUST_READ,
        description: 'Reads transaction history to reconcile settlement state.',
      },
    ],
  },
  {
    id: 'impersonation-service',
    name: 'Impersonation service',
    owner: 'admin',
    purpose: 'Issues temporary impersonation tokens for support and debugging use cases.',
    scopes: [ApiScope.ADMIN_WRITE],
    endpoints: [
      {
        path: '/api/admin/impersonate',
        method: 'POST',
        requiredScope: ApiScope.ADMIN_WRITE,
        description: 'Issues impersonation tokens for administrative support workflows.',
      },
    ],
  },
]

export function getServiceAccountInventory(): ServiceAccountInventoryEntry[] {
  return inventory.map((entry) => ({ ...entry, scopes: [...entry.scopes], endpoints: entry.endpoints.map((endpoint) => ({ ...endpoint })) }))
}

export function getServiceAccountInventoryById(id: string): ServiceAccountInventoryEntry | undefined {
  return getServiceAccountInventory().find((entry) => entry.id === id)
}

export function listServiceAccountOwners(accounts: ServiceAccountInventoryEntry[]): string[] {
  return accounts.map((account) => account.owner).filter((owner, index, list) => list.indexOf(owner) === index)
}

export function validateServiceAccountInventory(accounts: ServiceAccountInventoryEntry[]): ServiceAccountInventoryValidationResult {
  const issues: string[] = []

  for (const account of accounts) {
    if (!account.id || !account.name) {
      issues.push('Each service account needs an id and name.')
      continue
    }

    if (!account.owner) {
      issues.push(`${account.id} is missing an owner.`)
    }

    if (!account.purpose?.trim()) {
      issues.push(`${account.id} is missing a purpose.`)
    }

    if (!account.scopes?.length) {
      issues.push(`${account.id} is missing declared scopes.`)
    }

    if (!account.endpoints?.length) {
      issues.push(`${account.id} is missing endpoint access entries.`)
    }

    for (const endpoint of account.endpoints ?? []) {
      if (!endpoint.path?.startsWith('/api/')) {
        issues.push(`${account.id} has an endpoint with an invalid path: ${endpoint.path}`)
      }
      if (!endpoint.requiredScope) {
        issues.push(`${account.id} has an endpoint without a required scope.`)
      }
    }
  }

  return { valid: issues.length === 0, issues }
}
