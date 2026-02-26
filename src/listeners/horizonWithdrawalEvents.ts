import { Horizon, ServerApi } from '@stellar/stellar-sdk'

/**
 * Interface for bond withdrawal event data
 */
export interface WithdrawalEvent {
  id: string
  pagingToken: string
  type: string
  createdAt: Date
  bondId: string
  account: string
  amount: string
  assetType: string
  assetCode?: string
  assetIssuer?: string
  transactionHash: string
  operationIndex: number
}

/**
 * Interface for bond state updates
 */
export interface BondStateUpdate {
  bondId: string
  account: string
  previousAmount?: string
  newAmount: string
  isActive: boolean
  updatedAt: Date
  transactionHash: string
}

/**
 * Interface for score history snapshot
 */
export interface ScoreHistorySnapshot {
  address: string
  score: number
  bondedAmount: string
  timestamp: Date
  reason: 'withdrawal_full' | 'withdrawal_partial'
  transactionHash: string
}

/**
 * Configuration for the Horizon withdrawal listener
 */
export interface HorizonListenerConfig {
  horizonUrl: string
  networkPassphrase: string
  bondContractAddress?: string
  withdrawalAsset?: {
    code: string
    issuer: string
  }
  pollingInterval?: number // milliseconds
  lastCursor?: string
}

/**
 * Horizon listener for bond withdrawal events
 * 
 * Monitors Stellar Horizon for withdrawal transactions that affect bond states
 * and updates the local bond records accordingly.
 */
export class HorizonWithdrawalListener {
  private server: Horizon.Server
  private config: HorizonListenerConfig
  private isRunning = false
  private pollTimer?: NodeJS.Timeout
  private lastCursor: string

  constructor(config: HorizonListenerConfig) {
    this.config = config
    this.server = new Horizon.Server(config.horizonUrl)
    this.lastCursor = config.lastCursor || 'now'
  }

  /**
   * Start listening for withdrawal events
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      console.warn('Horizon withdrawal listener is already running')
      return
    }

    this.isRunning = true
    console.log(`Starting Horizon withdrawal listener for ${this.config.horizonUrl}`)

    // Start polling for events
    await this.pollForEvents()
  }

  /**
   * Stop listening for withdrawal events
   */
  public async stop(): Promise<void> {
    if (!this.isRunning) {
      return
    }

    this.isRunning = false
    
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = undefined
    }

    console.log('Stopped Horizon withdrawal listener')
  }

  /**
   * Check if the listener is currently running
   */
  public isActive(): boolean {
    return this.isRunning
  }

  /**
   * Get the current cursor position
   */
  public getCursor(): string {
    return this.lastCursor
  }

  /**
   * Set the cursor position for resuming from a specific point
   */
  public setCursor(cursor: string): void {
    this.lastCursor = cursor
  }

  /**
   * Poll for new withdrawal events from Horizon
   */
  private async pollForEvents(): Promise<void> {
    if (!this.isRunning) {
      return
    }

    try {
      const events = await this.fetchWithdrawalEvents()
      
      if (events.length > 0) {
        console.log(`Processing ${events.length} withdrawal events`)
        
        for (const event of events) {
          await this.processWithdrawalEvent(event)
        }
      }

      // Update cursor to the latest event
      if (events.length > 0) {
        this.lastCursor = events[events.length - 1].pagingToken
      }

    } catch (error) {
      console.error('Error polling for withdrawal events:', error)
    }

    // Schedule next poll
    if (this.isRunning) {
      this.pollTimer = setTimeout(
        () => this.pollForEvents(),
        this.config.pollingInterval || 5000
      )
    }
  }

  /**
   * Fetch withdrawal events from Horizon
   */
  private async fetchWithdrawalEvents(): Promise<WithdrawalEvent[]> {
    try {
      const operationsBuilder = this.server
        .operations()
        .order('asc')
        .limit(100)
        .cursor(this.lastCursor)

      // Filter for payment operations that represent withdrawals
      const response = await operationsBuilder.call()
      
      const withdrawalEvents: WithdrawalEvent[] = []

      for (const record of response.records) {
        if (this.isWithdrawalOperation(record)) {
          const event = this.parseWithdrawalEvent(record)
          if (event) {
            withdrawalEvents.push(event)
          }
        }
      }

      return withdrawalEvents
    } catch (error) {
      console.error('Error fetching withdrawal events from Horizon:', error)
      return []
    }
  }

  /**
   * Check if an operation represents a withdrawal
   */
  private isWithdrawalOperation(operation: ServerApi.OperationRecord): boolean {
    // Only process payment operations
    if (operation.type !== 'payment') {
      return false
    }

    const payment = operation as ServerApi.PaymentOperationRecord
    
    // Check if it's a withdrawal from bond contract or to specific account
    if (this.config.bondContractAddress) {
      // Withdrawal from bond contract (source is bond contract)
      return payment.source_account === this.config.bondContractAddress
    }

    // If no specific contract configured, treat all payments as potential withdrawals
    // In production, this should be more specific based on business logic
    return true
  }

  /**
   * Parse a withdrawal event from a Horizon operation record
   */
  private parseWithdrawalEvent(operation: ServerApi.OperationRecord): WithdrawalEvent | null {
    if (operation.type !== 'payment') {
      return null
    }

    const payment = operation as ServerApi.PaymentOperationRecord

    return {
      id: operation.id,
      pagingToken: operation.paging_token,
      type: operation.type,
      createdAt: new Date(operation.created_at),
      bondId: this.extractBondId(operation),
      account: payment.from || payment.source_account,
      amount: payment.amount,
      assetType: payment.asset_type,
      assetCode: payment.asset_code,
      assetIssuer: payment.asset_issuer,
      transactionHash: operation.transaction_hash || '',
      operationIndex: operation.id in operation ? parseInt(operation.id.split('-').pop() || '0') : 0
    }
  }

  /**
   * Extract bond ID from operation details
   * This would depend on how bond IDs are encoded in transactions
   */
  private extractBondId(operation: ServerApi.OperationRecord): string {
    // In a real implementation, this would extract the bond ID from:
    // 1. Memo field
    // 2. Transaction metadata
    // 3. Operation details
    // For now, use a combination of account and transaction hash
    const payment = operation as ServerApi.PaymentOperationRecord
    return `${payment.from || payment.source_account}-${operation.transaction_hash}`
  }

  /**
   * Process a single withdrawal event
   */
  private async processWithdrawalEvent(event: WithdrawalEvent): Promise<void> {
    try {
      console.log(`Processing withdrawal event: ${event.id}`)

      // Get current bond state
      const currentBond = await this.getBondState(event.bondId, event.account)
      
      if (!currentBond) {
        console.warn(`Bond not found for withdrawal event: ${event.bondId}`)
        return
      }

      // Calculate new bond state
      const bondUpdate = this.calculateBondUpdate(currentBond, event)
      
      // Update bond state
      await this.updateBondState(bondUpdate)
      
      // Create score history snapshot if needed
      if (this.shouldCreateScoreSnapshot(bondUpdate)) {
        const snapshot = await this.createScoreSnapshot(currentBond, event)
        await this.saveScoreSnapshot(snapshot)
      }

      console.log(`Updated bond ${event.bondId}: ${bondUpdate.newAmount} (active: ${bondUpdate.isActive})`)

    } catch (error) {
      console.error(`Error processing withdrawal event ${event.id}:`, error)
    }
  }

  /**
   * Get current bond state from database
   */
  private async getBondState(bondId: string, account: string): Promise<any> {
    // In a real implementation, this would query the database
    // For now, return mock data
    return {
      bondId,
      account,
      amount: '1000.0000000',
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date()
    }
  }

  /**
   * Calculate bond state update based on withdrawal event
   */
  private calculateBondUpdate(currentBond: any, event: WithdrawalEvent): BondStateUpdate {
    const currentAmount = parseFloat(currentBond.amount)
    const withdrawalAmount = parseFloat(event.amount)
    const newAmount = Math.max(0, currentAmount - withdrawalAmount).toString()
    const isActive = parseFloat(newAmount) > 0

    return {
      bondId: event.bondId,
      account: event.account,
      previousAmount: currentBond.amount,
      newAmount,
      isActive,
      updatedAt: new Date(),
      transactionHash: event.transactionHash
    }
  }

  /**
   * Update bond state in database
   */
  private async updateBondState(update: BondStateUpdate): Promise<void> {
    // In a real implementation, this would update the database
    console.log(`Updating bond state:`, JSON.stringify(update, null, 2))
    
    // Mock database update
    // await db.bonds.update({ bondId: update.bondId }, update)
  }

  /**
   * Determine if a score history snapshot should be created
   */
  private shouldCreateScoreSnapshot(update: BondStateUpdate): boolean {
    // Create snapshot for full withdrawals or significant partial withdrawals
    const previousAmount = parseFloat(update.previousAmount || '0')
    const newAmount = parseFloat(update.newAmount)
    const withdrawalRatio = (previousAmount - newAmount) / previousAmount
    
    return !update.isActive || withdrawalRatio >= 0.5 // 50% or more withdrawn
  }

  /**
   * Create score history snapshot
   */
  private async createScoreSnapshot(currentBond: any, event: WithdrawalEvent): Promise<ScoreHistorySnapshot> {
    // In a real implementation, this would calculate the current score
    const currentScore = await this.calculateTrustScore(currentBond.account)

    return {
      address: currentBond.account,
      score: currentScore,
      bondedAmount: currentBond.amount,
      timestamp: new Date(),
      reason: parseFloat(event.amount) >= parseFloat(currentBond.amount) ? 'withdrawal_full' : 'withdrawal_partial',
      transactionHash: event.transactionHash
    }
  }

  /**
   * Calculate trust score for an account
   */
  private async calculateTrustScore(address: string): Promise<number> {
    // In a real implementation, this would calculate the trust score
    // based on various factors including bond amount, history, etc.
    return 85 // Mock score
  }

  /**
   * Save score history snapshot to database
   */
  private async saveScoreSnapshot(snapshot: ScoreHistorySnapshot): Promise<void> {
    // In a real implementation, this would save to the database
    console.log(`Creating score history snapshot:`, JSON.stringify(snapshot, null, 2))
    
    // Mock database save
    // await db.scoreHistory.create(snapshot)
  }

  /**
   * Get listener statistics
   */
  public getStats(): {
    isRunning: boolean
    horizonUrl: string
    lastCursor: string
    pollingInterval: number
  } {
    return {
      isRunning: this.isRunning,
      horizonUrl: this.config.horizonUrl,
      lastCursor: this.lastCursor,
      pollingInterval: this.config.pollingInterval || 5000
    }
  }
}

/**
 * Factory function to create a configured Horizon withdrawal listener
 */
export function createHorizonWithdrawalListener(config: Partial<HorizonListenerConfig> = {}): HorizonWithdrawalListener {
  const defaultConfig: HorizonListenerConfig = {
    horizonUrl: process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org',
    networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',
    pollingInterval: 5000,
    lastCursor: 'now'
  }

  return new HorizonWithdrawalListener({ ...defaultConfig, ...config })
}

// Export singleton instance for convenience
export const horizonWithdrawalListener = createHorizonWithdrawalListener()
