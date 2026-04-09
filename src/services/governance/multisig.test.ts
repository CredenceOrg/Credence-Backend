import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MultiSigCoordinationService } from './multisig.js';
import { InMemoryProposalStorage } from './inMemoryStorage.js';
import type { MultisigInput } from './types.js';

describe('MultiSigCoordinationService', () => {
  let service: MultiSigCoordinationService;
  let storage: InMemoryProposalStorage;

  const HOUR = 60 * 60 * 1000;

  function validInput(overrides: Partial<MultisigInput> = {}): MultisigInput {
    return {
      signers: ['alice', 'bob', 'carol'],
      requiredSignatures: 2,
      action: 'slash_bond',
      payload: { amount: 1000 },
      ttlMs: 24 * HOUR,
      ...overrides,
    };
  }

  beforeEach(() => {
    storage = new InMemoryProposalStorage();
    service = new MultiSigCoordinationService(storage);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('createProposal', () => {
    it('should create a proposal successfully', async () => {
      const callback = vi.fn();
      service.on('proposalCreated', callback);

      const input = validInput();
      const proposal = await service.createProposal(input);

      expect(proposal.id).toBeDefined();
      expect(proposal.status).toBe('pending');
      expect(proposal.signers).toEqual(['alice', 'bob', 'carol']);
      expect(proposal.requiredSignatures).toBe(2);
      expect(callback).toHaveBeenCalledWith(proposal);
    });

    it('should throw when creating a proposal with fewer than 2 signers', async () => {
      const input = validInput({ signers: ['alice'] });
      await expect(service.createProposal(input)).rejects.toThrow('At least 2 signers are required');
    });

    it('should throw when required signatures exceed signers', async () => {
      const input = validInput({ requiredSignatures: 4 });
      await expect(service.createProposal(input)).rejects.toThrow('requiredSignatures must be between 1 and the number of signers');
    });
  });

  describe('submitSignature', () => {
    it('should collect signatures and transition to approved when threshold met', async () => {
      const sigCallback = vi.fn();
      const appCallback = vi.fn();
      service.on('signatureSubmitted', sigCallback);
      service.on('proposalApproved', appCallback);

      const proposal = await service.createProposal(validInput());

      // First signature
      await service.submitSignature(proposal.id, 'alice', 'sig-alice');
      expect(sigCallback).toHaveBeenCalledWith({ id: proposal.id, signer: 'alice', signature: 'sig-alice' });
      expect(appCallback).not.toHaveBeenCalled();
      
      const updated = (await service.getProposal(proposal.id))!;
      expect(updated.status).toBe('pending');
      expect(updated.signatures.get('alice')).toBe('sig-alice');

      // Second signature (threshold met)
      await service.submitSignature(proposal.id, 'bob', 'sig-bob');
      expect(appCallback).toHaveBeenCalled();
      
      const final = (await service.getProposal(proposal.id))!;
      expect(final.status).toBe('approved');
    });

    it('should throw when unauthorized signer attempts to sign', async () => {
      const proposal = await service.createProposal(validInput());
      await expect(service.submitSignature(proposal.id, 'eve', 'sig')).rejects.toThrow(/is not authorized/);
    });

    it('should throw when signer signs twice', async () => {
      const proposal = await service.createProposal(validInput());
      await service.submitSignature(proposal.id, 'alice', 'sig1');
      await expect(service.submitSignature(proposal.id, 'alice', 'sig2')).rejects.toThrow(/has already signed/);
    });
  });

  describe('addSlashingVote', () => {
    it('should record slashing votes and reject if threshold reached', async () => {
      const slashCallback = vi.fn();
      const rejCallback = vi.fn();
      service.on('slashingVoteAdded', slashCallback);
      service.on('proposalRejected', rejCallback);

      const proposal = await service.createProposal(validInput({ signers: ['alice', 'bob', 'carol', 'dave'] }));
      
      // Add one slashing vote
      await service.addSlashingVote(proposal.id, 'voter1');
      expect(slashCallback).toHaveBeenCalledWith({ id: proposal.id, voter: 'voter1' });
      
      // Add second slashing vote (threshold for 4 signers is 2)
      await service.addSlashingVote(proposal.id, 'voter2');
      expect(rejCallback).toHaveBeenCalledWith(expect.objectContaining({ reason: 'Slashing threshold reached' }));
      
      const updated = (await service.getProposal(proposal.id))!;
      expect(updated.status).toBe('rejected');
    });
  });

  describe('executeProposal', () => {
    it('should execute an approved proposal', async () => {
      const execCallback = vi.fn();
      service.on('proposalExecuted', execCallback);

      const proposal = await service.createProposal(validInput({ requiredSignatures: 1 }));
      await service.submitSignature(proposal.id, 'alice', 'sig-alice');
      
      const result = await service.executeProposal(proposal.id);
      expect(result).toEqual({ amount: 1000 });
      expect(execCallback).toHaveBeenCalled();

      const final = (await service.getProposal(proposal.id))!;
      expect(final.status).toBe('executed');
    });

    it('should throw when executing unapproved proposal', async () => {
      const proposal = await service.createProposal(validInput({ requiredSignatures: 2 }));
      await expect(service.executeProposal(proposal.id)).rejects.toThrow(/Cannot execute proposal in status pending/);
    });
  });

  describe('expiration', () => {
    it('should handle timeout correctly', async () => {
      const expCallback = vi.fn();
      service.on('proposalExpired', expCallback);

      const proposal = await service.createProposal(validInput({ ttlMs: HOUR }));

      vi.advanceTimersByTime(HOUR + 1000);

      const updated = await service.getProposal(proposal.id);
      expect(updated?.status).toBe('expired');
      expect(expCallback).toHaveBeenCalled();
    });
  });
});
