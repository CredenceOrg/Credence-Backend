/**
 * Example: Webhook integration with identity state sync
 */

import { createIdentityStateSync } from '../src/listeners/identityStateSync.js'
import { createWebhookService } from '../src/services/webhooks/service.js'
import { MemoryWebhookStore } from '../src/services/webhooks/memoryStore.js'
import { emitWebhookForStateChange } from '../src/listeners/webhookIntegration.js'
import type { ContractReader, IdentityStateStore } from '../src/listeners/types.js'

// Setup webhook service
const webhookStore = new MemoryWebhookStore()
await webhookStore.set({
  id: 'wh_enterprise_1',
  url: 'https://api.example.com/webhooks/bonds',
  events: ['bond.created', 'bond.slashed', 'bond.withdrawn'],
  secret: 'your-webhook-secret',
  active: true,
})

const webhookService = createWebhookService(webhookStore)

// Setup identity sync with webhook integration
const contract: ContractReader = {
  async getIdentityState(address: string) {
    // Fetch from blockchain
    return {
      address,
      bondedAmount: '1000',
      bondStart: Date.now(),
      bondDuration: 86400,
      active: true,
    }
  },
}

const store: IdentityStateStore = {
  async get(address: string) {
    // Fetch from database
    return null
  },
  async set(state) {
    // Save to database
  },
  async getAllAddresses() {
    return []
  },
}

// Enhanced reconciliation with webhooks
async function reconcileWithWebhooks(address: string) {
  const oldState = await store.get(address)
  const newState = await contract.getIdentityState(address)
  
  if (newState) {
    await store.set(newState)
    await emitWebhookForStateChange(webhookService, oldState, newState)
  }
}

// Use in your event listener
await reconcileWithWebhooks('0xabc...')
