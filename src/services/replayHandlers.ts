import { ReplayHandler, ReplayService } from './replayService.js'
import { IdentityRepository } from '../db/repositories/identityRepository.js'
import { BondsRepository } from '../db/repositories/bondsRepository.js'

/**
 * Handler for bond creation events.
 * Re-runs the identity and bond upsert logic using real repositories.
 */
export class BondCreationReplayHandler implements ReplayHandler {
  constructor(
    private readonly identityRepo: IdentityRepository,
    private readonly bondsRepo: BondsRepository
  ) {}

  async handle(eventData: any): Promise<void> {
    // Standard format for eventData from horizonBondEvents.ts is the original operation
    // But handlers expect parsed data. If not parsed, we'd need to parse it here.
    const { identity, bond } = eventData.parsed || eventData
    
    if (identity) {
      await this.identityRepo.upsert(identity)
    }
    
    if (bond) {
      // Bonds usually have identityAddress, amount, startTime, durationDays
      await this.bondsRepo.create(bond)
    }
  }
}

/**
 * Handler for attestation events.
 */
export class AttestationReplayHandler implements ReplayHandler {
  constructor(private readonly processor: { processEvent: (event: any) => Promise<any> }) {}

  async handle(eventData: any): Promise<void> {
    await this.processor.processEvent(eventData)
  }
}

/**
 * Handler for withdrawal events.
 */
export class WithdrawalReplayHandler implements ReplayHandler {
  constructor(private readonly processor: { processWithdrawalEvent: (event: any) => Promise<any> }) {}

  async handle(eventData: any): Promise<void> {
    await this.processor.processWithdrawalEvent(eventData)
  }
}

/**
 * Helper to register all standard handlers to a ReplayService instance.
 */
export function registerAllReplayHandlers(
  replayService: ReplayService,
  identityRepo: IdentityRepository,
  bondsRepo: BondsRepository,
  attestationProcessor?: any,
  withdrawalProcessor?: any
): void {
  replayService.registerHandler('bond_creation', new BondCreationReplayHandler(identityRepo, bondsRepo))
  
  if (attestationProcessor) {
    replayService.registerHandler('attestation', new AttestationReplayHandler(attestationProcessor))
  }
  
  if (withdrawalProcessor) {
    replayService.registerHandler('withdrawal', new WithdrawalReplayHandler(withdrawalProcessor))
  }
}
