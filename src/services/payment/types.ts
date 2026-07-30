/**
 * Payment processing types
 */

export interface PaymentRequest {
  bondId: number
  amount: string
  transactionHash: string
  fromAccount: string
}

export interface ValidationResult {
  valid: boolean
  errors?: string[]
}

export interface RiskCheckResult {
  approved: boolean
  riskScore: number
  reason?: string
}

export interface ProcessorResult {
  success: boolean
  transactionHash: string
  timestamp: Date
}

export interface PaymentResult {
  settlementId: number
  status: 'pending' | 'settled' | 'failed'
  transactionHash: string
  processedAt: Date
  stages: {
    validation: { duration: number; success: boolean }
    riskCheck: { duration: number; approved: boolean; riskScore: number }
    processor: { duration: number; success: boolean }
    settlement: { duration: number; success: boolean; isDuplicate: boolean }
  }
}
