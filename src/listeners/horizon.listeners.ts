// src/listeners/horizon.listener.ts
import { dbRepository } from '../db/repository.js';

export interface HorizonEvent {
  type: string;
  nodeId?: string;
  amount?: string;
  penalty?: string;
  timestamp?: string;
}

export class HorizonListener {
  // Inject dependency for easy mocking
  constructor(private db = dbRepository) {}

  async handleEvent(event: HorizonEvent): Promise<void> {
    if (!event.nodeId || !event.type) {
      throw new Error('Malformed event payload: missing required fields');
    }

    try {
      switch (event.type) {
        case 'bond':
          if (!event.amount) throw new Error('Malformed event payload: missing required fields');
          await this.db.upsertNode(event.nodeId, event.amount);
          break;
        case 'slash':
          if (!event.penalty) throw new Error('Malformed event payload: missing required fields');
          await this.db.updateNodeStatus(event.nodeId, 'slashed', event.penalty);
          break;
        case 'withdrawal':
          await this.db.updateNodeStatus(event.nodeId, 'withdrawn');
          break;
        default:
          console.log(`Ignored unknown event type: ${event.type}`);
          break;
      }
    } catch (error) {
      throw error; // Re-throw to allow tests to catch DB failures
    }
  }
}