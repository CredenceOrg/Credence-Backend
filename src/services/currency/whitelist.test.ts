import { describe, expect, it } from 'vitest'
import fc from 'fast-check'

import {
  CurrencyWhitelist,
  normalize_currency_code,
  type AdminContext,
} from './whitelist.js'

const adminCtx: AdminContext = {
  userId: 'admin-1',
  role: 'admin',
}

const snapshotValues = (whitelist: CurrencyWhitelist) =>
  [...whitelist.snapshot()].sort()

describe('normalize_currency_code', () => {
  it('normalizes case and surrounding whitespace', () => {
    expect(normalize_currency_code(' usd ')).toBe('USD')
    expect(normalize_currency_code('\tEur\n')).toBe('EUR')
  })

  it('rejects malformed currency codes', () => {
    for (const value of [
      '',
      '  ',
      'US',
      'USDD',
      'U5D',
      'US-D',
      '\u20acUR',
      '\uff35\uff33\uff24',
    ]) {
      expect(() => normalize_currency_code(value)).toThrow(TypeError)
    }
  })

  it('is idempotent for normalized valid codes', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'),
          fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'),
          fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'),
        ),
        (chars) => {
          const code = chars.join('')

          expect(normalize_currency_code(normalize_currency_code(code))).toBe(
            normalize_currency_code(code),
          )
        },
      ),
    )
  })
})

describe('CurrencyWhitelist', () => {
  it('starts empty by default and supports populated lookup behavior', () => {
    const empty = new CurrencyWhitelist()
    const populated = new CurrencyWhitelist([' usd ', 'eur'])

    expect(empty.size).toBe(0)
    expect(empty.is_allowed_currency('USD')).toBe(false)
    expect(populated.size).toBe(2)
    expect(populated.is_allowed_currency('USD')).toBe(true)
    expect(populated.is_allowed_currency(' eur ')).toBe(true)
    expect(populated.is_allowed_currency('GBP')).toBe(false)
  })

  it('adds currencies after normalization and returns an isolated snapshot', () => {
    const whitelist = new CurrencyWhitelist()

    const result = whitelist.add_currency(' usd ', adminCtx)
    const returnedSnapshot = result.currencies as Set<string>
    returnedSnapshot.add('EUR')

    expect(result.description).toBe('add_currency(USD): added')
    expect(whitelist.is_allowed_currency('USD')).toBe(true)
    expect(whitelist.is_allowed_currency('EUR')).toBe(false)
  })

  it('keeps adding an existing entry idempotent', () => {
    const whitelist = new CurrencyWhitelist(['USD'])

    const result = whitelist.add_currency(' usd ', adminCtx)

    expect(result.description).toContain('already present')
    expect(snapshotValues(whitelist)).toEqual(['USD'])
  })

  it('removes currencies after normalization and treats missing entries as no-ops', () => {
    const whitelist = new CurrencyWhitelist(['USD', 'EUR'])

    expect(whitelist.remove_currency(' usd ', adminCtx).description).toBe(
      'remove_currency(USD): removed',
    )
    expect(whitelist.remove_currency('gbp', adminCtx).description).toContain(
      'not present',
    )
    expect(snapshotValues(whitelist)).toEqual(['EUR'])
  })

  it('clears currencies idempotently', () => {
    const whitelist = new CurrencyWhitelist(['USD', 'EUR'])

    expect(whitelist.clear_currencies(adminCtx).description).toBe(
      'clear_currencies(): whitelist cleared',
    )
    expect(whitelist.size).toBe(0)
    expect(whitelist.clear_currencies(adminCtx).currencies.size).toBe(0)
  })

  it('rejects malformed codes for constructor, reads, and mutations', () => {
    expect(() => new CurrencyWhitelist(['usd', 'USDD'])).toThrow(TypeError)

    const whitelist = new CurrencyWhitelist(['USD'])

    expect(() => whitelist.is_allowed_currency('USDD')).toThrow(TypeError)
    expect(() => whitelist.add_currency('12$', adminCtx)).toThrow(TypeError)
    expect(() => whitelist.remove_currency('\u20acUR', adminCtx)).toThrow(TypeError)
    expect(() => whitelist.set_currencies(['USD', 'EURO'], adminCtx)).toThrow(
      TypeError,
    )
    expect(snapshotValues(whitelist)).toEqual(['USD'])
  })

  it('allows super-admin mutations but rejects missing or non-admin contexts', () => {
    const whitelist = new CurrencyWhitelist()

    expect(() => whitelist.add_currency('USD', undefined as unknown as AdminContext))
      .toThrow(/Admin context is required/)
    expect(() =>
      whitelist.add_currency('USD', { userId: 'user-1', role: 'viewer' }),
    ).toThrow(/not permitted/)

    whitelist.add_currency('USD', { userId: 'super-1', role: 'super-admin' })

    expect(whitelist.is_allowed_currency('usd')).toBe(true)
  })

  it('sets currencies in an order-insensitive way after normalization', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('usd', ' EUR ', 'gbp', 'Cad'), {
          minLength: 1,
          maxLength: 20,
        }),
        (codes) => {
          const forward = new CurrencyWhitelist()
          const reverse = new CurrencyWhitelist()

          forward.set_currencies(codes, adminCtx)
          reverse.set_currencies([...codes].reverse(), adminCtx)

          expect(snapshotValues(forward)).toEqual(snapshotValues(reverse))
        },
      ),
    )
  })
})
