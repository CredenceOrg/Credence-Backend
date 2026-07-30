import { ApiKeyScope } from '../apiKeys.js'

/**
 * List of officially documented and approved service account permissions/scopes.
 * Any scope assigned to a service account MUST belong to this set.
 */
export const DOCUMENTED_SERVICE_ACCOUNT_SCOPES: ReadonlySet<string> = new Set([
  ApiKeyScope.TRUST_READ,
  ApiKeyScope.ATTESTATIONS_READ,
  ApiKeyScope.ATTESTATIONS_WRITE,
  ApiKeyScope.PAYOUTS_WRITE,
  ApiKeyScope.REPORTS_GENERATE,
  ApiKeyScope.EXPORTS_READ,
  ApiKeyScope.WEBHOOKS_ADMIN,
  ApiKeyScope.OUTBOX_REINJECT,
  ApiKeyScope.ADMIN_READ,
  ApiKeyScope.ADMIN_WRITE,
  ApiKeyScope.FLAGS_READ,
  ApiKeyScope.FLAGS_WRITE,
  ApiKeyScope.BOND_READ,
  ApiKeyScope.BOND_WRITE,
])

export interface ServiceAccount {
  id: string
  name: string
  scopes: string[]
  role?: string
}

export interface ServiceAccountAuditResult {
  serviceAccountId: string
  serviceAccountName: string
  compliant: boolean
  undocumentedScopes: string[]
}

export interface SystemAuditSummary {
  passed: boolean
  totalAccountsChecked: number
  violationsCount: number
  results: ServiceAccountAuditResult[]
}

/**
 * Audits a single service account to ensure it does not hold permissions beyond documented scopes.
 */
export function auditServiceAccountPermissions(account: ServiceAccount): ServiceAccountAuditResult {
  const undocumentedScopes = account.scopes.filter(
    (scope) => !DOCUMENTED_SERVICE_ACCOUNT_SCOPES.has(scope)
  )

  return {
    serviceAccountId: account.id,
    serviceAccountName: account.name,
    compliant: undocumentedScopes.length === 0,
    undocumentedScopes,
  }
}

/**
 * Audits a batch of service accounts and produces a comprehensive compliance summary.
 */
export function auditAllServiceAccounts(accounts: ServiceAccount[]): SystemAuditSummary {
  const results = accounts.map(auditServiceAccountPermissions)
  const violations = results.filter((r) => !r.compliant)

  return {
    passed: violations.length === 0,
    totalAccountsChecked: accounts.length,
    violationsCount: violations.length,
    results,
  }
}
