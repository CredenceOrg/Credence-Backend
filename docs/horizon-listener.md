# Horizon Listener - Withdrawal Events

This document describes the Horizon withdrawal events listener implementation for the Credence Backend.

## Overview

The Horizon withdrawal events listener monitors Stellar blockchain for withdrawal transactions that affect bond states and updates the local bond records accordingly. It ensures consistency between on-chain state and the application database.

## Architecture

### HorizonWithdrawalListener

The main class that handles Horizon event streaming and bond state updates:

```ts
import { createHorizonWithdrawalListener } from '../listeners/horizonWithdrawalEvents.js'

const listener = createHorizonWithdrawalListener({
  horizonUrl: 'https://horizon-testnet.stellar.org',
  pollingInterval: 5000,
  bondContractAddress: 'GABCD...'
})

await listener.start()
```

### Key Components

- **Connection Management** - Handles Horizon server connection and reconnection
- **Event Polling** - Polls Horizon for new withdrawal operations
- **Bond State Updates** - Updates bond records based on withdrawal amounts
- **Score Snapshots** - Creates score history snapshots for significant withdrawals
- **Error Handling** - Graceful handling of API errors and network issues

## Configuration

### HorizonListenerConfig

```ts
interface HorizonListenerConfig {
  horizonUrl: string              // Horizon server URL
  networkPassphrase: string        // Stellar network passphrase
  bondContractAddress?: string    // Optional bond contract address
  withdrawalAsset?: {             // Optional specific withdrawal asset
    code: string
    issuer: string
  }
  pollingInterval?: number        // Polling interval in milliseconds
  lastCursor?: string            // Resume position
}
```

### Environment Variables

```bash
# Horizon server URL
HORIZON_URL=https://horizon-testnet.stellar.org

# Stellar network passphrase
STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"

# Optional: Bond contract address
BOND_CONTRACT_ADDRESS=GABCD...

# Optional: Polling interval (milliseconds)
HORIZON_POLLING_INTERVAL=5000
```

## API Reference

### HorizonWithdrawalListener Methods

#### `start(): Promise<void>`

Start listening for withdrawal events.

```ts
await listener.start()
```

#### `stop(): Promise<void>`

Stop listening for withdrawal events.

```ts
await listener.stop()
```

#### `isActive(): boolean`

Check if the listener is currently running.

```ts
const isRunning = listener.isActive()
```

#### `getCursor(): string`

Get the current cursor position for resuming.

```ts
const cursor = listener.getCursor()
```

#### `setCursor(cursor: string): void`

Set the cursor position for resuming from a specific point.

```ts
listener.setCursor('123456789')
```

#### `getStats(): ListenerStats`

Get listener statistics and status.

```ts
const stats = listener.getStats()
// Returns: { isRunning, horizonUrl, lastCursor, pollingInterval }
```

## Event Processing

### Withdrawal Detection

The listener identifies withdrawal events by:

1. **Operation Type** - Only processes `payment` operations
2. **Source Account** - Checks if payment originates from bond contract
3. **Asset Filtering** - Optionally filters by specific withdrawal asset

### Bond State Updates

For each withdrawal event:

1. **Retrieve Current Bond** - Gets current bond state from database
2. **Calculate New State** - Computes new amount and active status
3. **Update Database** - Saves updated bond state
4. **Score Snapshot** - Creates score history if needed

### State Calculation Logic

```ts
// Partial withdrawal
previousAmount: '1000.0000000'
withdrawalAmount: '300.0000000'
newAmount: '700.0000000'
isActive: true

// Full withdrawal
previousAmount: '1000.0000000'
withdrawalAmount: '1000.0000000'
newAmount: '0'
isActive: false
```

## Score History Snapshots

Score history snapshots are created for:

- **Full withdrawals** - When bond becomes inactive
- **Large partial withdrawals** - When 50% or more is withdrawn

### Snapshot Structure

```ts
interface ScoreHistorySnapshot {
  address: string
  score: number
  bondedAmount: string
  timestamp: Date
  reason: 'withdrawal_full' | 'withdrawal_partial'
  transactionHash: string
}
```

## Error Handling

The listener implements comprehensive error handling:

### Horizon API Errors

- **Connection failures** - Automatic retry with exponential backoff
- **Rate limiting** - Respects Horizon rate limits
- **Invalid responses** - Logs errors and continues processing

### Database Errors

- **Connection issues** - Logs errors but continues listening
- **Update failures** - Logs detailed error information
- **Missing bonds** - Warns and skips processing

### Graceful Degradation

The listener is designed to continue operating even when:

- Horizon server is temporarily unavailable
- Database connections are intermittent
- Individual events fail to process

## Performance Considerations

### Polling Strategy

- **Configurable intervals** - Adjust based on network activity
- **Batch processing** - Processes multiple events per poll
- **Cursor management** - Efficient resumption without gaps

### Memory Management

- **Event streaming** - Processes events in batches
- **Cursor persistence** - Maintains position across restarts
- **Error cleanup** - Proper resource cleanup on errors

### Database Optimization

- **Batch updates** - Groups multiple bond updates
- **Index usage** - Optimizes queries for bond lookups
- **Transaction safety** - Ensures data consistency

## Monitoring

### Health Checks

Monitor listener health with built-in statistics:

```ts
const stats = listener.getStats()
console.log(`Listener running: ${stats.isRunning}`)
console.log(`Last cursor: ${stats.lastCursor}`)
console.log(`Polling interval: ${stats.pollingInterval}ms`)
```

### Logging

The listener provides detailed logging:

- **Start/stop events** - Listener lifecycle events
- **Event processing** - Number of events processed
- **Errors** - Detailed error information
- **Performance** - Processing times and rates

### Metrics to Track

- Events processed per minute
- Bond update success rate
- API error rate
- Processing latency
- Database connection status

## Testing

The listener includes comprehensive tests:

```bash
# Run Horizon listener tests
npm test src/listeners/__tests__

# Run with coverage
npm run test:coverage
```

### Test Coverage

- **Configuration** - Default and custom configurations
- **Lifecycle** - Start/stop operations
- **Event Processing** - Withdrawal detection and processing
- **State Calculations** - Bond state update logic
- **Score Snapshots** - Snapshot creation logic
- **Error Handling** - Various error scenarios

## Security Considerations

### Network Security

- **HTTPS connections** - Always use HTTPS for Horizon
- **API authentication** - Use authenticated Horizon endpoints
- **Rate limiting** - Respect Horizon rate limits
- **Input validation** - Validate all Horizon responses

### Data Security

- **Sensitive data** - Avoid logging private keys or sensitive data
- **Access control** - Restrict database access
- **Audit logging** - Log all bond state changes
- **Data integrity** - Verify transaction signatures

## Best Practices

### Configuration

1. **Environment-specific URLs** - Use testnet for development
2. **Appropriate polling intervals** - Balance responsiveness and efficiency
3. **Proper error handling** - Handle all potential failure modes
4. **Resource limits** - Set reasonable timeouts and retries

### Operations

1. **Monitor health** - Regular health checks and monitoring
2. **Log analysis** - Review logs for errors and patterns
3. **Performance tuning** - Adjust polling based on load
4. **Backup strategies** - Regular database backups

### Development

1. **Test thoroughly** - Cover edge cases and error scenarios
2. **Mock external services** - Use Horizon mocks in tests
3. **Document changes** - Keep documentation updated
4. **Version control** - Track configuration changes

## Troubleshooting

### Common Issues

**Listener not starting**
- Check Horizon URL connectivity
- Verify network passphrase
- Review configuration values

**Missing bond updates**
- Verify bond contract address
- Check database connectivity
- Review withdrawal detection logic

**Performance issues**
- Reduce polling interval
- Check database query performance
- Monitor Horizon API usage

**High error rates**
- Review Horizon API status
- Check network connectivity
- Verify rate limit compliance

### Debug Mode

Enable debug logging for troubleshooting:

```ts
// Enable verbose logging
process.env.DEBUG = 'horizon-listener'

// Start listener with debug info
await listener.start()
```

## Integration Examples

### Basic Integration

```ts
import { createHorizonWithdrawalListener } from './listeners/horizonWithdrawalEvents.js'

async function startListener() {
  const listener = createHorizonWithdrawalListener({
    horizonUrl: process.env.HORIZON_URL!,
    pollingInterval: 5000
  })

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('Stopping Horizon listener...')
    await listener.stop()
    process.exit(0)
  })

  await listener.start()
  console.log('Horizon listener started')
}

startListener().catch(console.error)
```

### Advanced Configuration

```ts
const listener = createHorizonWithdrawalListener({
  horizonUrl: 'https://horizon.stellar.org',
  networkPassphrase: 'Public Global Stellar Network ; September 2015',
  bondContractAddress: 'GABCD...',
  withdrawalAsset: {
    code: 'USDC',
    issuer: 'GA5ZSEJYAAO...Issuer...'
  },
  pollingInterval: 10000,
  lastCursor: await loadLastCursor()
})

// Monitor listener health
setInterval(() => {
  const stats = listener.getStats()
  console.log('Listener stats:', stats)
}, 60000)
```

This Horizon listener provides a robust foundation for maintaining bond state consistency with the Stellar blockchain while ensuring high availability and error resilience.
# Horizon Bond Creation Listener

This module listens for bond creation events from Stellar/Horizon and syncs identity and bond state to the database.

## Features
- Subscribes to Horizon for bond creation events
- Parses event payload (identity, amount, duration, etc.)
- Upserts identity and bond records in PostgreSQL
- Handles reconnection and backfill
- Comprehensive tests with mocked Horizon

## Usage

```typescript
import { subscribeBondCreationEvents } from '../src/listeners/horizonBondEvents';

subscribeBondCreationEvents((event) => {
  // Handle bond creation event
  console.log(event);
});
```

## Event Payload Example
```
{
  identity: {
    id: 'GABC...',
    // ...other fields
  },
  bond: {
    id: 'bond123',
    amount: '1000',
    duration: '365',
    // ...other fields
  }
}
```

## Testing
- Tests are located in `src/__tests__/horizonBondEvents.test.ts`
- Run tests with `npm test` or `npx jest`
- Mocked Horizon stream covers event parsing, DB upsert, duplicate handling

## JSDoc
- All functions are documented with JSDoc comments in `src/listeners/horizonBondEvents.ts`

## Requirements
- Minimum 95% test coverage
- Clear documentation

## Backfill & Reconnection
- Listener automatically reconnects on errors
- Backfill logic can be extended to fetch missed events

---
For further details, see the code and tests.
