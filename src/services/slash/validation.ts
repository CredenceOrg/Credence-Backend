import type { CreateSlashRequestInput, ValidationError, SlashStatus } from './types.js'
import { SlashStatus as SlashStatusEnum } from './types.js'

const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/
const MIN_REASON_LENGTH = 10
const MAX_REASON_LENGTH = 5000
const MIN_AMOUNT = 0.0000001
const MAX_AMOUNT = 1000000000

/**
 * Validate Stellar address format
 * 
 * @param address - Address to validate
 * @returns True if valid
 */
export function isValidStellarAddress(address: string): boolean {
  return STELLAR_ADDRESS_REGEX.test(address)
}

/**
 * Validate slash request creation input
 * 
 * @param input - Slash request input
 * @returns Array of validation errors (empty if valid)
 */
export function validateCreateSlashRequest(
  input: CreateSlashRequestInput
): ValidationError[] {
  const errors: ValidationError[] = []

  // Validate target address
  if (!input.targetAddress || typeof input.targetAddress !== 'string') {
    errors.push({
      field: 'targetAddress',
      message: 'Target address is required',
    })
  } else if (!isValidStellarAddress(input.targetAddress)) {
    errors.push({
      field: 'targetAddress',
      message: 'Target address must be a valid Stellar address (G followed by 55 base32 characters)',
    })
  }

  // Validate submitted by address
  if (!input.submittedBy || typeof input.submittedBy !== 'string') {
    errors.push({
      field: 'submittedBy',
      message: 'Submitter address is required',
    })
  } else if (!isValidStellarAddress(input.submittedBy)) {
    errors.push({
      field: 'submittedBy',
      message: 'Submitter address must be a valid Stellar address',
    })
  }

  // Validate they're not the same
  if (
    input.targetAddress &&
    input.submittedBy &&
    input.targetAddress === input.submittedBy
  ) {
    errors.push({
      field: 'targetAddress',
      message: 'Cannot submit a slash request against yourself',
    })
  }

  // Validate amount
  if (!input.amount || typeof input.amount !== 'string') {
    errors.push({
      field: 'amount',
      message: 'Amount is required',
    })
  } else {
    const amount = parseFloat(input.amount)
    if (isNaN(amount)) {
      errors.push({
        field: 'amount',
        message: 'Amount must be a valid number',
      })
    } else if (amount < MIN_AMOUNT) {
      errors.push({
        field: 'amount',
        message: `Amount must be at least ${MIN_AMOUNT}`,
      })
    } else if (amount > MAX_AMOUNT) {
      errors.push({
        field: 'amount',
        message: `Amount must not exceed ${MAX_AMOUNT}`,
      })
    }
  }

  // Validate reason
  if (!input.reason || typeof input.reason !== 'string') {
    errors.push({
      field: 'reason',
      message: 'Reason is required',
    })
  } else {
    const trimmedReason = input.reason.trim()
    if (trimmedReason.length < MIN_REASON_LENGTH) {
      errors.push({
        field: 'reason',
        message: `Reason must be at least ${MIN_REASON_LENGTH} characters`,
      })
    } else if (trimmedReason.length > MAX_REASON_LENGTH) {
      errors.push({
        field: 'reason',
        message: `Reason must not exceed ${MAX_REASON_LENGTH} characters`,
      })
    }
  }

  // Validate evidence reference
  if (!input.evidenceRef || typeof input.evidenceRef !== 'string') {
    errors.push({
      field: 'evidenceRef',
      message: 'Evidence reference is required',
    })
  } else if (input.evidenceRef.trim().length === 0) {
    errors.push({
      field: 'evidenceRef',
      message: 'Evidence reference cannot be empty',
    })
  }

  return errors
}

/**
 * Validate status transition
 * 
 * @param currentStatus - Current status
 * @param newStatus - New status
 * @returns True if transition is valid
 */
export function isValidStatusTransition(
  currentStatus: SlashStatus,
  newStatus: SlashStatus
): boolean {
  const validTransitions: Record<SlashStatus, SlashStatus[]> = {
    [SlashStatusEnum.PENDING]: [SlashStatusEnum.APPROVED, SlashStatusEnum.REJECTED],
    [SlashStatusEnum.APPROVED]: [SlashStatusEnum.EXECUTED],
    [SlashStatusEnum.REJECTED]: [],
    [SlashStatusEnum.EXECUTED]: [],
  }

  return validTransitions[currentStatus]?.includes(newStatus) ?? false
}

/**
 * Get validation error message for invalid status transition
 * 
 * @param currentStatus - Current status
 * @param newStatus - New status
 * @returns Error message
 */
export function getStatusTransitionError(
  currentStatus: SlashStatus,
  newStatus: SlashStatus
): string {
  if (currentStatus === newStatus) {
    return `Request is already in ${currentStatus} status`
  }

  switch (currentStatus) {
    case SlashStatusEnum.PENDING:
      return `Can only approve or reject pending requests, not transition to ${newStatus}`
    case SlashStatusEnum.APPROVED:
      return `Can only execute approved requests, not transition to ${newStatus}`
    case SlashStatusEnum.REJECTED:
      return 'Cannot change status of rejected requests'
    case SlashStatusEnum.EXECUTED:
      return 'Cannot change status of executed requests'
    default:
      return `Invalid status transition from ${currentStatus} to ${newStatus}`
  }
}
