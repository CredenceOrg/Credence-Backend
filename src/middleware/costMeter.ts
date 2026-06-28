import type { Request, Response, NextFunction } from 'express'
import type { Pool, PoolClient } from 'pg'
import { validateApiKey } from '../services/apiKeys.js'
import { outboxEmitter } from '../db/outbox/emitter.js'
import type { Queryable } from '../db/repositories/queryable.js'
import {
  creditsLowWebhookPayloadSchema,
  type CreditsLowWebhookPayload,
} from '../schemas/credits.js'
import { recordCreditsLowEvent } from '../observability/creditsMetrics.js'

// ── Public types ──────────────────────────────────────────────────────────────

export interface CostMeterConfig {
  costWeights: Record<string, number>
  defaultMonthlyCredits: number
  /** Global default low-credit webhook threshold when an org has no override. */
  defaultLowCreditThreshold: number
}

export interface DeductionInfo {
  orgId: string
  costWeight: number
  creditsBefore: number
  creditsAfter: number
  endpoint: string
  requestId: string
}

export interface CostMeterDeps {
  /** Override outbox emission (used in tests). */
  emitOutbox?: (db: Queryable, event: {
    aggregateType: string
    aggregateId: string
    eventType: string
    payload: Record<string, unknown>
  }) => Promise<bigint>
}

interface OrgCreditRow {
  credits_remaining: string
  version: number
  low_credit_threshold: string | null
  low_credit_alert_armed: boolean
}

// ── Internal helpers ──────────────────────────────────────────────────────────

const MAX_RETRIES = 3

function extractRawKey(req: Request): string | null {
  const auth = req.headers['authorization']
  if (auth?.startsWith('Bearer ')) return auth.slice(7)
  const header = req.headers['x-api-key']
  if (typeof header === 'string') return header
  return null
}

function extractOrgId(req: Request): string | undefined {
  const apiKeyRecord = (req as any).apiKeyRecord
  if (apiKeyRecord?.ownerId) return apiKeyRecord.ownerId

  const apiKey = (req as any).apiKey
  if (apiKey?.ownerId) return apiKey.ownerId

  const user = (req as any).user
  if (user?.tenantId) return user.tenantId

  const rawKey = extractRawKey(req)
  if (rawKey) {
    const key = validateApiKey(rawKey)
    if (key?.ownerId) return key.ownerId
  }

  return undefined
}

export function resolveCostWeight(path: string, costWeights: Record<string, number>): number {
  const exact = costWeights[path]
  if (exact !== undefined) return exact

  for (const [pattern, weight] of Object.entries(costWeights)) {
    if (pattern === 'default') continue
    const regex = new RegExp(
      '^' + pattern.replace(/:\w+/g, '([^/]+)').replace(/\//g, '\\/') + '(\\/.*)?$'
    )
    if (regex.test(path)) return weight
  }

  return costWeights['default'] ?? 1
}

/**
 * Returns true when credits cross from above the threshold to at/below it and the
 * one-shot alert is armed.
 */
export function shouldEmitLowCreditAlert(
  creditsBefore: number,
  creditsAfter: number,
  threshold: number,
  alertArmed: boolean,
): boolean {
  return alertArmed && creditsBefore > threshold && creditsAfter <= threshold
}

function resolveThreshold(
  orgThreshold: string | null | undefined,
  defaultLowCreditThreshold: number,
): number {
  if (orgThreshold != null) {
    return Number(orgThreshold)
  }
  return defaultLowCreditThreshold
}

async function enqueueLowCreditWebhook(
  client: PoolClient,
  emitOutbox: CostMeterDeps['emitOutbox'],
  orgId: string,
  payload: CreditsLowWebhookPayload,
): Promise<void> {
  const validated = creditsLowWebhookPayloadSchema.parse(payload)
  const emit = emitOutbox ?? ((db, event) => outboxEmitter.emit(db, event))
  await emit(client, {
    aggregateType: 'org',
    aggregateId: orgId,
    eventType: 'credits.low',
    payload: validated,
  })
  recordCreditsLowEvent()
}

async function maybeEmitLowCreditAlert(
  client: PoolClient,
  emitOutbox: CostMeterDeps['emitOutbox'],
  orgId: string,
  creditsBefore: number,
  creditsAfter: number,
  row: Pick<OrgCreditRow, 'low_credit_threshold' | 'low_credit_alert_armed'>,
  defaultLowCreditThreshold: number,
  endpoint: string,
  requestId: string,
): Promise<void> {
  const threshold = resolveThreshold(row.low_credit_threshold, defaultLowCreditThreshold)
  if (
    !shouldEmitLowCreditAlert(
      creditsBefore,
      creditsAfter,
      threshold,
      row.low_credit_alert_armed,
    )
  ) {
    return
  }

  await enqueueLowCreditWebhook(client, emitOutbox, orgId, {
    orgId,
    creditsRemaining: creditsAfter,
    threshold,
    endpoint,
    requestId,
  })

  await client.query(
    'UPDATE org_credits SET low_credit_alert_armed = false WHERE org_id = $1',
    [orgId],
  )
}

async function maybeRearmLowCreditAlert(
  client: PoolClient,
  orgId: string,
  creditsAfter: number,
  row: Pick<OrgCreditRow, 'low_credit_threshold'>,
  defaultLowCreditThreshold: number,
): Promise<void> {
  const threshold = resolveThreshold(row.low_credit_threshold, defaultLowCreditThreshold)
  if (creditsAfter > threshold) {
    await client.query(
      'UPDATE org_credits SET low_credit_alert_armed = true WHERE org_id = $1',
      [orgId],
    )
  }
}

async function deductCredits(
  pool: Pool,
  orgId: string,
  costWeight: number,
  endpoint: string,
  requestId: string,
  defaultMonthlyCredits: number,
  defaultLowCreditThreshold: number,
  emitOutbox: CostMeterDeps['emitOutbox'],
  retries = 0,
): Promise<
  | { ok: true; creditsBefore: number; creditsRemaining: number }
  | { ok: false; creditsRemaining: number; creditsDeficit: number }
> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const { rows } = await client.query<OrgCreditRow>(
      'SELECT credits_remaining, version, low_credit_threshold, low_credit_alert_armed FROM org_credits WHERE org_id = $1 FOR UPDATE',
      [orgId],
    )

    let creditsRemaining: number
    let version: number
    let alertRow: Pick<OrgCreditRow, 'low_credit_threshold' | 'low_credit_alert_armed'>

    if (rows.length === 0) {
      creditsRemaining = defaultMonthlyCredits
      version = 1
      alertRow = { low_credit_threshold: null, low_credit_alert_armed: true }
      await client.query(
        'INSERT INTO org_credits (org_id, credits_remaining, version, low_credit_alert_armed) VALUES ($1, $2, $3, true)',
        [orgId, creditsRemaining, version],
      )
    } else {
      creditsRemaining = Number(rows[0].credits_remaining)
      version = rows[0].version
      alertRow = {
        low_credit_threshold: rows[0].low_credit_threshold,
        low_credit_alert_armed: rows[0].low_credit_alert_armed ?? true,
      }
    }

    if (creditsRemaining < costWeight) {
      await client.query('ROLLBACK')
      return {
        ok: false,
        creditsRemaining,
        creditsDeficit: costWeight - creditsRemaining,
      }
    }

    const creditsBefore = creditsRemaining
    const newCreditsRemaining = creditsRemaining - costWeight
    const newVersion = version + 1

    const updateResult = await client.query(
      'UPDATE org_credits SET credits_remaining = $1, version = $2, updated_at = NOW() WHERE org_id = $3 AND version = $4',
      [newCreditsRemaining, newVersion, orgId, version],
    )

    if (updateResult.rowCount === 0) {
      await client.query('ROLLBACK')
      if (retries < MAX_RETRIES) {
        return deductCredits(
          pool,
          orgId,
          costWeight,
          endpoint,
          requestId,
          defaultMonthlyCredits,
          defaultLowCreditThreshold,
          emitOutbox,
          retries + 1,
        )
      }
      return { ok: false, creditsRemaining: 0, creditsDeficit: costWeight }
    }

    await client.query(
      `INSERT INTO credit_transactions (org_id, transaction_type, amount, credits_remaining_before, credits_remaining_after, endpoint, cost_weight, request_id)
       VALUES ($1, 'deduct', $2, $3, $4, $5, $6, $7)`,
      [orgId, costWeight, creditsBefore, newCreditsRemaining, endpoint, costWeight, requestId],
    )

    try {
      await maybeEmitLowCreditAlert(
        client,
        emitOutbox,
        orgId,
        creditsBefore,
        newCreditsRemaining,
        alertRow,
        defaultLowCreditThreshold,
        endpoint,
        requestId,
      )
    } catch (err) {
      console.error('[costMeter] Failed to enqueue credits.low webhook:', err)
    }

    await client.query('COMMIT')

    return {
      ok: true,
      creditsBefore,
      creditsRemaining: newCreditsRemaining,
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function refundCredits(
  pool: Pool,
  deduction: DeductionInfo,
  defaultLowCreditThreshold: number,
): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const { rows } = await client.query<OrgCreditRow>(
      'SELECT credits_remaining, version, low_credit_threshold, low_credit_alert_armed FROM org_credits WHERE org_id = $1 FOR UPDATE',
      [deduction.orgId],
    )

    if (rows.length === 0) {
      await client.query('ROLLBACK')
      return
    }

    const currentCredits = Number(rows[0].credits_remaining)
    const version = rows[0].version
    const refundedCredits = currentCredits + deduction.costWeight
    const newVersion = version + 1

    await client.query(
      'UPDATE org_credits SET credits_remaining = $1, version = $2, updated_at = NOW() WHERE org_id = $3 AND version = $4',
      [refundedCredits, newVersion, deduction.orgId, version],
    )

    await client.query(
      `INSERT INTO credit_transactions (org_id, transaction_type, amount, credits_remaining_before, credits_remaining_after, endpoint, cost_weight, request_id)
       VALUES ($1, 'refund', $2, $3, $4, $5, $6, $7)`,
      [
        deduction.orgId,
        deduction.costWeight,
        currentCredits,
        refundedCredits,
        deduction.endpoint,
        deduction.costWeight,
        deduction.requestId,
      ],
    )

    await maybeRearmLowCreditAlert(
      client,
      deduction.orgId,
      refundedCredits,
      rows[0],
      defaultLowCreditThreshold,
    )

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[costMeter] Refund failed:', err)
  } finally {
    client.release()
  }
}

// ── Middleware factory ─────────────────────────────────────────────────────────

export function createCostMeterMiddleware(
  config: CostMeterConfig,
  getPool: () => Pool,
  deps: CostMeterDeps = {},
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const orgId = extractOrgId(req)
    if (!orgId) {
      next()
      return
    }

    const costWeight = resolveCostWeight(req.path, config.costWeights)
    if (costWeight <= 0) {
      next()
      return
    }

    const requestId =
      (req as any).requestId ?? (req as any).correlationId ?? 'unknown'

    const pool = getPool()

    deductCredits(
      pool,
      orgId,
      costWeight,
      req.path,
      requestId,
      config.defaultMonthlyCredits,
      config.defaultLowCreditThreshold,
      deps.emitOutbox,
    )
      .then((result) => {
        if (!result.ok) {
          res.status(402).json({
            error: 'InsufficientCredits',
            message: `Monthly credit budget exhausted. Required: ${costWeight}, Remaining: ${result.creditsRemaining}`,
            creditsRequired: costWeight,
            creditsRemaining: result.creditsRemaining,
            creditsDeficit: result.creditsDeficit,
          })
          return
        }

        res.setHeader('X-Credits-Remaining', String(result.creditsRemaining))

        const deduction: DeductionInfo = {
          orgId,
          costWeight,
          creditsBefore: result.creditsBefore,
          creditsAfter: result.creditsRemaining,
          endpoint: req.path,
          requestId,
        }
        ;(req as any).__costMeterDeduction = deduction

        res.once('finish', () => {
          if (res.statusCode >= 500) {
            refundCredits(pool, deduction, config.defaultLowCreditThreshold)
          }
        })

        next()
      })
      .catch((err) => {
        next(err)
      })
  }
}
