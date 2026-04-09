/**
 * Horizon Bond Creation Listener
 * Listens for bond creation events from Stellar/Horizon and syncs identity/bond state to DB.
 * @module horizonBondEvents
 */

import { Horizon } from '@stellar/stellar-sdk'
import { upsertIdentity, upsertBond } from '../services/identityService.js'

const HORIZON_URL = process.env.HORIZON_URL || 'https://horizon.stellar.org'
const server = new Horizon.Server(HORIZON_URL)

/**
 * Subscribe to bond creation events from Horizon
 * @param {ReplayService} replayService Service to capture failures
 * @param {function} onEvent Callback for each bond creation event
 */
export function subscribeBondCreationEvents(onEvent?: (event: { identity: { id: string }; bond: { id: string; amount: string; duration: string | null } }) => void) {
  // Example: Listen to operations of type 'create_bond' (custom event)
  let cursor = 'now';
  let stream;
  const startStream = () => {
    stream = (server.operations() as any)
      .forAsset('BOND') // Replace with actual asset code if needed
      .cursor(cursor)
      .stream({
        onmessage: async (op: any) => {
          cursor = op.paging_token;
          if (op.type === 'create_bond') {
            const event = parseBondEvent(op);
            await upsertIdentity(event.identity);
            await upsertBond(event.bond);
            if (onEvent) onEvent(event)
          }
        },
          onerror: (err: unknown) => {
          console.error('Horizon stream error:', err);
          setTimeout(() => {
            startStream(); // Reconnect after delay
          }, 5000);
        }
      });
  };
  startStream();

  startStream()
}

/**
 * Parse bond creation event payload
 * @param {object} op Operation object from Horizon
 * @returns {{identity: object, bond: object}}
 */
function parseBondEvent(op: { source_account: string; id: string; amount: string; duration?: string | null }) {
  // Example parsing logic
  return {
    identity: { id: op.source_account },
    bond: {
      id: op.id,
      amount: op.amount,
      duration: op.duration ?? null,
    },
  }
}
