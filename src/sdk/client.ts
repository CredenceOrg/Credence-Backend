import {
  CredenceConfig,
  CredenceApiError,
  TrustScore,
  BondStatus,
  AttestationsResponse,
  VerificationProof,
} from './types.js'

const DEFAULT_TIMEOUT = 30_000

export class CredenceClient {
  private readonly baseUrl: string
  private readonly apiKey: string | undefined
  private readonly timeout: number

  constructor(config: CredenceConfig) {
    if (!config.baseUrl) {
      throw new Error('baseUrl is required')
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.apiKey = config.apiKey
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT
  }

  /**
   * Retrieve the trust score for a given address.
   */
  async getTrustScore(address: string): Promise<TrustScore> {
    return this.request<TrustScore>(`/api/trust/${encodeURIComponent(address)}`)
  }

  /**
   * Retrieve the bond status for a given address.
   */
  async getBondStatus(address: string): Promise<BondStatus> {
    return this.request<BondStatus>(`/api/bond/${encodeURIComponent(address)}`)
  }

  /**
   * Retrieve attestations for a given address.
   */
  async getAttestations(address: string): Promise<AttestationsResponse> {
    return this.request<AttestationsResponse>(`/api/attestations/${encodeURIComponent(address)}`)
  }

  /**
   * Retrieve the verification proof for a given address.
   */
  async getVerificationProof(address: string): Promise<VerificationProof> {
    return this.request<VerificationProof>(`/api/verification/${encodeURIComponent(address)}`)
  }

  private async request<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const headers: Record<string, string> = {
      'Accept': 'application/json',
    }
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeout)

    let response: Response
    try {
      response = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      })
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new CredenceApiError(`Request timed out: ${url}`, 0, '')
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new CredenceApiError(`Request timed out: ${url}`, 0, '')
      }
      throw new CredenceApiError(
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
        0,
        '',
      )
    } finally {
      clearTimeout(timer)
    }

    const body = await response.text()

    if (!response.ok) {
      throw new CredenceApiError(
        `HTTP ${response.status}: ${response.statusText}`,
        response.status,
        body,
      )
    }

    try {
      return JSON.parse(body) as T
    } catch {
      throw new CredenceApiError('Invalid JSON response', response.status, body)
    }
  }
}
