import {
  CredenceConfig,
  TrustScore,
  BondStatus,
  AttestationsResponse,
  VerificationProof,
} from './types.js'
import {
  CredenceError,
  createCredenceErrorFromEnvelope,
  createTransportCredenceError,
  parseCredenceErrorEnvelope,
} from './errors.generated.js'

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
      Accept: 'application/json',
    }
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`
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
      if (this.isAbortError(err)) {
        throw createTransportCredenceError(
          'sdk_request_timeout',
          `Request timed out: ${url}`,
          0,
          { cause: err },
        )
      }
      throw createTransportCredenceError(
        'sdk_network_error',
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
        0,
        { cause: err },
      )
    } finally {
      clearTimeout(timer)
    }

    const body = await response.text()

    if (!response.ok) {
      const envelope = parseCredenceErrorEnvelope(body)
      if (envelope) {
        throw createCredenceErrorFromEnvelope(envelope, response.status, { rawBody: body })
      }

      throw createTransportCredenceError(
        'sdk_unmapped_http',
        `HTTP ${response.status}: ${response.statusText}`,
        response.status,
        { rawBody: body },
      )
    }

    try {
      return JSON.parse(body) as T
    } catch (err: unknown) {
      throw createTransportCredenceError(
        'sdk_invalid_json',
        'Invalid JSON response',
        response.status,
        { cause: err, rawBody: body },
      )
    }
  }

  private isAbortError(err: unknown): boolean {
    if (err instanceof DOMException && err.name === 'AbortError') return true
    if (err instanceof Error && err.name === 'AbortError') return true
    return false
  }
}

export { CredenceError }
