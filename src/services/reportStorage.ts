import { createHmac, timingSafeEqual } from 'crypto'
import { ObjectStorageClient, type ObjectStorageConfig } from './objectStorage.js'

const artifactStore = new Map<string, Buffer>()

export interface SignedUrl {
  url: string
  expiresAt: number
}

const STORAGE_BACKEND = (process.env.REPORT_STORAGE_BACKEND ?? 'memory').toLowerCase()

/**
 * Report storage backed by object storage (S3/MinIO) when configured,
 * falling back to the in-memory store for development / testing.
 */
export class ReportStorageService {
  private readonly storagePrefix = 'reports'
  private readonly signSecret: Buffer
  private readonly urlBase: string
  private readonly signedUrlTtlMs: number
  private readonly storageClient: ObjectStorageClient | null

  constructor(options?: {
    signingSecret?: string
    urlBase?: string
    ttlMs?: number
    objectStorage?: ObjectStorageConfig
  }) {
    const secret = options?.signingSecret ?? process.env.REPORT_STORAGE_SIGNING_SECRET
    if (!secret || Buffer.from(secret, 'utf-8').length === 0) {
      throw new Error('REPORT_STORAGE_SIGNING_SECRET must be set')
    }
    this.signSecret = Buffer.from(secret, 'utf-8')
    this.urlBase = options?.urlBase ?? process.env.REPORT_DOWNLOAD_BASE_URL ?? 'https://credence.example.com'
    this.signedUrlTtlMs = options?.ttlMs ?? 15 * 60 * 1000

    this.storageClient = STORAGE_BACKEND === 's3' || STORAGE_BACKEND === 'minio'
      ? new ObjectStorageClient(options?.objectStorage)
      : null
  }

  makeKey(tenantId: string, jobId: string): string {
    return `${this.storagePrefix}/${tenantId}/${jobId}.pdf`
  }

  async uploadStream(key: string, readable: AsyncIterable<Buffer>): Promise<void> {
    if (this.storageClient) {
      await this.storageClient.uploadStream(key, readable)
      return
    }
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

  generateSignedUrl(key: string): SignedUrl {
    if (this.storageClient) {
      return this.storageClient.generateSignedUrl(key)
    }
    const expiresAt = Date.now() + this.signedUrlTtlMs
    const payload = `${key}:${expiresAt}`
    const signature = createHmac('sha256', this.signSecret).update(payload).digest('hex')
    const url = `${this.urlBase}/api/reports/download/${encodeURIComponent(key)}?expires=${expiresAt}&signature=${signature}`
    return { url, expiresAt }
  }

  verifyAndRetrieve(key: string, expires: number, signature: string): Buffer | null {
    if (this.storageClient) {
      throw new Error('Direct retrieval is not supported when using object storage backend — use the signed URL to download')
    }
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

  retrieve(key: string): Buffer | null {
    if (this.storageClient) {
      throw new Error('Direct retrieval is not supported when using object storage backend')
    }
    return artifactStore.get(key) ?? null
  }

  exists(key: string): boolean {
    if (this.storageClient) {
      return false
    }
    return artifactStore.has(key)
  }

  async delete(key: string): Promise<boolean> {
    if (this.storageClient) {
      return this.storageClient.delete(key)
    }
    return artifactStore.delete(key)
  }

  static reset(): void {
    artifactStore.clear()
  }
}
