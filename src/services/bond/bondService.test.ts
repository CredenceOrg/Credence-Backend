import { describe, it, expect, beforeEach } from 'vitest'
import { BondStore } from './bondStore.js'
import { BondService } from './bondService.js'
import type { BondRecord } from './types.js'

describe('BondStore', () => {
  let store: BondStore

  beforeEach(() => {
    store = new BondStore()
  })

  it('should return null for an unknown address', () => {
    expect(store.get('0x0000000000000000000000000000000000000001')).toBeNull()
  })

  it('should store and retrieve a bond record', () => {
    const record: BondRecord = {
      address: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
      bondedAmount: '1000000000000000000',
      bondStart: '2024-01-15T00:00:00.000Z',
      bondDuration: 31536000,
      active: true,
      slashedAmount: '0',
    }
    store.set(record)
    const result = store.get(record.address)
    expect(result).not.toBeNull()
    expect(result!.bondedAmount).toBe('1000000000000000000')
    expect(result!.address).toBe(record.address.toLowerCase())
  })

  it('should normalise address to lower-case on get', () => {
    const record: BondRecord = {
      address: '0xabcdef1234567890abcdef1234567890abcdef12',
      bondedAmount: '500',
      bondStart: null,
      bondDuration: null,
      active: false,
      slashedAmount: '0',
    }
    store.set(record)
    expect(
      store.get('0xABCDEF1234567890ABCDEF1234567890ABCDEF12')
    ).not.toBeNull()
  })

  it('should overwrite an existing record (upsert)', () => {
    const addr = '0xabcdef1234567890abcdef1234567890abcdef12'
    store.set({
      address: addr,
      bondedAmount: '100',
      bondStart: null,
      bondDuration: null,
      active: false,
      slashedAmount: '0',
    })
    store.set({
      address: addr,
      bondedAmount: '999',
      bondStart: '2025-01-01T00:00:00.000Z',
      bondDuration: 100,
      active: true,
      slashedAmount: '50',
    })
    const result = store.get(addr)
    expect(result!.bondedAmount).toBe('999')
    expect(result!.active).toBe(true)
  })

  it('should return all stored records', () => {
    store.set({
      address: '0x0000000000000000000000000000000000000001',
      bondedAmount: '1',
      bondStart: null,
      bondDuration: null,
      active: false,
      slashedAmount: '0',
    })
    store.set({
      address: '0x0000000000000000000000000000000000000002',
      bondedAmount: '2',
      bondStart: null,
      bondDuration: null,
      active: false,
      slashedAmount: '0',
    })
    expect(store.getAll()).toHaveLength(2)
  })

  it('should delete a record by address', () => {
    const addr = '0x0000000000000000000000000000000000000001'
    store.set({
      address: addr,
      bondedAmount: '1',
      bondStart: null,
      bondDuration: null,
      active: false,
      slashedAmount: '0',
    })
    expect(store.delete(addr)).toBe(true)
    expect(store.get(addr)).toBeNull()
  })

  it('should return false when deleting a non-existent record', () => {
    expect(
      store.delete('0x0000000000000000000000000000000000000099')
    ).toBe(false)
  })
})

describe('BondService', () => {
  let store: BondStore
  let service: BondService

  beforeEach(() => {
    store = new BondStore()
    service = new BondService(store)
  })

  describe('isValidAddress', () => {
    it('should accept a valid lower-case Ethereum address', () => {
      expect(
        service.isValidAddress('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266')
      ).toBe(true)
    })

    it('should accept a valid checksummed Ethereum address', () => {
      expect(
        service.isValidAddress('0xABCDEF1234567890abcdef1234567890ABCDEF12')
      ).toBe(true)
    })

    it('should reject an address without 0x prefix', () => {
      expect(
        service.isValidAddress('f39fd6e51aad88f6f4ce6ab8827279cfffb92266')
      ).toBe(false)
    })

    it('should reject an address that is too short', () => {
      expect(service.isValidAddress('0x1234')).toBe(false)
    })

    it('should reject an address that is too long', () => {
      expect(
        service.isValidAddress(
          '0xf39fd6e51aad88f6f4ce6ab8827279cfffb922660000'
        )
      ).toBe(false)
    })

    it('should reject a non-hex address', () => {
      expect(
        service.isValidAddress('0xZZZZZZ0000000000000000000000000000000000')
      ).toBe(false)
    })

    it('should reject an empty string', () => {
      expect(service.isValidAddress('')).toBe(false)
    })

    it('should reject a plain text string', () => {
      expect(service.isValidAddress('not-an-address')).toBe(false)
    })
  })

  describe('getBondStatus', () => {
    it('should return null when no bond record exists', () => {
      expect(
        service.getBondStatus('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266')
      ).toBeNull()
    })

    it('should return a bond record when one exists', () => {
      store.set({
        address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
        bondedAmount: '1000000000000000000',
        bondStart: '2024-01-15T00:00:00.000Z',
        bondDuration: 31536000,
        active: true,
        slashedAmount: '0',
      })
      const result = service.getBondStatus(
        '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
      )
      expect(result).not.toBeNull()
      expect(result!.active).toBe(true)
      expect(result!.bondedAmount).toBe('1000000000000000000')
    })

    it('should be case-insensitive', () => {
      store.set({
        address: '0xabcdef1234567890abcdef1234567890abcdef12',
        bondedAmount: '500',
        bondStart: null,
        bondDuration: null,
        active: false,
        slashedAmount: '0',
      })
      expect(
        service.getBondStatus(
          '0xABCDEF1234567890ABCDEF1234567890ABCDEF12'
        )
      ).not.toBeNull()
    })

    it('should return slashed bond data', () => {
      store.set({
        address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
        bondedAmount: '500000000000000000',
        bondStart: '2024-01-15T00:00:00.000Z',
        bondDuration: 31536000,
        active: true,
        slashedAmount: '200000000000000000',
      })
      const result = service.getBondStatus(
        '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
      )
      expect(result!.slashedAmount).toBe('200000000000000000')
    })
  })
})
