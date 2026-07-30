import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import {
  isPaymentStatus,
  resolvePaymentStatus,
  deriveBondPaymentStatus,
  PAYMENT_STATUS_ALIASES,
  type PaymentStatus,
} from './paymentStatus.js'
import { createBondRouter } from '../../routes/bond.js'
import { BondStore, BondService } from './index.js'
import type { BondRecord } from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bond(overrides: Partial<BondRecord> = {}): BondRecord {
  return {
    address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
    bondedAmount: '1000000000000000000',
    bondStart: '2024-01-15T00:00:00.000Z',
    bondDuration: 31536000,
    active: true,
    slashedAmount: '0',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// isPaymentStatus
// ---------------------------------------------------------------------------

describe('isPaymentStatus', () => {
  it.each(['active', 'slashed', 'inactive', 'unbonded'] as PaymentStatus[])(
    'returns true for canonical value "%s"',
    (status) => {
      expect(isPaymentStatus(status)).toBe(true)
    }
  )

  it.each(['bonded', 'withdrawn', 'active_slashed', 'ACTIVE', '', 'unknown'])(
    'returns false for non-canonical value "%s"',
    (status) => {
      expect(isPaymentStatus(status)).toBe(false)
    }
  )
})

// ---------------------------------------------------------------------------
// resolvePaymentStatus — canonical pass-through
// ---------------------------------------------------------------------------

describe('resolvePaymentStatus — canonical values', () => {
  it.each(['active', 'slashed', 'inactive', 'unbonded'] as PaymentStatus[])(
    'returns "%s" unchanged',
    (status) => {
      expect(resolvePaymentStatus(status)).toBe(status)
    }
  )
})

// ---------------------------------------------------------------------------
// resolvePaymentStatus — legacy alias compatibility
// ---------------------------------------------------------------------------

describe('resolvePaymentStatus — legacy alias compatibility', () => {
  it('resolves "bonded" → "active"', () => {
    expect(resolvePaymentStatus('bonded')).toBe('active')
  })

  it('resolves "active_slashed" → "slashed"', () => {
    expect(resolvePaymentStatus('active_slashed')).toBe('slashed')
  })

  it('resolves "withdrawn" → "inactive"', () => {
    expect(resolvePaymentStatus('withdrawn')).toBe('inactive')
  })

  it('returns null for completely unknown status', () => {
    expect(resolvePaymentStatus('PENDING')).toBeNull()
    expect(resolvePaymentStatus('')).toBeNull()
    expect(resolvePaymentStatus('complete')).toBeNull()
  })

  it('alias table covers all documented legacy values', () => {
    const documented = ['bonded', 'active_slashed', 'withdrawn']
    for (const alias of documented) {
      expect(resolvePaymentStatus(alias)).not.toBeNull()
    }
  })

  it('every alias target is a canonical PaymentStatus', () => {
    for (const [alias, target] of Object.entries(PAYMENT_STATUS_ALIASES)) {
      expect(isPaymentStatus(target)).toBe(true)
      expect(resolvePaymentStatus(alias)).toBe(target)
    }
  })
})

// ---------------------------------------------------------------------------
// deriveBondPaymentStatus — all enum values
// ---------------------------------------------------------------------------

describe('deriveBondPaymentStatus', () => {
  it('returns "active" for an active bond with no slashing', () => {
    expect(deriveBondPaymentStatus(bond())).toBe('active')
  })

  it('returns "active" for an active bond with slashedAmount explicitly "0"', () => {
    expect(deriveBondPaymentStatus(bond({ slashedAmount: '0' }))).toBe('active')
  })

  it('returns "slashed" for an active bond with any positive slashedAmount', () => {
    expect(deriveBondPaymentStatus(bond({ slashedAmount: '1' }))).toBe('slashed')
    expect(deriveBondPaymentStatus(bond({ slashedAmount: '200000000000000000' }))).toBe('slashed')
  })

  it('returns "inactive" for a bond that has been withdrawn (active=false, had a bondStart)', () => {
    expect(
      deriveBondPaymentStatus(
        bond({ active: false, bondStart: '2024-01-15T00:00:00.000Z', bondedAmount: '1000000000000000000' })
      )
    ).toBe('inactive')
  })

  it('returns "inactive" for a withdrawn bond that was also slashed', () => {
    expect(
      deriveBondPaymentStatus(
        bond({ active: false, slashedAmount: '200000000000000000' })
      )
    ).toBe('inactive')
  })

  it('returns "unbonded" for a record that was never bonded', () => {
    expect(
      deriveBondPaymentStatus({
        address: '0x0000000000000000000000000000000000000001',
        bondedAmount: '0',
        bondStart: null,
        bondDuration: null,
        active: false,
        slashedAmount: '0',
      })
    ).toBe('unbonded')
  })

  it('treats malformed slashedAmount as unslashed (no throw)', () => {
    expect(deriveBondPaymentStatus(bond({ slashedAmount: 'not-a-number' }))).toBe('active')
  })

  it('covers every canonical PaymentStatus exactly once', () => {
    const cases: Array<[Partial<BondRecord>, PaymentStatus]> = [
      [{ active: true, slashedAmount: '0', bondStart: '2024-01-01T00:00:00.000Z' }, 'active'],
      [{ active: true, slashedAmount: '1' }, 'slashed'],
      [{ active: false, bondStart: '2024-01-01T00:00:00.000Z', bondedAmount: '1' }, 'inactive'],
      [{ active: false, bondStart: null, bondedAmount: '0' }, 'unbonded'],
    ]
    const seen = new Set<PaymentStatus>()
    for (const [overrides, expected] of cases) {
      const result = deriveBondPaymentStatus(bond(overrides))
      expect(result).toBe(expected)
      seen.add(result)
    }
    expect(seen.size).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// Bond route integration — status field in API response
// ---------------------------------------------------------------------------

describe('GET /api/bond/:address — status serialization', () => {
  function createApp() {
    const store = new BondStore()
    const service = new BondService(store)
    const app = express()
    app.use('/api/bond', createBondRouter(service))
    return { app, store }
  }

  it('includes status "active" for an active unslashed bond', async () => {
    const { app, store } = createApp()
    store.set(bond())

    const res = await request(app).get(
      '/api/bond/0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
    )

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('active')
  })

  it('includes status "slashed" for an active bond with slashedAmount > 0', async () => {
    const { app, store } = createApp()
    store.set(bond({ slashedAmount: '200000000000000000' }))

    const res = await request(app).get(
      '/api/bond/0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
    )

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('slashed')
  })

  it('includes status "inactive" for a withdrawn bond', async () => {
    const { app, store } = createApp()
    store.set(
      bond({ active: false, bondStart: '2024-01-15T00:00:00.000Z', bondedAmount: '500000000000000000' })
    )

    const res = await request(app).get(
      '/api/bond/0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
    )

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('inactive')
  })

  it('includes status "unbonded" for a never-bonded record', async () => {
    const { app, store } = createApp()
    store.set({
      address: '0x0000000000000000000000000000000000000001',
      bondedAmount: '0',
      bondStart: null,
      bondDuration: null,
      active: false,
      slashedAmount: '0',
    })

    const res = await request(app).get(
      '/api/bond/0x0000000000000000000000000000000000000001'
    )

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('unbonded')
  })

  it('still returns the deprecated "active" boolean for backward compatibility', async () => {
    const { app, store } = createApp()
    store.set(bond())

    const res = await request(app).get(
      '/api/bond/0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
    )

    expect(res.status).toBe(200)
    expect(res.body.active).toBe(true) // backward-compat field preserved
    expect(res.body.status).toBe('active') // canonical field added
  })

  it('response status field is consistent with active boolean across all cases', async () => {
    const cases: Array<[Partial<BondRecord>, PaymentStatus, boolean]> = [
      [{ active: true, slashedAmount: '0' }, 'active', true],
      [{ active: true, slashedAmount: '1' }, 'slashed', true],
      [{ active: false, bondedAmount: '500000000000000000' }, 'inactive', false],
      [{ active: false, bondedAmount: '0', bondStart: null }, 'unbonded', false],
    ]

    for (const [overrides, expectedStatus, expectedActive] of cases) {
      const { app, store } = createApp()
      store.set(bond(overrides))

      const res = await request(app).get(
        '/api/bond/0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
      )

      expect(res.body.status).toBe(expectedStatus)
      expect(res.body.active).toBe(expectedActive)
    }
  })
})
