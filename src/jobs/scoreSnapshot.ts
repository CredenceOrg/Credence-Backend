import type {
  IdentityDataSource,
  ScoreSnapshotStore,
  ScoreComputer,
  SnapshotJobResult,
  ScoreSnapshot,
} from './types.js'

/**
 * Options for score snapshot job.
 */
export interface SnapshotJobOptions {
  /** Batch size for processing identities (default: 100). */
  batchSize?: number
  /** Whether to continue on errors (default: true). */
  continueOnError?: boolean
  /** Logger function for progress/errors. */
  logger?: (message: string) => void
}

/**
 * Score snapshot job: computes and persists score snapshots for all active identities.
 * 
 * Features:
 * - Batch processing for large datasets
 * - Error handling with optional continue-on-error
 * - Progress logging
 * - Performance metrics
 * 
 * @example
 * ```typescript
 * const job = new ScoreSnapshotJob(dataSource, store, computeScore)
 * const result = await job.run()
 * console.log(`Processed ${result.processed} identities in ${result.duration}ms`)
 * ```
 */
export class ScoreSnapshotJob {
  private readonly batchSize: number
  private readonly continueOnError: boolean
  private readonly logger: (message: string) => void

  constructor(
    private readonly dataSource: IdentityDataSource,
    private readonly store: ScoreSnapshotStore,
    private readonly scoreComputer: ScoreComputer,
    options: SnapshotJobOptions = {}
  ) {
    this.batchSize = options.batchSize ?? 100
    this.continueOnError = options.continueOnError ?? true
    this.logger = options.logger ?? (() => {})
  }

  /**
   * Run the snapshot job.
   * 
   * @returns Job execution result with metrics
   */
  async run(): Promise<SnapshotJobResult> {
    const startTime = new Date().toISOString()
    const startMs = Date.now()

    this.logger('Starting score snapshot job')

    let processed = 0
    let saved = 0
    let errors = 0

    try {
      const addresses = await this.dataSource.getActiveAddresses()
      this.logger(`Found ${addresses.length} active identities`)

      // Process in batches
      for (let i = 0; i < addresses.length; i += this.batchSize) {
        const batch = addresses.slice(i, i + this.batchSize)
        const batchNum = Math.floor(i / this.batchSize) + 1
        const totalBatches = Math.ceil(addresses.length / this.batchSize)

        this.logger(`Processing batch ${batchNum}/${totalBatches} (${batch.length} identities)`)

        const snapshots: ScoreSnapshot[] = []

        for (const address of batch) {
          try {
            const data = await this.dataSource.getIdentityData(address)
            
            if (!data) {
              this.logger(`No data found for ${address}`)
              processed++
              continue
            }

            const score = this.scoreComputer(data)
            const snapshot: ScoreSnapshot = {
              address,
              score,
              bondedAmount: data.bondedAmount,
              attestationCount: data.attestationCount,
              timestamp: new Date().toISOString(),
            }

            snapshots.push(snapshot)
            processed++
          } catch (error) {
            errors++
            const errorMsg = error instanceof Error ? error.message : 'Unknown error'
            this.logger(`Error processing ${address}: ${errorMsg}`)

            if (!this.continueOnError) {
              throw error
            }
          }
        }

        // Save batch
        if (snapshots.length > 0) {
          try {
            await this.store.saveBatch(snapshots)
            saved += snapshots.length
            this.logger(`Saved ${snapshots.length} snapshots`)
          } catch (error) {
            errors += snapshots.length
            const errorMsg = error instanceof Error ? error.message : 'Unknown error'
            this.logger(`Error saving batch: ${errorMsg}`)

            if (!this.continueOnError) {
              throw error
            }
          }
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error'
      this.logger(`Job failed: ${errorMsg}`)
      throw error
    }

    const duration = Date.now() - startMs
    this.logger(`Job completed: ${processed} processed, ${saved} saved, ${errors} errors, ${duration}ms`)

    return {
      processed,
      saved,
      errors,
      duration,
      startTime,
    }
  }
}

/**
 * Create a score snapshot job.
 * 
 * @param dataSource - Source for identity data
 * @param store - Store for persisting snapshots
 * @param scoreComputer - Function to compute scores
 * @param options - Job options
 * @returns ScoreSnapshotJob instance
 */
export function createScoreSnapshotJob(
  dataSource: IdentityDataSource,
  store: ScoreSnapshotStore,
  scoreComputer: ScoreComputer,
  options?: SnapshotJobOptions
): ScoreSnapshotJob {
  return new ScoreSnapshotJob(dataSource, store, scoreComputer, options)
}
