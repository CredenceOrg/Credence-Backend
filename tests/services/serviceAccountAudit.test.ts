import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  auditServiceAccountPermissions,
  auditAllServiceAccounts,
  DOCUMENTED_SERVICE_ACCOUNT_SCOPES,
  type ServiceAccount,
} from '../../src/services/audit/serviceAccountAudit.js'
import { ApiKeyScope } from '../../src/services/apiKeys.js'

describe('Service Account Permission Audit', () => {
  describe('auditServiceAccountPermissions', () => {
    it('returns_compliant_status_when_service_account_has_only_documented_permissions', () => {
      const validAccount: ServiceAccount = {
        id: 'sa-1',
        name: 'attestation-worker',
        scopes: [ApiKeyScope.ATTESTATIONS_READ, ApiKeyScope.ATTESTATIONS_WRITE],
      }

      const result = auditServiceAccountPermissions(validAccount)

      expect(result.compliant).toBe(true)
      expect(result.undocumentedScopes).toHaveLength(0)
    })

    it('returns_non_compliant_status_when_service_account_has_undocumented_permissions', () => {
      const invalidAccount: ServiceAccount = {
        id: 'sa-2',
        name: 'rogue-worker',
        scopes: [ApiKeyScope.TRUST_READ, 'unauthorized:admin', 'root:all'],
      }

      const result = auditServiceAccountPermissions(invalidAccount)

      expect(result.compliant).toBe(false)
      expect(result.undocumentedScopes).toEqual(['unauthorized:admin', 'root:all'])
    })

    it('detects_wildcard_or_excessive_permissions_on_service_accounts', () => {
      const wildcardAccount: ServiceAccount = {
        id: 'sa-3',
        name: 'overprivileged-sa',
        scopes: ['*'],
      }

      const result = auditServiceAccountPermissions(wildcardAccount)

      expect(result.compliant).toBe(false)
      expect(result.undocumentedScopes).toContain('*')
    })
  })

  describe('auditAllServiceAccounts', () => {
    it('audits_multiple_service_accounts_and_reports_system_compliance', () => {
      const accounts: ServiceAccount[] = [
        {
          id: 'sa-10',
          name: 'read-service',
          scopes: [ApiKeyScope.TRUST_READ],
        },
        {
          id: 'sa-11',
          name: 'audit-service',
          scopes: [ApiKeyScope.EXPORTS_READ],
        },
      ]

      const summary = auditAllServiceAccounts(accounts)

      expect(summary.passed).toBe(true)
      expect(summary.totalAccountsChecked).toBe(2)
      expect(summary.violationsCount).toBe(0)
    })

    it('fails_system_summary_when_at_least_one_service_account_exceeds_documented_permissions', () => {
      const accounts: ServiceAccount[] = [
        {
          id: 'sa-10',
          name: 'read-service',
          scopes: [ApiKeyScope.TRUST_READ],
        },
        {
          id: 'sa-99',
          name: 'bad-service',
          scopes: ['db:drop_table'],
        },
      ]

      const summary = auditAllServiceAccounts(accounts)

      expect(summary.passed).toBe(false)
      expect(summary.totalAccountsChecked).toBe(2)
      expect(summary.violationsCount).toBe(1)
    })
  })

  describe('Property-Based Tests (fast-check)', () => {
    const documentedScopesArray = Array.from(DOCUMENTED_SERVICE_ACCOUNT_SCOPES)

    it('property_based_audit_flags_any_undocumented_scope', () => {
      fc.assert(
        fc.property(
          fc.array(fc.string({ minLength: 1 })),
          (randomScopes) => {
            const account: ServiceAccount = {
              id: 'sa-prop',
              name: 'prop-test-account',
              scopes: randomScopes,
            }

            const result = auditServiceAccountPermissions(account)
            const expectedUndocumented = randomScopes.filter(
              (s) => !DOCUMENTED_SERVICE_ACCOUNT_SCOPES.has(s)
            )

            expect(result.compliant).toBe(expectedUndocumented.length === 0)
            expect(result.undocumentedScopes).toEqual(expectedUndocumented)
          }
        )
      )
    })

    it('property_based_audit_passes_for_any_combination_of_documented_scopes', () => {
      fc.assert(
        fc.property(
          fc.subarray(documentedScopesArray),
          (validScopes) => {
            const account: ServiceAccount = {
              id: 'sa-valid-prop',
              name: 'valid-prop-test-account',
              scopes: validScopes,
            }

            const result = auditServiceAccountPermissions(account)
            expect(result.compliant).toBe(true)
            expect(result.undocumentedScopes).toHaveLength(0)
          }
        )
      )
    })
  })
})
