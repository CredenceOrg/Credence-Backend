import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock Stellar SDK before importing the module
vi.mock('@stellar/stellar-sdk', () => {
  const mockServer = {
    operations: vi.fn().mockReturnValue({
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      cursor: vi.fn().mockReturnThis(),
      call: vi.fn()
    })
  }

  return {
    Horizon: {
      Server: class MockServer {
        constructor(url: string) {
          return mockServer
        }
      }
    }
  }
})

// Import after mocking
import { HorizonWithdrawalListener, createHorizonWithdrawalListener } from '../horizonWithdrawalEvents.js'

describe('HorizonWithdrawalListener', () => {
  let listener: HorizonWithdrawalListener

  beforeEach(() => {
    vi.clearAllMocks()
    
    // Create listener with test configuration
    listener = createHorizonWithdrawalListener({
      horizonUrl: 'https://horizon-testnet.stellar.org',
      pollingInterval: 100, // Short interval for tests
      lastCursor: 'now'
    })
  })

  afterEach(async () => {
    await listener.stop()
  })

  describe('constructor', () => {
    it('creates listener with default configuration', () => {
      const defaultListener = createHorizonWithdrawalListener()
      expect(defaultListener).toBeInstanceOf(HorizonWithdrawalListener)
    })

    it('creates listener with custom configuration', () => {
      const customConfig = {
        horizonUrl: 'https://custom-horizon.example.com',
        pollingInterval: 10000,
        bondContractAddress: 'GABCD...'
      }
      const customListener = createHorizonWithdrawalListener(customConfig)
      expect(customListener).toBeInstanceOf(HorizonWithdrawalListener)
    })
  })

  describe('start and stop', () => {
    it('starts the listener', async () => {
      await listener.start()
      
      expect(listener.isActive()).toBe(true)
    })

    it('stops the listener', async () => {
      await listener.start()
      await listener.stop()
      
      expect(listener.isActive()).toBe(false)
    })
  })

  describe('cursor management', () => {
    it('gets and sets cursor', () => {
      expect(listener.getCursor()).toBe('now')
      
      listener.setCursor('123456789')
      expect(listener.getCursor()).toBe('123456789')
    })
  })

  describe('bond state calculation', () => {
    it('calculates partial withdrawal correctly', () => {
      const currentBond = {
        bondId: 'bond-123',
        account: 'GABC...',
        amount: '1000.0000000',
        isActive: true
      }

      const event = {
        id: 'op-123',
        pagingToken: '123456',
        type: 'payment',
        createdAt: new Date(),
        bondId: 'bond-123',
        account: 'GABC...',
        amount: '300.0000000',
        assetType: 'native',
        transactionHash: 'tx-123',
        operationIndex: 0
      }

      const update = (listener as any).calculateBondUpdate(currentBond, event)

      expect(update.newAmount).toBe('700')
      expect(update.isActive).toBe(true)
      expect(update.previousAmount).toBe('1000.0000000')
    })

    it('calculates full withdrawal correctly', () => {
      const currentBond = {
        bondId: 'bond-123',
        account: 'GABC...',
        amount: '1000.0000000',
        isActive: true
      }

      const event = {
        id: 'op-123',
        pagingToken: '123456',
        type: 'payment',
        createdAt: new Date(),
        bondId: 'bond-123',
        account: 'GABC...',
        amount: '1000.0000000',
        assetType: 'native',
        transactionHash: 'tx-123',
        operationIndex: 0
      }

      const update = (listener as any).calculateBondUpdate(currentBond, event)

      expect(update.newAmount).toBe('0')
      expect(update.isActive).toBe(false)
      expect(update.previousAmount).toBe('1000.0000000')
    })

    it('prevents negative amounts', () => {
      const currentBond = {
        bondId: 'bond-123',
        account: 'GABC...',
        amount: '500.0000000',
        isActive: true
      }

      const event = {
        id: 'op-123',
        pagingToken: '123456',
        type: 'payment',
        createdAt: new Date(),
        bondId: 'bond-123',
        account: 'GABC...',
        amount: '1000.0000000', // More than current amount
        assetType: 'native',
        transactionHash: 'tx-123',
        operationIndex: 0
      }

      const update = (listener as any).calculateBondUpdate(currentBond, event)

      expect(update.newAmount).toBe('0') // Should not go negative
      expect(update.isActive).toBe(false)
    })
  })

  describe('score snapshot logic', () => {
    it('creates snapshot for full withdrawal', () => {
      const update = {
        bondId: 'bond-123',
        account: 'GABC...',
        previousAmount: '1000.0000000',
        newAmount: '0',
        isActive: false,
        updatedAt: new Date(),
        transactionHash: 'tx-123'
      }

      const shouldCreate = (listener as any).shouldCreateScoreSnapshot(update)
      expect(shouldCreate).toBe(true)
    })

    it('creates snapshot for large partial withdrawal (>=50%)', () => {
      const update = {
        bondId: 'bond-123',
        account: 'GABC...',
        previousAmount: '1000.0000000',
        newAmount: '400.0000000', // 60% withdrawn
        isActive: true,
        updatedAt: new Date(),
        transactionHash: 'tx-123'
      }

      const shouldCreate = (listener as any).shouldCreateScoreSnapshot(update)
      expect(shouldCreate).toBe(true)
    })

    it('does not create snapshot for small partial withdrawal (<50%)', () => {
      const update = {
        bondId: 'bond-123',
        account: 'GABC...',
        previousAmount: '1000.0000000',
        newAmount: '600.0000000', // 40% withdrawn
        isActive: true,
        updatedAt: new Date(),
        transactionHash: 'tx-123'
      }

      const shouldCreate = (listener as any).shouldCreateScoreSnapshot(update)
      expect(shouldCreate).toBe(false)
    })
  })

  describe('stats', () => {
    it('returns listener statistics', () => {
      const stats = listener.getStats()

      expect(stats).toEqual({
        isRunning: false,
        horizonUrl: 'https://horizon-testnet.stellar.org',
        lastCursor: 'now',
        pollingInterval: 100
      })
    })
  })
})
