import { Request, Response, NextFunction } from 'express'
import { Pool } from 'pg'
import { pool as defaultPool } from '../db/pool.js'
import { logger } from '../utils/logger.js'

export interface CostMeterConfig {
  defaultCostWeight?: number
  costWeights?: Record<string, number>
  maxRetries?: number
}

export interface OrgCredits {
  orgId: string
  balance: number
  version: number
  updatedAt: Date
}

const DEFAULT_COST_WEIGHT = 1
const DEFAULT_MAX_RETRIES = 3
const INITIAL_CREDIT_BALANCE = 10000

let costConfig: CostMeterConfig = {
  defaultCostWeight: DEFAULT_COST_WEIGHT,
  costWeights: {},
  maxRetries: DEFAULT_MAX_RETRIES,
}

let dbPool: Pool = defaultPool

export function configureCostMeter(config: Partial<CostMeterConfig>): void {
  costConfig = { ...costConfig, ...config }
}

export function setDbPool(newPool: Pool): void {
  dbPool = newPool
}

export async function initializeCreditTable(): Promise<void> {
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS org_credits (
        org_id TEXT PRIMARY KEY,
        balance BIGINT NOT NULL DEFAULT ${INITIAL_CREDIT_BALANCE},
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `)
  } catch (error) {
    logger.error('Failed to initialize credit table', error)
    throw error
  }
}

export async function deductCredits(
  orgId: string,
  cost: number,
  maxRetries: number = costConfig.maxRetries ?? DEFAULT_MAX_RETRIES,
): Promise<void> {
  if (cost <= 0) {
    throw new Error('Cost must be positive')
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const client = await dbPool.connect()
    try {
      await client.query('BEGIN')

      const row = await client.query<OrgCredits>(
        'SELECT org_id, balance, version, updated_at FROM org_credits WHERE org_id = $1 FOR UPDATE',
        [orgId],
      )

      let balance: number
      let version: number

      if (row.rows.length === 0) {
        await client.query(
          `INSERT INTO org_credits (org_id, balance, version) VALUES ($1, $2, $3)
           ON CONFLICT (org_id) DO UPDATE SET version = version + 1`,
          [orgId, INITIAL_CREDIT_BALANCE - cost, 1],
        )
        balance = INITIAL_CREDIT_BALANCE - cost
        version = 1
      } else {
        const current = row.rows[0]
        if (current.balance < cost) {
          await client.query('ROLLBACK')
          throw new Error(`Insufficient credits: ${current.balance} < ${cost}`)
        }

        balance = current.balance - cost
        version = current.version + 1

        const updateResult = await client.query(
          `UPDATE org_credits
           SET balance = $1, version = $2, updated_at = NOW()
           WHERE org_id = $3 AND version = $4
           RETURNING balance, version`,
          [balance, version, orgId, current.version],
        )

        if (updateResult.rows.length === 0) {
          await client.query('ROLLBACK')
          if (attempt < maxRetries) {
            continue
          }
          throw new Error(`Version conflict after ${maxRetries} retries`)
        }
      }

      await client.query('COMMIT')
      logger.info({ action: 'credits_deducted', orgId, cost, newBalance: balance })
      return
    } catch (error) {
      await client.query('ROLLBACK')

      if (error instanceof Error && error.message.includes('Insufficient credits')) {
        throw error
      }

      if (attempt === maxRetries) {
        logger.error(`Failed to deduct credits after ${maxRetries} retries`, error)
        throw error
      }
    } finally {
      client.release()
    }
  }
}

export async function refundCredits(orgId: string, cost: number): Promise<void> {
  const client = await dbPool.connect()
  try {
    await client.query('BEGIN')

    const row = await client.query<OrgCredits>(
      'SELECT balance, version FROM org_credits WHERE org_id = $1 FOR UPDATE',
      [orgId],
    )

    if (row.rows.length === 0) {
      await client.query('ROLLBACK')
      logger.warn({ action: 'refund_skipped', orgId, cost, reason: 'org_not_found' })
      return
    }

    const current = row.rows[0]
    const newBalance = current.balance + cost
    const newVersion = current.version + 1

    await client.query(
      `UPDATE org_credits
       SET balance = $1, version = $2, updated_at = NOW()
       WHERE org_id = $3`,
      [newBalance, newVersion, orgId],
    )

    await client.query('COMMIT')
    logger.info({ action: 'credits_refunded', orgId, cost, newBalance })
  } catch (error) {
    await client.query('ROLLBACK')
    logger.error(`Failed to refund credits for org ${orgId}`, error)
    throw error
  } finally {
    client.release()
  }
}

export function resolveCostWeight(routePath: string): number {
  if (costConfig.costWeights && costConfig.costWeights[routePath]) {
    return costConfig.costWeights[routePath]
  }
  return costConfig.defaultCostWeight ?? DEFAULT_COST_WEIGHT
}

export function costMeterMiddleware(
  req: Request & { orgId?: string },
  res: Response,
  next: NextFunction,
): void {
  const originalSend = res.send

  res.send = function (data: any) {
    const statusCode = res.statusCode
    const cost = resolveCostWeight(req.route?.path ?? req.path)

    if (statusCode >= 500 && req.orgId) {
      refundCredits(req.orgId, cost).catch((error) => {
        logger.error(`Refund failed for org ${req.orgId}`, error)
      })
    }

    return originalSend.call(this, data)
  }

  next()
}
