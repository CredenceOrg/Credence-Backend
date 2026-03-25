import 'dotenv/config'
import app from './app.js'
import { loadConfig } from './config/index.js'
import { processIncomingJob } from './queue/worker.js' // New import

try {
  const config = loadConfig()

  // Start the API Server
  app.listen(config.port, () => {
    console.log(`Credence API listening on port ${config.port}`)
    
    // --- ISSUE #170 TEST SUITE ---
    console.log('--- Running Queue Validation Tests ---')

    // Test 1: Valid Identity Update
    processIncomingJob({
      id: 'job_valid_001',
      type: 'identity.update',
      data: {
        version: 1,
        entityId: 101,
        newAddress: 'GBRPN6R4FCH000000000000000000000000000000000000000000000',
        timestamp: new Date().toISOString()
      }
    })

    // Test 2: Invalid Payload (Should trigger DLQ)
    processIncomingJob({
      id: 'job_invalid_002',
      type: 'identity.update',
      data: { 
        version: 1, 
        entityId: "not-a-number", // Error: Expected number
        newAddress: 'INVALID_STELLAR_ADDR' // Error: Regex mismatch
      }
    })
    // ------------------------------
  })
} catch (error) {
  console.error("Failed to start Credence API:", error)
  process.exit(1)
}