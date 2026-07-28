import { randomBytes, createHmac } from 'crypto'
import { request } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'

export interface ObjectStorageConfig {
  endpoint: string
  region: string
  bucket: string
  accessKey: string
  secretKey: string
  useSsl: boolean
  signedUrlTtlMs: number
}

export interface SignedUrl {
  url: string
  expiresAt: number
}

const DEFAULT_SIGNED_URL_TTL = 15 * 60 * 1000

export function loadObjectStorageConfig(): ObjectStorageConfig {
  return {
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT ?? 'http://localhost:9000',
    region: process.env.OBJECT_STORAGE_REGION ?? 'us-east-1',
    bucket: process.env.OBJECT_STORAGE_BUCKET ?? 'credence-reports',
    accessKey: process.env.OBJECT_STORAGE_ACCESS_KEY ?? 'minioadmin',
    secretKey: process.env.OBJECT_STORAGE_SECRET_KEY ?? 'minioadmin',
    useSsl: process.env.OBJECT_STORAGE_USE_SSL === 'true',
    signedUrlTtlMs: parseInt(process.env.REPORT_SIGNED_URL_TTL_MS ?? String(DEFAULT_SIGNED_URL_TTL), 10),
  }
}

export class ObjectStorageClient {
  private readonly config: ObjectStorageConfig

  constructor(config?: Partial<ObjectStorageConfig>) {
    this.config = { ...loadObjectStorageConfig(), ...config }
  }

  private get baseUrl(): string {
    const protocol = this.config.useSsl ? 'https' : 'http'
    const ep = this.config.endpoint.replace(/^https?:\/\//, '')
    return `${protocol}://${ep}/${this.config.bucket}`
  }

  async upload(key: string, body: Buffer | Readable): Promise<void> {
    const url = `${this.baseUrl}/${encodeURIComponent(key)}`
    const httpFn = this.config.useSsl ? httpsRequest : request

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      const readable = body instanceof Buffer ? Readable.from(body) : body

      readable.on('data', (chunk: Buffer) => chunks.push(chunk))
      readable.on('end', () => {
        const full = Buffer.concat(chunks)
        const req = httpFn(url, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Length': String(full.length),
            'x-amz-acl': 'private',
          },
        }, (res) => {
          let data = ''
          res.on('data', (chunk: string) => { data += chunk })
          res.on('end', () => {
            if (res.statusCode && res.statusCode < 300) resolve()
            else reject(new Error(`Object storage upload failed: ${res.statusCode} ${data}`))
          })
        })
        req.on('error', reject)
        req.write(full)
        req.end()
      })
      readable.on('error', reject)
    })
  }

  async uploadStream(key: string, readable: AsyncIterable<Buffer>): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of readable) {
      chunks.push(chunk)
    }
    const full = Buffer.concat(chunks)
    if (full.length === 0) {
      throw new Error('Cannot upload empty report artifact')
    }
    await this.upload(key, full)
  }

  async exists(key: string): Promise<boolean> {
    const url = `${this.baseUrl}/${encodeURIComponent(key)}`
    const httpFn = this.config.useSsl ? httpsRequest : request

    return new Promise((resolve) => {
      const req = httpFn(url, { method: 'HEAD' }, (res) => {
        resolve(res.statusCode === 200)
      })
      req.on('error', () => resolve(false))
      req.end()
    })
  }

  async delete(key: string): Promise<boolean> {
    const url = `${this.baseUrl}/${encodeURIComponent(key)}`
    const httpFn = this.config.useSsl ? httpsRequest : request

    return new Promise((resolve) => {
      const req = httpFn(url, { method: 'DELETE' }, (res) => {
        resolve(res.statusCode === 204 || res.statusCode === 200)
      })
      req.on('error', () => resolve(false))
      req.end()
    })
  }

  generateSignedUrl(key: string): SignedUrl {
    const expiresAt = Date.now() + this.config.signedUrlTtlMs
    const payload = `${key}:${expiresAt}`
    const secret = this.config.secretKey.padEnd(32, 'x').slice(0, 32)
    const signature = createHmac('sha256', secret).update(payload).digest('hex')
    const url = `${this.baseUrl}/${encodeURIComponent(key)}?X-Amz-Expires=${Math.floor(this.config.signedUrlTtlMs / 1000)}&X-Amz-Signature=${signature}`
    return { url, expiresAt }
  }
}
