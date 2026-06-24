/**
 * Example: Webhook integration with identity state sync via transactional outbox.
 */

import { createIdentityStateSync } from '../src/listeners/identityStateSync.js'
import { createWebhookService } from '../src/services/webhooks/service.js'
import { MemoryWebhookStore } from '../src/services/webhooks/memoryStore.js'
import { emitWebhookForStateChange, emitWebhookForScoreChange, emitWebhookForAttestationChange } from '../src/listeners/webhookIntegration.js'
import type { Queryable } from '../src/db/repositories/queryable.js'
import { emitWebhookForStateChange } from '../src/listeners/webhookIntegrationOutbox.js'
import type { ContractReader, IdentityState, IdentityStateStore } from '../src/listeners/types.js'

const contract: ContractReader = {
  async getIdentityState(address: string) {
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
    return null
  },
  async set(_state: IdentityState) {
    // Save to database
  },
  async getAllAddresses() {
    return []
  },
}

/**
 * Reconcile identity state and emit webhook events atomically via the outbox.
 * Replace `db` with your transaction client (e.g. pool or pg transaction).
 */
async function reconcileWithWebhooks(db: Queryable, address: string) {
  const oldState = await store.get(address)
  const newState = await contract.getIdentityState(address)

  if (newState) {
    await store.set(newState)
    await emitWebhookForStateChange(db, oldState, newState)
  }
}

// Use in your event listener (within a transaction in production)
await reconcileWithWebhooks({} as Queryable, '0xabc...')
