import { horizonWithdrawalListener } from './horizonWithdrawalEvents.js'

export {
  IdentityStateSync,
  createIdentityStateSync,
  type ReconcileResult,
  type FullResyncResult,
} from './identityStateSync.js'
export type { ContractReader, IdentityState, IdentityStateStore } from './types.js'
export {
  AttestationEventListener,
  type AttestationEvent,
  type AttestationStore,
  type AttestationListenerConfig,
  type AttestationListenerStats,
  type EventFetcher,
  type ScoreInvalidationCallback,
} from './attestationEvents.js'
export {
  DlqReasonCode,
  DlqRouter,
  validateMessage,
  validateAndRoute,
  type DlqSink,
  type ValidationResult,
  type ValidationSuccess,
  type ValidationFailure,
} from './messageValidator.js'

export async function stop(): Promise<void> {
  await horizonWithdrawalListener.stop()
}
