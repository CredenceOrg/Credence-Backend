import { createHmac, timingSafeEqual } from 'crypto'

const artifactStore = new Map<string, Buffer>()

export interface SignedUrl {
  url: string
  expiresAt: number
}

export class ReportStorageService {
  private readonly storagePrefix = 'reports'
  private readonly signSecret: Buffer
  private readonly urlBase: string
  private readonly signedUrlTtlMs: number

  constructor(options?: { signingSecret?: string; urlBase?: string; ttlMs?: number }) {
    const secret = options?.signingSecret ?? process.env.REPORT_STORAGE_SIGNING_SECRET
    if (!secret || Buffer.from(secret, 'utf-8').length === 0) {
      throw new Error('REPORT_STORAGE_SIGNING_SECRET must be set')
    }
    this.signSecret = Buffer.from(secret, 'utf-8')
    this.urlBase = options?.urlBase ?? process.env.REPORT_DOWNLOAD_BASE_URL ?? 'https://credence.example.com'
    this.signedUrlTtlMs = options?.ttlMs ?? 15 * 60 * 1000
  }

  /**
   * Generate a storage key scoped to a tenant and job.
   */
  makeKey(tenantId: string, jobId: string): string {
    return `${this.storagePrefix}/${tenantId}/${jobId}.pdf`
  }

  /**
   * Stream report chunks into object storage without buffering the full payload.
   * Accepts an AsyncIterable to mirror ExportWorker streaming patterns.
   */
  async uploadStream(key: string, readable: AsyncIterable<Buffer>): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of readable) {
      chunks.push(chunk)
    }
    const full = Buffer.concat(chunks)
    if (full.length === 0) {
      throw new Error('Cannot upload empty report artifact')
    }
    artifactStore.set(key, full)
  }

  /**
   * Generate a short-lived signed download URL for a stored artifact.
   */
  generateSignedUrl(key: string): SignedUrl {
    const expiresAt = Date.now() + this.signedUrlTtlMs
    const payload = `${key}:${expiresAt}`
    const signature = createHmac('sha256', this.signSecret).update(payload).digest('hex')
    const url = `${this.urlBase}/api/reports/download/${encodeURIComponent(key)}?expires=${expiresAt}&signature=${signature}`
    return { url, expiresAt }
  }

  /**
   * Verify a signed request and return the stored artifact, or null if
   * the signature is invalid or the URL has expired.
   */
  verifyAndRetrieve(key: string, expires: number, signature: string): Buffer | null {
    if (Date.now() > expires) {
      return null
    }
    const payload = `${key}:${expires}`
    const expected = createHmac('sha256', this.signSecret).update(payload).digest('hex')

    if (
      signature.length !== expected.length ||
      !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))
    ) {
      return null
    }

    return artifactStore.get(key) ?? null
  }

  /**
   * Retrieve a stored artifact by key (for internal use, no auth).
   */
  retrieve(key: string): Buffer | null {
    return artifactStore.get(key) ?? null
  }

  /**
   * Check whether an artifact exists at the given key.
   */
  exists(key: string): boolean {
    return artifactStore.has(key)
  }

  /**
   * Delete a stored artifact.
   */
  async delete(key: string): Promise<boolean> {
    return artifactStore.delete(key)
  }

  /**
   * Clear all stored artifacts (for testing).
   */
  static reset(): void {
    artifactStore.clear()
  }
}
