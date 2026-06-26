import { AuditAction } from './audit/index.js'
import type { AuditLogService } from './audit/index.js'
import type { ApiKeyRepository } from '../repositories/apiKeyRepository.js'
import type { CreateApiKeyResult, KeyScope, StoredApiKey, SubscriptionTier } from './apiKeys.js'
import { getTenantId } from '../utils/tenantContext.js'

/**
 * High-level service for managing integration API keys.
 *
 * Every mutating operation is recorded in the audit trail so that key
 * creation, rotation, and revocation events can be replayed or reviewed
 * later for compliance and security purposes.
 */
export class ApiKeyRotationService {
  constructor(
    private readonly repo: ApiKeyRepository,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Resolve the tenant for audit records from the ambient request context.
   * API-key operations run inside a tenant-scoped ALS; when invoked outside a
   * tenant scope (e.g. background tooling) we fall back to a sentinel value so
   * the audit entry still satisfies the required-tenant contract.
   */
  private resolveTenantId(): string {
    return getTenantId() ?? 'tenant-unknown'
  }

  /**
   * Issue a new integration API key and log the creation event.
   *
   * @param ownerId    - Identifier of the key owner (user/org).
   * @param actorEmail - Email of the requesting principal (for the audit entry).
   * @param scope      - Access scope: `'read'` (default) or `'full'`.
   * @param tier       - Subscription tier that controls rate limits.
   * @param ipAddress  - Optional originating IP for the audit record.
   * @returns Key metadata including the raw key — store it securely; shown once.
   */
  async issueKey(
    ownerId: string,
    actorEmail: string,
    scope: KeyScope = 'read',
    tier: SubscriptionTier = 'free',
    ipAddress?: string,
  ): Promise<CreateApiKeyResult> {
    const result = this.repo.create(ownerId, scope, tier)

    await this.audit.logAction({
      tenantId: this.resolveTenantId(),
      actorId: ownerId,
      actorEmail,
      action: AuditAction.CREATE_API_KEY,
      resourceType: 'api_key',
      resourceId: result.id,
      details: { keyId: result.id, prefix: result.prefix, scope, tier },
      status: 'success',
      ipAddress,
    })

    return result
  }

  /**
   * Rotate an integration API key.
   *
   * Atomically revokes the existing key and generates a replacement that
   * inherits the same owner, scope, and tier.  This is the canonical "safe
   * invalidation" path — the old key stops working the instant this call
   * succeeds, and the new raw key is only exposed in the return value.
   *
   * Failed attempts (not found, already revoked) are also written to the
   * audit log so that suspicious rotation probes are visible.
   *
   * @param keyId      - Opaque ID of the key to rotate.
   * @param actorId    - ID of the principal requesting the rotation.
   * @param actorEmail - Email of the requesting principal.
   * @param ipAddress  - Optional originating IP for the audit record.
   * @returns New key metadata (raw key included), or null if the key was not
   *          found or was already revoked.
   */
  async rotateKey(
    keyId: string,
    actorId: string,
    actorEmail: string,
    ipAddress?: string,
  ): Promise<CreateApiKeyResult | null> {
    const existing = this.repo.findById(keyId)

    if (!existing) {
      await this.audit.logAction({
        tenantId: this.resolveTenantId(),
        actorId,
        actorEmail,
        action: AuditAction.ROTATE_API_KEY,
        resourceType: 'api_key',
        resourceId: keyId,
        details: { keyId, reason: 'key_not_found' },
        status: 'failure',
        errorMessage: 'API key not found',
        ipAddress,
      })
      return null
    }

    if (!existing.active) {
      await this.audit.logAction({
        tenantId: this.resolveTenantId(),
        actorId,
        actorEmail,
        action: AuditAction.ROTATE_API_KEY,
        resourceType: 'api_key',
        resourceId: keyId,
        details: { keyId, reason: 'key_already_revoked' },
        status: 'failure',
        errorMessage: 'API key is already revoked',
        ipAddress,
      })
      return null
    }

    const newKey = this.repo.rotate(keyId)

    // Guard: rotate() checks the same conditions, but a concurrent revoke
    // between our findById and this call could yield null here.
    if (!newKey) {
      return null
    }

    await this.audit.logAction({
      tenantId: this.resolveTenantId(),
      actorId,
      actorEmail,
      action: AuditAction.ROTATE_API_KEY,
      resourceType: 'api_key',
      resourceId: keyId,
      details: {
        revokedKeyId: keyId,
        newKeyId: newKey.id,
        newKeyPrefix: newKey.prefix,
        scope: newKey.scope,
        tier: newKey.tier,
        ownerId: existing.ownerId,
      },
      status: 'success',
      ipAddress,
    })

    return newKey
  }

  /**
   * Permanently revoke an integration API key and record the action.
   *
   * @param keyId      - Opaque ID of the key to revoke.
   * @param actorId    - ID of the principal performing the revocation.
   * @param actorEmail - Email of the requesting principal.
   * @param ipAddress  - Optional originating IP for the audit record.
   * @returns true when the key was found and deactivated; false if not found.
   */
  async revokeKey(
    keyId: string,
    actorId: string,
    actorEmail: string,
    ipAddress?: string,
  ): Promise<boolean> {
    const existing = this.repo.findById(keyId)
    const revoked = this.repo.revoke(keyId)

    await this.audit.logAction({
      tenantId: this.resolveTenantId(),
      actorId,
      actorEmail,
      action: AuditAction.REVOKE_API_KEY,
      resourceType: 'api_key',
      resourceId: keyId,
      details: {
        keyId,
        ownerId: existing?.ownerId ?? 'unknown',
        prefix: existing?.prefix ?? 'unknown',
      },
      status: revoked ? 'success' : 'failure',
      errorMessage: revoked ? undefined : 'API key not found',
      ipAddress,
    })

    return revoked
  }

  /**
   * List all API keys belonging to the given owner.
   * The raw key hash is never included in the result.
   *
   * @param ownerId - Owner whose keys should be listed.
   * @returns Array of key metadata records (active and revoked).
   */
  listKeys(ownerId: string): Omit<StoredApiKey, 'hashedKey'>[] {
    return this.repo.listByOwner(ownerId)
  }
}
