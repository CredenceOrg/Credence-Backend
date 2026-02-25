export interface CredenceConfig {
  baseUrl: string
  apiKey?: string
  timeout?: number
}

export interface TrustScore {
  address: string
  score: number
  bondedAmount: string
  bondStart: string | null
  attestationCount: number
}

export interface BondStatus {
  address: string
  bondedAmount: string
  bondStart: string | null
  bondDuration: string | null
  active: boolean
}

export interface Attestation {
  id: string
  attester: string
  subject: string
  value: string
  timestamp: string
}

export interface AttestationsResponse {
  address: string
  attestations: Attestation[]
  count: number
}

export interface VerificationProof {
  address: string
  proof: string | null
  verified: boolean
  timestamp: string | null
}

export class CredenceApiError extends Error {
  public readonly status: number
  public readonly body: string

  constructor(message: string, status: number, body: string) {
    super(message)
    this.name = 'CredenceApiError'
    this.status = status
    this.body = body
  }
}
