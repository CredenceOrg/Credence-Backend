import { getDbPool } from '../db.js'

export interface BondStatus {
  address: string
  bondedAmount: string
  bondStart: string | null
  bondDuration: number | null
  active: boolean
}

export class BondService {
  async getBondStatus(address: string): Promise<BondStatus | null> {
    const pool = getDbPool()
    const result = await pool.query(
      'SELECT address, bonded_amount, bond_start, bond_duration, active FROM identities WHERE address = $1',
      [address.toLowerCase()]
    )

    if (result.rows.length === 0) {
      return null
    }

    const record = result.rows[0]

    return {
      address: record.address,
      bondedAmount: record.bonded_amount,
      bondStart: record.bond_start ? new Date(record.bond_start * 1000).toISOString() : null,
      bondDuration: record.bond_duration,
      active: record.active,
    }
  }
}