# Score Snapshot Job

Scheduled job that periodically computes and persists score snapshots for all active identities.

## Overview

The score snapshot job:
- Fetches all active identities
- Computes trust scores based on bond amount and attestation count
- Persists snapshots to score_history table
- Processes identities in batches for scalability
- Handles errors gracefully with configurable retry behavior

## Score Computation

Default algorithm (60% bond, 40% attestations):

```
score = 0.6 * bondScore + 0.4 * attestationScore

where:
- bondScore = min(bondAmount / 1000 * 100, 100)
- attestationScore = min(attestationCount / 50 * 100, 100)
```

Inactive identities always receive a score of 0.

## Usage

### Basic Setup

```typescript
import { createScoreSnapshotJob, computeScore } from './jobs/index.js'

// Create data source
const dataSource: IdentityDataSource = {
  async getActiveAddresses() {
    // Fetch from database
    return ['0xabc...', '0xdef...']
  },
  async getIdentityData(address) {
    // Fetch bond and attestation data
    return {
      address,
      bondedAmount: '1000',
      active: true,
      attestationCount: 25,
    }
  },
}

// Create store
const store: ScoreSnapshotStore = {
  async saveBatch(snapshots) {
    // Save to score_history table
    await db.insert('score_history', snapshots)
  },
}

// Create job
const job = createScoreSnapshotJob(dataSource, store, computeScore, {
  batchSize: 100,
  continueOnError: true,
  logger: console.log,
})

// Run once
const result = await job.run()
console.log(`Processed ${result.processed} identities in ${result.duration}ms`)
```

### Scheduled Execution

```typescript
import { createScheduler } from './jobs/index.js'

// Create scheduler (runs every hour)
const scheduler = createScheduler(job, {
  cronExpression: '0 * * * *', // Every hour
  runOnStart: false,
  logger: console.log,
})

// Start scheduler
scheduler.start()

// Stop when needed
scheduler.stop()
```

## Configuration

### Job Options

- `batchSize` (default: 100) - Number of identities to process per batch
- `continueOnError` (default: true) - Continue processing on errors
- `logger` - Function for logging progress and errors

### Scheduler Options

- `cronExpression` (default: '0 * * * *') - Cron schedule
  - `'* * * * *'` - Every minute
  - `'0 * * * *'` - Every hour
  - `'0 0 * * *'` - Every day
- `runOnStart` (default: false) - Run immediately on start
- `logger` - Function for logging

## Supported Cron Patterns

Simplified cron parser supports:
- Every minute: `* * * * *`
- Every hour: `0 * * * *`
- Every day: `0 0 * * *`

For complex patterns, use a full-featured scheduler like node-cron or Bull.

## Job Result

```typescript
interface SnapshotJobResult {
  processed: number  // Identities processed
  saved: number      // Snapshots saved
  errors: number     // Errors encountered
  duration: number   // Duration in ms
  startTime: string  // ISO timestamp
}
```

## Error Handling

### Continue on Error (default)

Logs errors and continues processing remaining identities:

```typescript
const job = createScoreSnapshotJob(dataSource, store, computeScore, {
  continueOnError: true,
  logger: (msg) => console.error(msg),
})
```

### Stop on Error

Throws on first error:

```typescript
const job = createScoreSnapshotJob(dataSource, store, computeScore, {
  continueOnError: false,
})

try {
  await job.run()
} catch (error) {
  console.error('Job failed:', error)
}
```

## Batch Processing

For large datasets, adjust batch size:

```typescript
const job = createScoreSnapshotJob(dataSource, store, computeScore, {
  batchSize: 500, // Process 500 at a time
})
```

Batching reduces memory usage and allows progress tracking.

## Custom Score Algorithm

Provide your own score computation:

```typescript
function customScoreComputer(data: IdentityData): number {
  if (!data.active) return 0
  
  // Custom logic
  const bondScore = Number(BigInt(data.bondedAmount) / 10n)
  const attestationBonus = data.attestationCount * 2
  
  return Math.min(bondScore + attestationBonus, 100)
}

const job = createScoreSnapshotJob(
  dataSource,
  store,
  customScoreComputer
)
```

## Production Deployment

### With Node-Cron

```typescript
import cron from 'node-cron'

cron.schedule('0 * * * *', async () => {
  try {
    const result = await job.run()
    console.log('Job completed:', result)
  } catch (error) {
    console.error('Job failed:', error)
  }
})
```

### With Bull Queue

```typescript
import Queue from 'bull'

const queue = new Queue('score-snapshots', {
  redis: { host: 'localhost', port: 6379 }
})

queue.process(async () => {
  return await job.run()
})

queue.add({}, {
  repeat: { cron: '0 * * * *' }
})
```

## Monitoring

Log job metrics for monitoring:

```typescript
const job = createScoreSnapshotJob(dataSource, store, computeScore, {
  logger: (msg) => {
    console.log(msg)
    // Send to monitoring service
    metrics.log(msg)
  },
})
```

Track key metrics:
- Execution duration
- Success/error rates
- Number of identities processed
- Batch processing times
