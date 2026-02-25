export interface TrustScore {
  address: string
  score: number
  bondedAmount: string
  bondStart: string | null
  attestationCount: number
  agreedFields?: Record<string, any>
}

export interface IdentityRecord {
  address: string
  bonded_amount: string
  bond_start: number | null
  bond_duration: number | null
  active: boolean
  attestation_count: number
  agreed_fields: Record<string, any> | null
}