// src/listeners/horizon.listener.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbRepository } from '../db/repository.js';
import { HorizonListener } from './horizon.listeners.js';

// 1. Mock the DB Repository using Vitest
vi.mock('../db/repository.js', () => ({
  dbRepository: {
    upsertNode: vi.fn(),
    updateNodeStatus: vi.fn(),
  },
}));

describe('HorizonListener Logic', () => {
  let listener: HorizonListener;

  beforeEach(() => {
    // Reset mocks before each test to ensure a clean state
    vi.clearAllMocks();
    listener = new HorizonListener(dbRepository);
  });

  describe('Success Scenarios: Event Parsing', () => {
    it('should correctly parse a "bond" event and upsert to DB', async () => {
      const mockBondEvent = {
        type: 'bond',
        nodeId: 'G_VALID_NODE_123',
        amount: '1000',
      };

      vi.mocked(dbRepository.upsertNode).mockResolvedValue(true);

      await listener.handleEvent(mockBondEvent);

      expect(dbRepository.upsertNode).toHaveBeenCalledTimes(1);
      expect(dbRepository.upsertNode).toHaveBeenCalledWith(mockBondEvent.nodeId, mockBondEvent.amount);
    });

    it('should correctly parse a "slash" event and update DB status', async () => {
      const mockSlashEvent = {
        type: 'slash',
        nodeId: 'G_VALID_NODE_123',
        penalty: '500',
      };

      vi.mocked(dbRepository.updateNodeStatus).mockResolvedValue(true);

      await listener.handleEvent(mockSlashEvent);

      expect(dbRepository.updateNodeStatus).toHaveBeenCalledTimes(1);
      expect(dbRepository.updateNodeStatus).toHaveBeenCalledWith(mockSlashEvent.nodeId, 'slashed', mockSlashEvent.penalty);
    });

    it('should correctly parse a "withdrawal" event and update DB', async () => {
      const mockWithdrawalEvent = {
        type: 'withdrawal',
        nodeId: 'G_VALID_NODE_123',
      };

      vi.mocked(dbRepository.updateNodeStatus).mockResolvedValue(true);

      await listener.handleEvent(mockWithdrawalEvent);

      expect(dbRepository.updateNodeStatus).toHaveBeenCalledTimes(1);
      expect(dbRepository.updateNodeStatus).toHaveBeenCalledWith(mockWithdrawalEvent.nodeId, 'withdrawn');
    });
  });

  describe('Error Handling Scenarios', () => {
    it('should throw an error for malformed events (missing nodeId)', async () => {
      const malformedEvent = { type: 'bond' };

      await expect(listener.handleEvent(malformedEvent as any)).rejects.toThrow(
        'Malformed event payload: missing required fields'
      );
      expect(dbRepository.upsertNode).not.toHaveBeenCalled();
    });

    it('should throw an error for bond event missing amount', async () => {
      const malformedEvent = { type: 'bond', nodeId: 'G_VALID_NODE_123' };

      await expect(listener.handleEvent(malformedEvent as any)).rejects.toThrow(
        'Malformed event payload: missing required fields'
      );
    });

    // NEW TEST ADDED HERE
    it('should throw an error for slash event missing penalty', async () => {
      const malformedEvent = { type: 'slash', nodeId: 'G_VALID_NODE_123' };

      await expect(listener.handleEvent(malformedEvent as any)).rejects.toThrow(
        'Malformed event payload: missing required fields'
      );
    });

    it('should handle DB failures gracefully', async () => {
      const mockBondEvent = {
        type: 'bond',
        nodeId: 'G_VALID_NODE_123',
        amount: '1000',
      };

      const dbError = new Error('Database connection timeout');
      vi.mocked(dbRepository.upsertNode).mockRejectedValue(dbError);

      await expect(listener.handleEvent(mockBondEvent)).rejects.toThrow('Database connection timeout');
    });

    it('should safely ignore unknown event types', async () => {
      const unknownEvent = {
        type: 'unknown_action',
        nodeId: 'G_VALID_NODE_123',
      };

      // Spying on console.log to avoid cluttering the test output
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await listener.handleEvent(unknownEvent as any);

      expect(dbRepository.upsertNode).not.toHaveBeenCalled();
      expect(dbRepository.updateNodeStatus).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith('Ignored unknown event type: unknown_action');
      
      consoleSpy.mockRestore();
    });
  });
});