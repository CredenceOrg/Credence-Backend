import type { Pool, PoolClient } from 'pg'
import type { Attestation as ApiAttestation, CreateAttestationParams } from '../types/attestation.js'
import { AttestationsRepository } from '../db/repositories/attestationsRepository.js'
import { AttestationCacheService } from './attestationCacheService.js'
import { TransactionManager } from '../db/transaction.js'
import { outboxEmitter } from '../db/outbox/emitter.js'
import { normalizeAddress } from '../lib/address.js'
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js'

const PG_UNIQUE_VIOLATION = '23505'

export interface AttestationsApiServiceDeps {
  pool: Pool
  repository?: AttestationsRepository
  cacheService?: AttestationCacheService
  txManager?: TransactionManager
}

function mapPgToApi(row: {
  id: number
  attesterAddress: string
  subjectAddress: string
  score: number
  note: string | null
  createdAt: Date
}): ApiAttestation {
  return {
    id: String(row.id),
    subject: row.subjectAddress,
    verifier: row.attesterAddress,
    weight: row.score,
    claim: row.note ?? '',
    createdAt: row.createdAt.toISOString(),
    revokedAt: null,
  }
}

/**
 * Production attestation API backed by PostgreSQL, cache, and outbox events.
 */
export class AttestationsApiService {
  private readonly pool: Pool
  private readonly repository: AttestationsRepository
  private readonly cacheService: AttestationCacheService
  private readonly txManager: TransactionManager

  constructor(deps: AttestationsApiServiceDeps) {
    this.pool = deps.pool
    this.repository = deps.repository ?? new AttestationsRepository(deps.pool)
    this.cacheService = deps.cacheService ?? new AttestationCacheService(this.repository)
    this.txManager = deps.txManager ?? new TransactionManager(deps.pool)
  }

  async countBySubject(subject: string, _includeRevoked = false): Promise<number> {
    const normalized = normalizeAddress(subject)
    return this.repository.countBySubject(normalized)
  }

  async findBySubject(
    subject: string,
    options: { includeRevoked?: boolean; offset: number; limit: number },
  ): Promise<{ attestations: ApiAttestation[]; total: number }> {
    const normalized = normalizeAddress(subject)
    const { rows, total } = await this.cacheService.getAttestationsBySubjectPaginated(
      normalized,
      { offset: options.offset, limit: options.limit },
    )

    return {
      attestations: rows.map(mapPgToApi),
      total,
    }
  }

  async create(params: CreateAttestationParams & { bondId?: number }): Promise<ApiAttestation> {
    const subject = normalizeAddress(params.subject)
    const verifier = normalizeAddress(params.verifier)

    try {
      const attestation = await this.txManager.withTransaction(async (client: PoolClient) => {
        await this.ensureIdentity(subject, client)
        await this.ensureIdentity(verifier, client)

        const bondId = params.bondId ?? (await this.resolveBondId(subject, client))
        if (bondId === null) {
          throw new ValidationError(
            'No active bond found for subject; provide bondId to create an attestation',
            [{ path: 'bondId', message: 'Active bond required', code: 'field_required' }],
          )
        }

        const created = await this.repository.create(
          {
            bondId,
            attesterAddress: verifier,
            subjectAddress: subject,
            score: params.weight,
            note: params.claim,
          },
          client,
        )

        await outboxEmitter.emit(client, {
          aggregateType: 'attestation',
          aggregateId: String(created.id),
          eventType: 'attestation.created',
          payload: {
            id: created.id,
            bondId: created.bondId,
            subject: created.subjectAddress,
            verifier: created.attesterAddress,
            weight: created.score,
            claim: created.note,
            createdAt: created.createdAt.toISOString(),
          },
        })

        return created
      })

      await this.cacheService.invalidateAfterCreate(attestation)

      return mapPgToApi(attestation)
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code: string }).code === PG_UNIQUE_VIOLATION
      ) {
        throw new ConflictError(
          'An attestation from this verifier for this subject already exists on the bond',
        )
      }
      throw error
    }
  }

  async revoke(_id: string): Promise<ApiAttestation> {
    throw new NotFoundError('Attestation revocation is not supported for persisted attestations yet')
  }

  private async ensureIdentity(address: string, client: PoolClient): Promise<void> {
    await client.query(
      `
      INSERT INTO identities (address)
      VALUES ($1)
      ON CONFLICT (address) DO NOTHING
      `,
      [address],
    )
  }

  private async resolveBondId(subject: string, client: PoolClient): Promise<number | null> {
    const result = await client.query<{ id: string }>(
      `
      SELECT id
      FROM bonds
      WHERE identity_address = $1
        AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [subject],
    )

    return result.rows[0] ? Number(result.rows[0].id) : null
  }
}

export function createAttestationsApiService(pool: Pool): AttestationsApiService {
  return new AttestationsApiService({ pool })
}
